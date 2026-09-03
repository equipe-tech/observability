import type {
  ArgumentsHost,
  DynamicModule,
  ExceptionFilter,
  HttpException,
  Provider,
} from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER, HttpAdapterHost } from "@nestjs/core";
import { Effect, Option, Predicate, Schema } from "effect";
import {
  CorrelationContext,
  unexpectedDefect,
  type DefectEnvelope,
} from "@equipe-tech/observability";
import { requestCorrelation } from "./TelemetryInterceptor.ts";
import type {
  RequestReference,
  RequestWideEventTraceCorrelation,
} from "./RequestWideEventTraceCorrelation.ts";

export type PublicErrorResponse = {
  readonly code: string;
  readonly message: string;
  readonly request_id?: string | undefined;
  readonly trace_id?: string | undefined;
};

export type ExpectedError = {
  readonly kind: "expected";
  readonly source: { readonly kind: "evlog-catalog"; readonly prefix: string };
  readonly error: Error;
  readonly response: { readonly statusCode: number; readonly body: PublicErrorResponse };
};

export type HttpOutcome = {
  readonly kind: "http-outcome";
  readonly source: { readonly kind: "nestjs-http-exception" };
  readonly error: Error;
  readonly response: {
    readonly statusCode: number;
    readonly body: ReturnType<HttpException["getResponse"]>;
  };
};

export type UnexpectedDefect = {
  readonly kind: "unexpected";
  readonly source: { readonly kind: "unclassified-defect" };
  readonly error: Error;
  readonly code: string;
  readonly correlation: CorrelationContext;
};

export type ClassifiedError = ExpectedError | HttpOutcome | UnexpectedDefect;

export type DefectEventInput = {
  readonly kind: "defect";
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly retryable: boolean;
  };
  readonly correlation: CorrelationContext;
};

export type ErrorCatalogReference = {
  readonly _codes: ReadonlyArray<string>;
  readonly _prefix: string;
};

type LiteralMessageCatalog<Catalog extends ErrorCatalogReference> = Catalog & {
  readonly [Entry in Exclude<keyof Catalog, keyof ErrorCatalogReference>]: Catalog[Entry] extends {
    readonly message: string;
  }
    ? Catalog[Entry]
    : never;
};

export type SentryDefectsService = {
  readonly capture: (input: {
    readonly envelope: DefectEnvelope;
  }) => Effect.Effect<{ readonly kind: string }>;
};

export type NestErrorBoundaryOptions<
  Catalog extends ErrorCatalogReference = ErrorCatalogReference,
> = {
  readonly catalog: LiteralMessageCatalog<Catalog>;
  readonly recordDefect: (input: DefectEventInput) => void | Promise<void>;
  readonly sentryDefects?: SentryDefectsService | undefined;
  readonly requestWideEventTraceCorrelation?: RequestWideEventTraceCorrelation | undefined;
};

export class InvalidNestErrorCatalog extends Error {
  readonly _tag = "InvalidNestErrorCatalog";
  readonly code = "OBS_NESTJS_ERROR_CATALOG_PREFIX_INVALID";
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      "The NestJS error catalog prefix is invalid. Provide a stable application prefix that does not use the reserved OBS_ package namespace.",
      { cause },
    );
    this.name = "InvalidNestErrorCatalog";
    this.cause = cause;
  }
}

export class InvalidNestErrorCatalogDeclaration extends Error {
  readonly _tag = "InvalidNestErrorCatalogDeclaration";
  readonly code = "OBS_NESTJS_ERROR_CATALOG_INVALID";
  readonly catalogCode: string;
  override readonly cause: unknown;

  constructor(
    catalogCode: string,
    cause: unknown,
    reason: "declaration" | "non-catalog" | "templated-message" = "declaration",
  ) {
    const message =
      reason === "non-catalog"
        ? "The NestJS error catalog is not a catalog created by defineErrorCatalog. Rebuild the catalog with defineErrorCatalog and restart the service."
        : reason === "templated-message"
          ? `The NestJS error catalog declaration "${catalogCode}" is invalid. Templated messages are unsupported because the public message must come from the declaration.`
          : `The NestJS error catalog declaration "${catalogCode}" is invalid. Rebuild the catalog with defineErrorCatalog and restart the service.`;
    super(message, { cause });
    this.name = "InvalidNestErrorCatalogDeclaration";
    this.catalogCode = catalogCode;
    this.cause = cause;
  }
}

const CatalogPrefix = Schema.NonEmptyString.check(
  Schema.makeFilter((prefix) => !/^OBS_/i.test(prefix)),
);
const decodeCatalogPrefix = Schema.decodeUnknownSync(CatalogPrefix);
const CatalogStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));
const CatalogEntryIdentity = Schema.Struct({
  code: Schema.NonEmptyString,
  status: CatalogStatus,
});
const decodeCatalogEntryIdentity = Schema.decodeUnknownOption(CatalogEntryIdentity);
const CatalogCodes = Schema.Array(Schema.NonEmptyString);
const decodeCatalogCodes = Schema.decodeUnknownOption(CatalogCodes);
const ExpectedErrorDetails = Schema.Struct({ code: Schema.NonEmptyString });
const decodeExpectedErrorDetails = Schema.decodeUnknownOption(ExpectedErrorDetails);
const ErrorCode = Schema.Struct({ code: Schema.NonEmptyString });
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode);
const decodeRetryable = Schema.decodeUnknownOption(Schema.Boolean);
const capturedErrorsByRequest = new WeakMap<RequestReference, WeakSet<Error>>();

type CatalogEntry = {
  readonly code: string;
  readonly message: string;
  readonly status: number;
};
type ClassificationRule = (
  error: Error,
  correlation: CorrelationContext,
) => Option.Option<ClassifiedError>;

const catalogEntries = (catalog: ErrorCatalogReference): ReadonlyArray<CatalogEntry> => {
  const prefixDescriptor = Object.getOwnPropertyDescriptor(catalog, "_prefix");
  const codesDescriptor = Object.getOwnPropertyDescriptor(catalog, "_codes");
  if (prefixDescriptor?.enumerable !== false || codesDescriptor?.enumerable !== false) {
    throw new InvalidNestErrorCatalogDeclaration(`${catalog._prefix}.*`, catalog, "non-catalog");
  }
  const decodedCodes = decodeCatalogCodes(catalog._codes);
  if (Option.isNone(decodedCodes)) {
    throw new InvalidNestErrorCatalogDeclaration(`${catalog._prefix}.*`, catalog._codes);
  }
  const declarations: Array<CatalogEntry> = [];
  for (const [entryName, factory] of Object.entries(catalog)) {
    const expectedCode = `${catalog._prefix}.${entryName}`;
    if (!Predicate.isFunction(factory)) {
      throw new InvalidNestErrorCatalogDeclaration(expectedCode, factory);
    }
    const identity = decodeCatalogEntryIdentity({
      code: Object.getOwnPropertyDescriptor(factory, "code")?.value,
      status: Object.getOwnPropertyDescriptor(factory, "status")?.value,
    });
    const message = Object.getOwnPropertyDescriptor(factory, "message")?.value;
    if (Option.isNone(identity) || !Predicate.isString(message)) {
      throw new InvalidNestErrorCatalogDeclaration(
        expectedCode,
        factory,
        Predicate.isFunction(message) ? "templated-message" : "declaration",
      );
    }
    declarations.push({ ...identity.value, message });
  }
  const declaredCodes = new Set(declarations.map((entry) => entry.code));
  const catalogCodes = new Set(decodedCodes.value);
  for (const code of catalogCodes) {
    if (!declaredCodes.has(code)) {
      throw new InvalidNestErrorCatalogDeclaration(code, catalog);
    }
  }
  for (const code of declaredCodes) {
    if (!catalogCodes.has(code)) {
      throw new InvalidNestErrorCatalogDeclaration(code, catalog);
    }
  }
  return declarations;
};

type HttpExceptionDetails = {
  readonly error: Error;
  readonly statusCode: number;
  readonly body: ReturnType<HttpException["getResponse"]>;
};

const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }));
const decodeHttpStatus = Schema.decodeUnknownOption(HttpStatus);

const httpExceptionDetails = (error: Error): Option.Option<HttpExceptionDetails> => {
  try {
    if (
      !Predicate.hasProperty(error, "getStatus") ||
      !Predicate.isFunction(error.getStatus) ||
      !Predicate.hasProperty(error, "getResponse") ||
      !Predicate.isFunction(error.getResponse)
    ) {
      return Option.none();
    }
    const statusCode = decodeHttpStatus(error.getStatus());
    if (Option.isNone(statusCode)) return Option.none();
    return Option.some({
      error,
      statusCode: statusCode.value,
      body: error.getResponse(),
    });
  } catch {
    return Option.none();
  }
};

const publicResponse = (
  details: { readonly code: string; readonly message: string },
  correlation: CorrelationContext,
): PublicErrorResponse => {
  const body: {
    code: string;
    message: string;
    request_id?: string;
    trace_id?: string;
  } = { code: details.code, message: details.message };
  if (Option.isSome(correlation.requestId)) body.request_id = correlation.requestId.value;
  if (Option.isSome(correlation.traceId)) body.trace_id = correlation.traceId.value;
  return body;
};

const requestCaptureMarker = (request: RequestReference): WeakSet<Error> => {
  const existing = capturedErrorsByRequest.get(request);
  if (existing !== undefined) return existing;
  const marker = new WeakSet<Error>();
  capturedErrorsByRequest.set(request, marker);
  return marker;
};

export class NestErrorBoundary {
  readonly #prefix: string;
  readonly #catalogEntries: ReadonlyMap<string, CatalogEntry>;
  readonly #recordDefect: NestErrorBoundaryOptions["recordDefect"];
  readonly #sentryDefects: NestErrorBoundaryOptions["sentryDefects"];
  readonly #requestWideEventTraceCorrelation: RequestWideEventTraceCorrelation | undefined;
  readonly #classificationTable: ReadonlyArray<ClassificationRule>;

  constructor(options: NestErrorBoundaryOptions) {
    try {
      this.#prefix = decodeCatalogPrefix(options.catalog._prefix);
    } catch (cause) {
      throw new InvalidNestErrorCatalog(cause);
    }
    this.#catalogEntries = new Map(
      catalogEntries(options.catalog).map((entry) => [entry.code, entry]),
    );
    this.#recordDefect = options.recordDefect;
    this.#sentryDefects = options.sentryDefects;
    this.#requestWideEventTraceCorrelation = options.requestWideEventTraceCorrelation;
    this.#classificationTable = [
      (error, correlation) => this.#classifyExpected(error, correlation),
      (error, correlation) => this.#classifyCausedServerDefect(error, correlation),
      (error) => this.#classifyHttpOutcome(error),
    ];
  }

  #classifyExpected(error: Error, correlation: CorrelationContext): Option.Option<ExpectedError> {
    const details = decodeExpectedErrorDetails(error);
    if (Option.isNone(details) || !details.value.code.startsWith(`${this.#prefix}.`)) {
      return Option.none();
    }
    const declaration = this.#catalogEntries.get(details.value.code);
    if (declaration === undefined) return Option.none();
    return Option.some({
      kind: "expected",
      source: { kind: "evlog-catalog", prefix: this.#prefix },
      error,
      response: {
        statusCode: declaration.status,
        body: publicResponse({ code: declaration.code, message: declaration.message }, correlation),
      },
    });
  }

  #classifyCausedServerDefect(
    error: Error,
    correlation: CorrelationContext,
  ): Option.Option<UnexpectedDefect> {
    const details = httpExceptionDetails(error);
    if (Option.isNone(details)) return Option.none();
    const isServerError = details.value.statusCode >= 500;
    const causeIsHttpException =
      error.cause instanceof Error && Option.isSome(httpExceptionDetails(error.cause));
    if (!isServerError || error.cause === undefined || causeIsHttpException) return Option.none();
    return Option.some(this.#classifyUnexpected(error, correlation));
  }

  #classifyHttpOutcome(error: Error): Option.Option<HttpOutcome> {
    const details = httpExceptionDetails(error);
    if (Option.isNone(details)) return Option.none();
    return Option.some({
      kind: "http-outcome",
      source: { kind: "nestjs-http-exception" },
      error: details.value.error,
      response: { statusCode: details.value.statusCode, body: details.value.body },
    });
  }

  #classifyUnexpected(error: Error, correlation: CorrelationContext): UnexpectedDefect {
    const parsedCode = decodeErrorCode(error);
    return {
      kind: "unexpected",
      source: { kind: "unclassified-defect" },
      error,
      code: Option.match(parsedCode, {
        onNone: () => "OBS_NESTJS_UNEXPECTED_DEFECT",
        onSome: ({ code }) => code,
      }),
      correlation,
    };
  }

  classify(error: Error, correlation: CorrelationContext): ClassifiedError {
    for (const classify of this.#classificationTable) {
      const classified = classify(error, correlation);
      if (Option.isSome(classified)) return classified.value;
    }
    return this.#classifyUnexpected(error, correlation);
  }

  handle(classified: ClassifiedError, request: RequestReference): Promise<void> {
    if (classified.kind !== "unexpected") {
      this.#requestWideEventTraceCorrelation?.recordError(request, classified.error);
      return Promise.resolve();
    }
    const capturedErrors = requestCaptureMarker(request);
    if (capturedErrors.has(classified.error)) return Promise.resolve();
    capturedErrors.add(classified.error);
    this.#requestWideEventTraceCorrelation?.recordError(request, classified.error);

    const envelope = unexpectedDefect({
      error: classified.error,
      code: classified.code,
      correlation: classified.correlation,
    });
    const retryable = decodeRetryable(
      Object.getOwnPropertyDescriptor(classified.error, "retryable")?.value,
    );
    const eventError = {
      type: classified.code,
      message: classified.error.message,
      retryable: Option.getOrElse(retryable, () => false),
    };
    const settlements: Array<Promise<void | { readonly kind: string }>> = [
      Promise.resolve().then(() =>
        this.#recordDefect({
          kind: "defect",
          error: eventError,
          correlation: classified.correlation,
        }),
      ),
    ];
    const sentryDefects = this.#sentryDefects;
    if (sentryDefects !== undefined) {
      settlements.push(
        Promise.resolve().then(() => Effect.runPromise(sentryDefects.capture({ envelope }))),
      );
    }
    return Promise.allSettled(settlements).then(() => undefined);
  }
}

export class NestErrorFilter implements ExceptionFilter {
  readonly #boundary: NestErrorBoundary;
  readonly #httpAdapterHost: HttpAdapterHost;

  constructor(boundary: NestErrorBoundary, httpAdapterHost: HttpAdapterHost) {
    this.#boundary = boundary;
    this.#httpAdapterHost = httpAdapterHost;
  }

  catch(cause: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestReference>();
    const response = http.getResponse<RequestReference>();
    const error =
      cause instanceof Error
        ? cause
        : new Error("An unexpected non-error defect occurred.", { cause });
    const correlation = Option.getOrElse(
      requestCorrelation(request),
      () => new CorrelationContext({}),
    );
    const classified = this.#boundary.classify(error, correlation);
    this.#boundary.handle(classified, request).catch(() => undefined);

    const applicationRef = this.#httpAdapterHost.httpAdapter;
    if (applicationRef.isHeadersSent(response)) {
      applicationRef.end(response);
      return;
    }
    switch (classified.kind) {
      case "expected":
        applicationRef.reply(response, classified.response.body, classified.response.statusCode);
        return;
      case "http-outcome":
        applicationRef.reply(response, classified.response.body, classified.response.statusCode);
        return;
      case "unexpected":
        applicationRef.reply(
          response,
          publicResponse(
            {
              code: "OBS_NESTJS_UNEXPECTED_DEFECT",
              message:
                "The request failed unexpectedly. Contact support with the correlation identifier.",
            },
            correlation,
          ),
          500,
        );
    }
  }
}

const NEST_ERROR_BOUNDARY = Symbol("NestErrorBoundary");

export class NestErrorBoundaryModule {
  static forRoot<Catalog extends ErrorCatalogReference>(
    options: NestErrorBoundaryOptions<Catalog>,
  ): DynamicModule {
    const boundary = new NestErrorBoundary(options);
    const providers: Array<Provider> = [
      { provide: NEST_ERROR_BOUNDARY, useValue: boundary },
      {
        provide: APP_FILTER,
        inject: [NEST_ERROR_BOUNDARY, HttpAdapterHost],
        useFactory: (configured: NestErrorBoundary, httpAdapterHost: HttpAdapterHost) =>
          new NestErrorFilter(configured, httpAdapterHost),
      },
    ];
    return { module: NestErrorBoundaryModule, providers };
  }
}

Module({})(NestErrorBoundaryModule);
