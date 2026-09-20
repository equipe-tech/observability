import { Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { Contract, TelemetryEventSink } from "@equipe-tech/observability";
import { ingestBrowserEvents, InvalidBrowserEventBatch } from "@equipe-tech/observability/node";

export const defaultBrowserEventsPath = "/_telemetry/events";

export class BrowserEventsRejection extends Schema.Class<BrowserEventsRejection>(
  "@equipe-tech/observability-effect/BrowserEventsRejection",
)({
  code: Schema.Union([
    Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
    Contract.TelemetryEventErrorCode,
  ]),
  message: Schema.String,
  correlationId: Schema.String,
}) {}

const BrowserEventsPath = Schema.String.check(
  Schema.isPattern(/^\/[A-Za-z0-9._~/-]*$/),
  Schema.makeFilter((path) => !path.includes("//"), {
    expected: "an absolute path without empty segments",
  }),
);
const decodeBrowserEventsPath = Schema.decodeUnknownOption(BrowserEventsPath);

export class InvalidBrowserEventsPath extends Schema.TaggedError<InvalidBrowserEventsPath>()(
  "InvalidBrowserEventsPath",
  {
    code: Schema.Literal("OBS_EFFECT_BROWSER_EVENTS_PATH_INVALID"),
    message: Schema.String,
    path: Schema.String,
  },
) {}

export type BrowserEventsRouteOptions = {
  readonly path?: string | undefined;
};

const correlationId = Effect.map(Effect.currentParentSpan, (span) => span.traceId).pipe(
  Effect.orElseSucceed(() => crypto.randomUUID()),
);

const rejection = (
  error: InvalidBrowserEventBatch | Contract.InvalidTelemetryEvent,
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  Effect.map(correlationId, (id) =>
    HttpServerResponse.jsonUnsafe(
      new BrowserEventsRejection({ code: error.code, message: error.message, correlationId: id }),
      { status: 400 },
    ),
  );

export const browserEventsHandler: Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  never,
  HttpServerRequest.HttpServerRequest | TelemetryEventSink
> = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const body = yield* request.json.pipe(Effect.option);
  return yield* ingestBrowserEvents(Option.getOrUndefined(body)).pipe(
    Effect.map((receipt) => HttpServerResponse.jsonUnsafe(receipt, { status: 202 })),
    Effect.catch((error) =>
      error instanceof InvalidBrowserEventBatch || error instanceof Contract.InvalidTelemetryEvent
        ? rejection(error)
        : Effect.die(error),
    ),
  );
});

const parseBrowserEventsPath = (
  path: string | undefined,
): Effect.Effect<`/${string}`, InvalidBrowserEventsPath> =>
  decodeBrowserEventsPath(path ?? defaultBrowserEventsPath).pipe(
    Option.match({
      onNone: () =>
        Effect.fail(
          new InvalidBrowserEventsPath({
            code: "OBS_EFFECT_BROWSER_EVENTS_PATH_INVALID",
            message:
              "The browser events path must be an absolute path without empty segments. Fix the path before starting the server.",
            path: String(path),
          }),
        ),
      onSome: (value) => Effect.succeed(`/${value.slice(1)}` as const),
    }),
  );

export const layerBrowserEventsRoute = (options: BrowserEventsRouteOptions = {}) =>
  HttpRouter.use((router) =>
    Effect.flatMap(parseBrowserEventsPath(options.path), (path) =>
      router.add("POST", path, browserEventsHandler),
    ),
  );
