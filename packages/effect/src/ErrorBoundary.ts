import { Cause, Context, Effect, Option, Schema, Scope } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import {
  CorrelationContext,
  CurrentCorrelation,
  unexpectedDefect,
  type DefectEnvelope,
} from "@equipe-tech/observability";
import type { ErrorCatalog, ErrorCatalogEntry } from "./ErrorCatalog.ts";

export const unexpectedDefectCode = "OBS_EFFECT_UNEXPECTED_DEFECT";

export type PublicErrorResponse = {
  readonly code: string;
  readonly message: string;
  readonly request_id?: string | undefined;
  readonly trace_id?: string | undefined;
};

export type ExpectedError = {
  readonly kind: "expected";
  readonly source: { readonly kind: "error-catalog"; readonly prefix: string };
  readonly error: Error;
  readonly response: { readonly statusCode: number; readonly body: PublicErrorResponse };
};

export type HttpOutcome = {
  readonly kind: "http-outcome";
  readonly source: { readonly kind: "http-respondable" };
  readonly error: Error;
  readonly response: HttpServerResponse.HttpServerResponse;
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

export type DefectCaptureInput = {
  readonly envelope: DefectEnvelope;
};

export type ErrorBoundaryOptions<R> = {
  readonly catalog: ErrorCatalog;
  readonly recordDefect: (input: DefectEventInput) => Effect.Effect<unknown, unknown, R>;
  readonly captureDefect?:
    | ((input: DefectCaptureInput) => Effect.Effect<unknown, unknown, R>)
    | undefined;
};

const ErrorCode = Schema.Struct({ code: Schema.NonEmptyString });
const decodeErrorCode = Schema.decodeUnknownOption(ErrorCode);
const decodeRetryable = Schema.decodeUnknownOption(Schema.Boolean);
const unclassifiedResponse = HttpServerResponse.empty({ status: 500 });
const capturedDefectsByRequest = new WeakMap<object, WeakSet<Error>>();

const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error("An unexpected non-error defect occurred.", { cause });

const causeOf = (error: Error): unknown => {
  try {
    return error.cause;
  } catch {
    return undefined;
  }
};

const primaryReason = (cause: Cause.Cause<unknown>): Option.Option<unknown> => {
  for (const reason of cause.reasons) {
    if (reason._tag === "Fail") return Option.some(reason.error);
  }
  for (const reason of cause.reasons) {
    if (reason._tag === "Die") return Option.some(reason.defect);
  }
  return Option.none();
};

export const publicErrorResponse = (
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

const respondableResponse = (
  cause: unknown,
): Effect.Effect<Option.Option<HttpServerResponse.HttpServerResponse>> =>
  Effect.map(HttpServerRespondable.toResponseOrElse(cause, unclassifiedResponse), (response) =>
    response === unclassifiedResponse ? Option.none() : Option.some(response),
  );

const classifyExpected = (
  catalog: ErrorCatalog,
  cause: unknown,
  correlation: CorrelationContext,
): Option.Option<ExpectedError> =>
  decodeErrorCode(cause).pipe(
    Option.filter(({ code }) => code.startsWith(`${catalog.prefix}.`)),
    Option.flatMap(({ code }) => catalog.lookup(code)),
    Option.map((entry: ErrorCatalogEntry): ExpectedError => ({
      kind: "expected",
      source: { kind: "error-catalog", prefix: catalog.prefix },
      error: toError(cause),
      response: {
        statusCode: entry.status,
        body: publicErrorResponse({ code: entry.code, message: entry.message }, correlation),
      },
    })),
  );

const classifyUnexpected = (cause: unknown, correlation: CorrelationContext): UnexpectedDefect => {
  const error = toError(cause);
  return {
    kind: "unexpected",
    source: { kind: "unclassified-defect" },
    error,
    code: Option.match(decodeErrorCode(error), {
      onNone: () => unexpectedDefectCode,
      onSome: ({ code }) => code,
    }),
    correlation,
  };
};

export const classifyError = Effect.fnUntraced(function* (
  catalog: ErrorCatalog,
  cause: unknown,
  correlation: CorrelationContext,
): Effect.fn.Return<ClassifiedError> {
  const expected = classifyExpected(catalog, cause, correlation);
  if (Option.isSome(expected)) return expected.value;
  const response = yield* respondableResponse(cause);
  if (Option.isNone(response)) return classifyUnexpected(cause, correlation);
  if (response.value.status >= 500 && cause instanceof Error) {
    const nested = causeOf(cause);
    const nestedResponse =
      nested === undefined ? Option.none() : yield* respondableResponse(nested);
    if (nested !== undefined && Option.isNone(nestedResponse)) {
      return classifyUnexpected(cause, correlation);
    }
  }
  return {
    kind: "http-outcome",
    source: { kind: "http-respondable" },
    error: toError(cause),
    response: response.value,
  };
});

const requestCaptureMarker = (request: HttpServerRequest.HttpServerRequest): WeakSet<Error> => {
  const existing = capturedDefectsByRequest.get(request.source);
  if (existing !== undefined) return existing;
  const marker = new WeakSet<Error>();
  capturedDefectsByRequest.set(request.source, marker);
  return marker;
};

const defectSettlement = <R>(
  options: ErrorBoundaryOptions<R>,
  defect: UnexpectedDefect,
): Effect.Effect<void, never, R> => {
  const retryable = decodeRetryable(
    Object.getOwnPropertyDescriptor(defect.error, "retryable")?.value,
  );
  const record = options
    .recordDefect({
      kind: "defect",
      error: {
        type: defect.code,
        message: defect.error.message,
        retryable: Option.getOrElse(retryable, () => false),
      },
      correlation: defect.correlation,
    })
    .pipe(Effect.ignore);
  const capture = options.captureDefect;
  if (capture === undefined) return record;
  const envelope = unexpectedDefect({
    error: defect.error,
    code: defect.code,
    correlation: defect.correlation,
  });
  return Effect.zip(record, capture({ envelope }).pipe(Effect.ignore), { concurrent: true }).pipe(
    Effect.asVoid,
  );
};

const unexpectedResponse = (
  correlation: CorrelationContext,
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.jsonUnsafe(
    publicErrorResponse(
      {
        code: unexpectedDefectCode,
        message:
          "The request failed unexpectedly. Contact support with the correlation identifier.",
      },
      correlation,
    ),
    { status: 500 },
  );

type Settlement<R> = {
  readonly scope: Scope.Scope;
  readonly services: Context.Context<R>;
};

const handleCause = Effect.fnUntraced(function* <R>(
  options: ErrorBoundaryOptions<R>,
  settlement: Settlement<R>,
  cause: Cause.Cause<unknown>,
): Effect.fn.Return<
  HttpServerResponse.HttpServerResponse,
  unknown,
  HttpServerRequest.HttpServerRequest
> {
  const reason = primaryReason(cause);
  if (Option.isNone(reason)) {
    return yield* Effect.failCause(cause);
  }
  const correlation = yield* CurrentCorrelation;
  const classified = yield* classifyError(options.catalog, reason.value, correlation);
  switch (classified.kind) {
    case "expected":
      return HttpServerResponse.jsonUnsafe(classified.response.body, {
        status: classified.response.statusCode,
      });
    case "http-outcome":
      return classified.response;
    case "unexpected": {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const marker = requestCaptureMarker(request);
      if (!marker.has(classified.error)) {
        marker.add(classified.error);
        yield* Effect.forkIn(
          defectSettlement(options, classified).pipe(Effect.provide(settlement.services)),
          settlement.scope,
        );
      }
      return unexpectedResponse(correlation);
    }
  }
});

export const errorBoundary = <R = never>(options: ErrorBoundaryOptions<R>) =>
  HttpRouter.middleware(
    Effect.gen(function* () {
      const services = yield* Effect.context<R>();
      const settlement: Settlement<R> = { scope: yield* Effect.scope, services };
      return <E, RA>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, RA>) =>
        app.pipe(Effect.catchCause((cause) => handleCause(options, settlement, cause)));
    }),
  );

export type ErrorBoundaryMiddleware<R = never> = ReturnType<typeof errorBoundary<R>>;
