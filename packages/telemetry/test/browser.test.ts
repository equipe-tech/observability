import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Option, Schema } from "effect";
import { createServer, type Server } from "node:http";
import {
  BrowserEventBatch,
  BrowserEventDeliveryError,
  BrowserEventTransport,
  BrowserTelemetry,
  maxFieldValueLength,
} from "../src/browser/index.ts";

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

type RecordedBatches = Array<BrowserEventBatch>;

const recordingTransport = (sent: RecordedBatches): Layer.Layer<BrowserEventTransport> =>
  Layer.succeed(
    BrowserEventTransport,
    BrowserEventTransport.of({
      send: (batch) =>
        Effect.sync(() => {
          sent.push(batch);
        }),
    }),
  );

describe("BrowserTelemetry", () => {
  it.live("emits bounded events and flushes them through the transport", () =>
    Effect.gen(function* () {
      const sent: RecordedBatches = [];
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        const oversizedFields: { [attribute: string]: string | number | boolean } = {
          "page.path": "/checkout",
          "page.value": 42,
          "page.long": "x".repeat(maxFieldValueLength + 100),
        };
        for (let index = 0; index < 40; index++) {
          oversizedFields[`extra.${index}`] = index;
        }
        yield* telemetry.emit("checkout.completed", oversizedFields);
        yield* telemetry.flush();
        assert.strictEqual(yield* telemetry.pending(), 0);
      }).pipe(
        Effect.provide(BrowserTelemetry.layer().pipe(Layer.provide(recordingTransport(sent)))),
      );

      assert.strictEqual(sent.length, 1);
      const batch = sent[0];
      assert.isDefined(batch);
      assert.strictEqual(batch.version, 1);
      assert.strictEqual(batch.events.length, 1);
      const event = batch.events[0];
      assert.isDefined(event);
      assert.strictEqual(event.name, "checkout.completed");
      assert.isTrue(event.id.length > 0);
      assert.isTrue(event.occurredAt > 0);
      assert.strictEqual(event.fields["page.path"], "/checkout");
      assert.strictEqual(event.fields["page.value"], 42);
      const long = event.fields["page.long"];
      assert.strictEqual(String(long).length, maxFieldValueLength);
      assert.strictEqual(Object.keys(event.fields).length, 32);
    }),
  );

  it.live("drops the oldest event and counts it when the queue is full", () =>
    Effect.gen(function* () {
      const sent: RecordedBatches = [];
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("first", {});
        yield* telemetry.emit("second", {});
        yield* telemetry.emit("third", {});
        assert.strictEqual(yield* telemetry.pending(), 2);
        assert.strictEqual(yield* telemetry.dropped(), 1);
        yield* telemetry.flush();
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer({ maxQueueSize: 2 }).pipe(Layer.provide(recordingTransport(sent))),
        ),
      );
      const names = sent.flatMap((batch) => batch.events.map((event) => event.name));
      assert.deepStrictEqual(names, ["second", "third"]);
    }),
  );

  it.live("requeues events on delivery failure and retries on the next flush", () =>
    Effect.gen(function* () {
      const sent: RecordedBatches = [];
      let attempts = 0;
      const flakyTransport = Layer.succeed(
        BrowserEventTransport,
        BrowserEventTransport.of({
          send: (batch) =>
            Effect.suspend(() => {
              attempts += 1;
              if (attempts === 1) {
                return Effect.fail(
                  new BrowserEventDeliveryError({
                    code: "OBS_BROWSER_EVENTS_DELIVERY_FAILED",
                    message: "A rede falhou. Os eventos permanecem na fila.",
                    retryable: true,
                    cause: "network",
                  }),
                );
              }
              sent.push(batch);
              return Effect.void;
            }),
        }),
      );
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("resilient", {});
        const failure = yield* telemetry.flush().pipe(Effect.flip);
        assert.strictEqual(failure._tag, "BrowserEventDeliveryError");
        assert.strictEqual(failure.code, "OBS_BROWSER_EVENTS_DELIVERY_FAILED");
        assert.isTrue(failure.retryable);
        assert.strictEqual(yield* telemetry.pending(), 1);
        yield* telemetry.flush();
        assert.strictEqual(yield* telemetry.pending(), 0);
      }).pipe(Effect.provide(BrowserTelemetry.layer().pipe(Layer.provide(flakyTransport))));
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.live("flushes pending events when the scope closes", () =>
    Effect.gen(function* () {
      const sent: RecordedBatches = [];
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("teardown", {});
      }).pipe(
        Effect.provide(BrowserTelemetry.layer().pipe(Layer.provide(recordingTransport(sent)))),
      );
      const names = sent.flatMap((batch) => batch.events.map((event) => event.name));
      assert.deepStrictEqual(names, ["teardown"]);
    }),
  );

  it.live("flushes on the background interval without an explicit flush", () =>
    Effect.gen(function* () {
      const sent: RecordedBatches = [];
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("periodic", {});
        yield* Effect.sleep("200 millis");
        assert.strictEqual(yield* telemetry.pending(), 0);
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer({ flushInterval: "20 millis" }).pipe(
            Layer.provide(recordingTransport(sent)),
          ),
        ),
      );
      const names = sent.flatMap((batch) => batch.events.map((event) => event.name));
      assert.deepStrictEqual(names, ["periodic"]);
    }),
  );
});

describe("BrowserEventTransport.layerFetch", () => {
  const startEndpoint = (
    status: number,
    bodies: Array<string>,
  ): Promise<{ readonly url: string; readonly server: Server }> =>
    new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: string | Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          bodies.push(body);
          response.writeHead(status, { "content-type": "application/json" });
          response.end("{}");
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = decodeAddressInfo(server.address());
        if (Option.isNone(address)) {
          reject(new Error("The stub endpoint did not report a port."));
          return;
        }
        resolve({ url: `http://127.0.0.1:${address.value.port}/_telemetry/events`, server });
      });
    });

  it.live("posts the encoded batch to the events endpoint", () =>
    Effect.gen(function* () {
      const bodies: Array<string> = [];
      const endpoint = yield* Effect.promise(() => startEndpoint(200, bodies));
      yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("fetch.delivered", { "page.path": "/home" });
        yield* telemetry.flush();
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer().pipe(
            Layer.provide(BrowserEventTransport.layerFetch({ endpoint: endpoint.url })),
          ),
        ),
        Effect.ensuring(Effect.sync(() => endpoint.server.close())),
      );
      assert.strictEqual(bodies.length, 1);
      const body = bodies[0];
      assert.isDefined(body);
      assert.include(body, "fetch.delivered");
      assert.include(body, '"version":1');
    }),
  );

  it.live("fails with a non-retryable error when the endpoint rejects the batch", () =>
    Effect.gen(function* () {
      const bodies: Array<string> = [];
      const endpoint = yield* Effect.promise(() => startEndpoint(400, bodies));
      const failure = yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("fetch.rejected", {});
        return yield* telemetry.flush().pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer().pipe(
            Layer.provide(BrowserEventTransport.layerFetch({ endpoint: endpoint.url })),
          ),
        ),
        Effect.ensuring(Effect.sync(() => endpoint.server.close())),
      );
      assert.strictEqual(failure._tag, "BrowserEventDeliveryError");
      assert.isFalse(failure.retryable);
    }),
  );

  it.live("fails with a retryable error when the endpoint is unreachable", () =>
    Effect.gen(function* () {
      const failure = yield* Effect.gen(function* () {
        const telemetry = yield* BrowserTelemetry;
        yield* telemetry.emit("fetch.unreachable", {});
        return yield* telemetry.flush().pipe(Effect.flip);
      }).pipe(
        Effect.provide(
          BrowserTelemetry.layer().pipe(
            Layer.provide(
              BrowserEventTransport.layerFetch({
                endpoint: "http://127.0.0.1:1/_telemetry/events",
              }),
            ),
          ),
        ),
      );
      assert.strictEqual(failure._tag, "BrowserEventDeliveryError");
      assert.isTrue(failure.retryable);
    }),
  );
});
