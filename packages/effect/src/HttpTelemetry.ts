import { Cause, Clock, Effect, Exit, Layer, Option, Schema, Tracer } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerError,
  HttpServerRequest,
  type HttpServerResponse,
} from "effect/unstable/http";
import {
  CorrelationContext,
  parseRequestId,
  parseSpanId,
  parseTraceId,
  withCorrelation,
} from "@equipe-tech/observability";
import {
  telemetryRoutePolicy,
  type InvalidTelemetryRoutePolicy,
  type TelemetryRoutePolicy,
  type TelemetryRoutePolicyOptions,
} from "./HttpRoutePolicy.ts";

const Traceparent = Schema.String.check(
  Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
  Schema.makeFilter(
    (traceparent) =>
      traceparent.slice(3, 35) !== "00000000000000000000000000000000" &&
      traceparent.slice(36, 52) !== "0000000000000000",
    { expected: "a traceparent with non-zero trace and span identifiers" },
  ),
);
const decodeTraceparent = Schema.decodeUnknownOption(Traceparent);

export type HttpTelemetryOptions = TelemetryRoutePolicyOptions;

type SpanOutcome = {
  readonly status: Option.Option<number>;
  readonly errorType: Option.Option<string>;
  readonly exit: Exit.Exit<unknown, unknown>;
};

const statusErrorType = (status: number): Option.Option<string> =>
  status >= 500 ? Option.some(String(status)) : Option.none();

const isClientAbort = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      reason._tag === "Interrupt" && reason.annotations.has(HttpServerError.ClientAbort.key),
  );

const outcomeOf = (
  exit: Exit.Exit<HttpServerResponse.HttpServerResponse, unknown>,
): Effect.Effect<SpanOutcome> => {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed({
      status: Option.some(exit.value.status),
      errorType: statusErrorType(exit.value.status),
      exit: Exit.void,
    });
  }
  const cause = exit.cause;
  if (Cause.hasInterruptsOnly(cause)) {
    return Effect.succeed({
      status: Option.none(),
      errorType: isClientAbort(cause) ? Option.some("connection_closed") : Option.none(),
      exit,
    });
  }
  return Effect.map(HttpServerError.causeResponse(cause), ([response]) => ({
    status: Option.some(response.status),
    errorType: statusErrorType(response.status),
    exit,
  }));
};

const parentSpan = (
  request: HttpServerRequest.HttpServerRequest,
): Option.Option<Tracer.ExternalSpan> =>
  decodeTraceparent(request.headers["traceparent"]).pipe(
    Option.map((traceparent) =>
      Tracer.externalSpan({
        traceId: traceparent.slice(3, 35),
        spanId: traceparent.slice(36, 52),
        sampled: Number.parseInt(traceparent.slice(53, 55), 16) % 2 === 1,
      }),
    ),
  );

const routeTemplate = Effect.map(Effect.serviceOption(HttpRouter.RouteContext), (context) =>
  Option.map(context, (value) => value.route.path),
);

const instrument = Effect.fnUntraced(function* <E, R>(
  policy: TelemetryRoutePolicy,
  app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const details = policy.inspect(request, yield* routeTemplate);
  if (Option.isNone(details)) {
    return yield* app;
  }
  const parent = parentSpan(request);
  const span = yield* Effect.makeSpan(details.value.spanName, {
    parent: Option.getOrUndefined(parent),
    root: Option.isNone(parent),
    kind: "server",
    sampled: Option.match(parent, {
      onNone: () => true,
      onSome: (remoteParent) => remoteParent.sampled,
    }),
  });
  span.attribute("http.request.method", details.value.method);
  if (Option.isSome(details.value.methodOriginal)) {
    span.attribute("http.request.method_original", details.value.methodOriginal.value);
  }
  if (Option.isSome(details.value.route)) {
    span.attribute("http.route", details.value.route.value);
  }
  if (Option.isSome(details.value.urlPath)) {
    span.attribute("url.path", details.value.urlPath.value);
  }
  if (Option.isSome(details.value.urlScheme)) {
    span.attribute("url.scheme", details.value.urlScheme.value);
  }
  if (Option.isSome(details.value.clientAddress)) {
    span.attribute("client.address", details.value.clientAddress.value);
  }
  if (Option.isSome(details.value.networkPeerAddress)) {
    span.attribute("network.peer.address", details.value.networkPeerAddress.value);
  }
  if (Option.isSome(details.value.networkPeerPort)) {
    span.attribute("network.peer.port", details.value.networkPeerPort.value);
  }
  if (Option.isSome(details.value.serverAddress)) {
    span.attribute("server.address", details.value.serverAddress.value);
  }
  const requestId = yield* parseRequestId(crypto.randomUUID()).pipe(Effect.orDie);
  const traceId = yield* parseTraceId(span.traceId).pipe(Effect.orDie);
  const spanId = yield* parseSpanId(span.spanId).pipe(Effect.orDie);
  const correlation = new CorrelationContext({
    trace: { _tag: "Traced", traceId, spanId },
    requestId: Option.some(requestId),
  });
  return yield* app.pipe(
    Effect.withParentSpan(span),
    withCorrelation(correlation),
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const outcome = yield* outcomeOf(exit);
        if (Option.isSome(outcome.status)) {
          span.attribute("http.response.status_code", outcome.status.value);
        }
        if (Option.isSome(outcome.errorType)) {
          span.attribute("error.type", outcome.errorType.value);
        }
        span.end(yield* Clock.currentTimeNanos, outcome.exit);
      }),
    ),
  );
});

export const layerBuiltInTracerDisabled: Layer.Layer<never> = Layer.succeed(
  HttpMiddleware.TracerDisabledWhen,
)(() => true);

export const httpTelemetry = (options: HttpTelemetryOptions = {}) =>
  HttpRouter.middleware(
    Effect.map(
      telemetryRoutePolicy(options),
      (policy) =>
        <E, R>(app: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
          instrument(policy, app),
    ),
  );

export type HttpTelemetryMiddleware = ReturnType<typeof httpTelemetry>;
export type { InvalidTelemetryRoutePolicy };
