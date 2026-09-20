import { assert, describe, it } from "@effect/vitest";
import { NodeHttpServer } from "@effect/platform-node";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  HttpClient,
  HttpRouter,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";
import { HttpApiError } from "effect/unstable/httpapi";
import {
  CorrelationContext,
  observabilityProfiles,
  type DefectEnvelope,
} from "@equipe-tech/observability";
import * as Testing from "@equipe-tech/observability/testing";
import {
  classifyError,
  defineErrorCatalog,
  errorBoundary,
  httpTelemetry,
  InvalidErrorCatalog,
  layerBuiltInTracerDisabled,
  type DefectEventInput,
} from "../src/index.ts";
import { effectDefectBoundaryConformance } from "../src/testing/index.ts";

class ItemNotFound extends Schema.TaggedError<ItemNotFound>()("ItemNotFound", {
  code: Schema.Literal("APP.ITEM_NOT_FOUND"),
  message: Schema.String,
}) {}

class UpstreamFailure extends Error implements HttpServerRespondable.Respondable {
  constructor(cause: unknown) {
    super("upstream failed", { cause });
    this.name = "UpstreamFailure";
  }

  [HttpServerRespondable.symbol]() {
    return Effect.succeed(HttpServerResponse.empty({ status: 502 }));
  }
}

class ForeignCoded extends Error {
  readonly code = "OTHER.THING";
  readonly retryable = true;
}

class DefectLog extends Context.Service<
  DefectLog,
  {
    readonly events: Array<DefectEventInput>;
    readonly envelopes: Array<DefectEnvelope>;
  }
>()("test/DefectLog") {}

const PublicError = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  request_id: Schema.optional(Schema.String),
  trace_id: Schema.optional(Schema.String),
});
const decodePublicError = Schema.decodeUnknownSync(PublicError);

const target: Testing.ConformanceTargetContext = {
  name: "t",
  profile: observabilityProfiles["effect-api"],
  environment: "test",
  topology: "local",
  capabilities: { traces: true, metrics: true, defects: true, browserIngest: false, audit: false },
  binding: {
    identity: { serviceName: "t", serviceVersion: "1", environment: "test" },
    contract: { index: 1, contractVersion: 1, service: "t", events: [], metrics: [], aliases: [] },
    producerContractProvenance: "{}",
  },
};

const catalog = Effect.runSync(
  defineErrorCatalog({
    prefix: "APP",
    entries: {
      ITEM_NOT_FOUND: { status: 404, message: "The item does not exist. Check the identifier." },
      RATE_LIMITED: { status: 429, message: "Too many requests. Retry later." },
    },
  }),
);

const routes = Layer.mergeAll(
  HttpRouter.add(
    "GET",
    "/expected",
    Effect.fail(new ItemNotFound({ code: "APP.ITEM_NOT_FOUND", message: "private detail" })),
  ),
  HttpRouter.add("GET", "/outcome", Effect.fail(new HttpApiError.Forbidden())),
  HttpRouter.add("GET", "/defect", Effect.die(new Error("boom"))),
  HttpRouter.add("GET", "/caused", Effect.fail(new UpstreamFailure(new Error("socket")))),
  HttpRouter.add(
    "GET",
    "/caused-http",
    Effect.fail(new UpstreamFailure(new HttpApiError.NotFound())),
  ),
  HttpRouter.add("GET", "/coded", Effect.fail(new ForeignCoded("foreign"))),
  HttpRouter.add("GET", "/ok", HttpServerResponse.text("ok")),
);

const boundary = errorBoundary({
  catalog,
  recordDefect: (input) => Effect.map(DefectLog, (log) => log.events.push(input)),
  captureDefect: ({ envelope }) => Effect.map(DefectLog, (log) => log.envelopes.push(envelope)),
});

const server = (capture: Testing.TelemetryCapture, log: DefectLog["Service"]) =>
  HttpRouter.serve(routes.pipe(Layer.provide(boundary.combine(httpTelemetry()).layer)), {
    disableLogger: true,
    disableListenLog: true,
  }).pipe(
    Layer.provideMerge(NodeHttpServer.layerTest),
    Layer.provide(Layer.succeed(DefectLog, log)),
    Layer.provide(capture.layer),
    Layer.provide(layerBuiltInTracerDisabled),
  );

describe("errorBoundary middleware", () => {
  it.live("classifies expected, outcome, and unexpected failures with correlation", () =>
    Effect.gen(function* () {
      const capture = yield* Testing.makeCapture();
      const log: DefectLog["Service"] = { events: [], envelopes: [] };
      const responses = yield* Effect.gen(function* () {
        const client = yield* HttpClient.HttpClient;
        const read = (path: string) =>
          Effect.flatMap(client.get(path), (response) =>
            Effect.map(response.text, (text) => ({ status: response.status, text })),
          );
        const expected = yield* read("/expected");
        const outcome = yield* read("/outcome");
        const defect = yield* read("/defect");
        const caused = yield* read("/caused");
        const causedHttp = yield* read("/caused-http");
        const coded = yield* read("/coded");
        const ok = yield* read("/ok");
        yield* Effect.sleep("50 millis");
        return { expected, outcome, defect, caused, causedHttp, coded, ok };
      }).pipe(Effect.provide(server(capture, log)), Effect.scoped);
      const telemetry = yield* capture.telemetry;

      assert.equal(responses.expected.status, 404);
      const expectedBody = decodePublicError(JSON.parse(responses.expected.text));
      assert.equal(expectedBody.code, "APP.ITEM_NOT_FOUND");
      assert.equal(expectedBody.message, "The item does not exist. Check the identifier.");
      const expectedSpan = telemetry.spans.find((span) => span.name === "GET /expected");
      assert.isDefined(expectedSpan);
      assert.equal(expectedBody.trace_id, expectedSpan.traceId);
      assert.match(expectedBody.request_id ?? "", /^[0-9a-f-]{36}$/);
      assert.isUndefined(
        Option.getOrUndefined(Testing.attribute(expectedSpan.attributes, "error.type")),
      );

      assert.equal(responses.outcome.status, 403);
      assert.equal(responses.causedHttp.status, 502);

      assert.equal(responses.defect.status, 500);
      const defectBody = decodePublicError(JSON.parse(responses.defect.text));
      assert.equal(defectBody.code, "OBS_EFFECT_UNEXPECTED_DEFECT");
      assert.notInclude(responses.defect.text, "boom");
      const defectSpan = telemetry.spans.find((span) => span.name === "GET /defect");
      assert.isDefined(defectSpan);
      assert.equal(defectBody.trace_id, defectSpan.traceId);
      assert.equal(
        Option.getOrUndefined(Testing.attribute(defectSpan.attributes, "error.type")),
        "500",
      );

      assert.equal(responses.caused.status, 500);
      assert.equal(responses.coded.status, 500);
      assert.equal(responses.ok.status, 200);

      assert.deepEqual(
        log.events.map((event) => [event.error.type, event.error.retryable]),
        [
          ["OBS_EFFECT_UNEXPECTED_DEFECT", false],
          ["OBS_EFFECT_UNEXPECTED_DEFECT", false],
          ["OTHER.THING", true],
        ],
      );
      assert.equal(log.envelopes.length, 3);
      assert.deepEqual(
        log.events.map((event) => Option.getOrUndefined(event.correlation.traceId)),
        [
          defectBody.trace_id,
          decodePublicError(JSON.parse(responses.caused.text)).trace_id,
          decodePublicError(JSON.parse(responses.coded.text)).trace_id,
        ],
      );
    }),
  );

  it.effect("rejects invalid catalogs", () =>
    Effect.gen(function* () {
      const prefix = yield* defineErrorCatalog({
        prefix: "OBS_APP",
        entries: { X: { status: 400, message: "x" } },
      }).pipe(Effect.flip);
      assert.isTrue(prefix instanceof InvalidErrorCatalog);
      assert.equal(prefix.code, "OBS_EFFECT_ERROR_CATALOG_PREFIX_INVALID");
      const status = yield* defineErrorCatalog({
        prefix: "APP",
        entries: { X: { status: 200, message: "x" } },
      }).pipe(Effect.flip);
      assert.equal(status.code, "OBS_EFFECT_ERROR_CATALOG_INVALID");
      assert.equal(status.catalogCode, "APP.X");
      const empty = yield* defineErrorCatalog({ prefix: "APP", entries: {} }).pipe(Effect.flip);
      assert.equal(empty.code, "OBS_EFFECT_ERROR_CATALOG_INVALID");
      assert.equal(catalog.code("RATE_LIMITED"), "APP.RATE_LIMITED");
    }),
  );

  it.effect("passes conformance evidence only when unexpected defects reach capture", () =>
    Effect.gen(function* () {
      const correlation = new CorrelationContext({});
      const passing = yield* effectDefectBoundaryConformance({
        catalog,
        correlation,
        errors: [
          {
            error: new ItemNotFound({ code: "APP.ITEM_NOT_FOUND", message: "x" }),
            captured: false,
          },
          { error: new Error("boom"), captured: true },
        ],
      }).verify(target);
      assert.equal(passing.owner, "effect");
      const classified = yield* classifyError(catalog, new Error("boom"), correlation);
      assert.equal(classified.kind, "unexpected");
      const failing = yield* effectDefectBoundaryConformance({
        catalog,
        correlation,
        errors: [{ error: new Error("boom"), captured: false }],
      })
        .verify(target)
        .pipe(Effect.flip);
      assert.include(failing.message, "never reached Sentry");
    }),
  );
});
