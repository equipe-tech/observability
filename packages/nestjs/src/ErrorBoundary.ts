import type { ArgumentsHost, DynamicModule, ExceptionFilter, Provider } from "@nestjs/common";
import { Module } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Effect, Option, Schema } from "effect";
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

export type UnexpectedDefect = {
  readonly kind: "unexpected";
  readonly source: { readonly kind: "evlog-catalog"; readonly prefix: string };
  readonly error: Error;
  readonly code: string;
  readonly correlation: CorrelationContext;
};

export type ClassifiedError = ExpectedError | UnexpectedDefect;

export type DefectEventInput = {
  readonly kind: "defect";
  readonly error: {
    readonly type: string;
    readonly message: string;
    readonly retryable: false;
  };
  readonly correlation: CorrelationContext;
};

export type ErrorCatalogReference = {
  readonly _prefix: string;
};

export type SentryDefectsService = {
  readonly capture: (input: {
    readonly envelope: DefectEnvelope;
  }) => Effect.Effect<{ readonly kind: string }>;
};

export type NestErrorBoundaryOptions = {
  readonly catalog: ErrorCatalogReference;
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

const CatalogPrefix = Schema.NonEmptyString.check(
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/),
  Schema.makeFilter((prefix) => !prefix.startsWith("OBS_")),
);
const decodeCatalogPrefix = Schema.decodeUnknownSync(CatalogPrefix);
const ExpectedErrorDetails = Schema.Struct({
  code: Schema.NonEmptyString,
  message: Schema.String,
  status: Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 })),
});
const decodeExpectedErrorDetails = Schema.decodeUnknownOption(ExpectedErrorDetails);
const ErrorCode = Schema.Struct({ code: Schema.NonEmptyString });
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode);
const capturedErrors = new WeakSet<Error>();

interface HttpResponseReference {
  readonly headersSent: boolean;
  status(statusCode: number): HttpResponseReference;
  json(body: PublicErrorResponse): void;
}

const publicResponse = (
  details: typeof ExpectedErrorDetails.Type,
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

export class NestErrorBoundary {
  readonly #prefix: string;
  readonly #recordDefect: NestErrorBoundaryOptions["recordDefect"];
  readonly #sentryDefects: NestErrorBoundaryOptions["sentryDefects"];
  readonly #requestWideEventTraceCorrelation: RequestWideEventTraceCorrelation | undefined;

  constructor(options: NestErrorBoundaryOptions) {
    try {
      this.#prefix = decodeCatalogPrefix(options.catalog._prefix);
    } catch (cause) {
      throw new InvalidNestErrorCatalog(cause);
    }
    this.#recordDefect = options.recordDefect;
    this.#sentryDefects = options.sentryDefects;
    this.#requestWideEventTraceCorrelation = options.requestWideEventTraceCorrelation;
  }

  classify(error: Error, correlation: CorrelationContext): ClassifiedError {
    const details = decodeExpectedErrorDetails(error);
    if (Option.isSome(details) && details.value.code.startsWith(`${this.#prefix}.`)) {
      return {
        kind: "expected",
        source: { kind: "evlog-catalog", prefix: this.#prefix },
        error,
        response: {
          statusCode: details.value.status,
          body: publicResponse(details.value, correlation),
        },
      };
    }
    const parsedCode = decodeErrorCode(error);
    return {
      kind: "unexpected",
      source: { kind: "evlog-catalog", prefix: this.#prefix },
      error,
      code: Option.match(parsedCode, {
        onNone: () => "OBS_NESTJS_UNEXPECTED_DEFECT",
        onSome: ({ code }) => code,
      }),
      correlation,
    };
  }

  async handle(classified: ClassifiedError, request: RequestReference): Promise<void> {
    this.#requestWideEventTraceCorrelation?.recordError(request, classified.error);
    if (classified.kind === "expected" || capturedErrors.has(classified.error)) {
      return;
    }
    capturedErrors.add(classified.error);
    const envelope = unexpectedDefect({
      error: classified.error,
      code: classified.code,
      correlation: classified.correlation,
    });
    const record = Promise.resolve(
      this.#recordDefect({
        kind: "defect",
        error: {
          type: classified.code,
          message: classified.error.message,
          retryable: false,
        },
        correlation: classified.correlation,
      }),
    );
    if (this.#sentryDefects === undefined) {
      await Promise.allSettled([record]);
      return;
    }
    await Promise.allSettled([
      record,
      Effect.runPromise(this.#sentryDefects.capture({ envelope })),
    ]);
  }
}

export class NestErrorFilter implements ExceptionFilter {
  readonly #boundary: NestErrorBoundary;

  constructor(boundary: NestErrorBoundary) {
    this.#boundary = boundary;
  }

  async catch(cause: unknown, host: ArgumentsHost): Promise<void> {
    const http = host.switchToHttp();
    const request = http.getRequest<RequestReference>();
    const response = http.getResponse<HttpResponseReference>();
    const error =
      cause instanceof Error ? cause : new Error("An unexpected non-error defect occurred.");
    const correlation = Option.getOrElse(
      requestCorrelation(request),
      () => new CorrelationContext({}),
    );
    const classified = this.#boundary.classify(error, correlation);
    await this.#boundary.handle(classified, request);
    if (response.headersSent) {
      return;
    }
    if (classified.kind === "expected") {
      response.status(classified.response.statusCode).json(classified.response.body);
      return;
    }
    const body = publicResponse(
      {
        code: "OBS_NESTJS_UNEXPECTED_DEFECT",
        message:
          "The request failed unexpectedly. Contact support with the correlation identifier.",
        status: 500,
      },
      correlation,
    );
    response.status(500).json(body);
  }
}

const NEST_ERROR_BOUNDARY = Symbol("NestErrorBoundary");

export class NestErrorBoundaryModule {
  static forRoot(options: NestErrorBoundaryOptions): DynamicModule {
    const boundary = new NestErrorBoundary(options);
    const providers: Array<Provider> = [
      { provide: NEST_ERROR_BOUNDARY, useValue: boundary },
      {
        provide: APP_FILTER,
        inject: [NEST_ERROR_BOUNDARY],
        useFactory: (configured: NestErrorBoundary) => new NestErrorFilter(configured),
      },
    ];
    return { module: NestErrorBoundaryModule, providers };
  }
}

Module({})(NestErrorBoundaryModule);
