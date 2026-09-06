import { Effect } from "effect";
import { expect, it } from "vite-plus/test";
import { startEvlogTransport } from "../src/EvlogTransport.ts";

const config = {
  endpoint: "http://127.0.0.1:1",
  serviceName: "worker-lifecycle-test",
  resourceAttributes: {},
  maximumBufferedEvents: 10,
  batchSize: 5,
  batchIntervalMillis: 60_000,
  maximumAttempts: 3,
  initialRetryDelayMillis: 100,
  maximumRetryDelayMillis: 1_000,
  transportTimeoutMillis: 5_000,
  transportRetries: 2,
};

it("reports worker startup errors in the failure channel and permits a clean replacement", async () => {
  const failure = await Effect.runPromise(
    startEvlogTransport(
      { ...config, batchSize: 0 },
      () => {},
      () => {},
    ).pipe(Effect.flip),
  );
  expect(failure.message).toContain("batch.size");
  const replacement = await Effect.runPromise(
    startEvlogTransport(
      config,
      () => {},
      () => {},
    ),
  );
  await replacement.close();
  await replacement.close();
  expect(replacement.pending).toBe(0);
  expect(replacement.failed).toBe(false);
});

it("settles pending admission and flush on a worker protocol failure without claiming delivery", async () => {
  const delivered: Array<string> = [];
  const dropped: Array<string> = [];
  const transport = await Effect.runPromise(
    startEvlogTransport(
      config,
      (records) => {
        delivered.push(...records.map((record) => record.serialized));
      },
      (records, reason) => {
        dropped.push(...records.map(() => reason));
      },
    ),
  );
  const offered = transport.offer({ serialized: "malformed worker event" });
  const flushed = transport.flush();
  expect(await offered).toBe("transport");
  await flushed;
  await transport.close();
  expect(delivered).toEqual([]);
  expect(dropped).toEqual(["transport"]);
  expect(transport.pending).toBe(0);
  expect(transport.failed).toBe(true);
});
