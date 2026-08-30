import { Option, Schema } from "effect";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { assert, it } from "vite-plus/test";

const fixture = fileURLToPath(new URL("./fixtures/observability-blackhole.ts", import.meta.url));
const AddressInfo = Schema.Struct({ port: Schema.Number });
const CompletedResult = Schema.Struct({
  kind: Schema.Literal("completed"),
  durationMillis: Schema.Number,
});
const DeadlineResult = Schema.Struct({
  kind: Schema.Literal("deadline-exceeded"),
  budgetMillis: Schema.Number,
  forcedCleanup: CompletedResult,
});
const AdapterOutcome = Schema.Struct({
  participant: Schema.Literal("adapter"),
  adapter: Schema.String,
  capability: Schema.String,
  stage: Schema.String,
  result: Schema.Union([CompletedResult, DeadlineResult]),
});
const RuntimeDisposalOutcome = Schema.Struct({
  participant: Schema.Literal("runtime-disposal"),
  result: CompletedResult,
});
const BlackholeResult = Schema.Struct({
  closeMillis: Schema.Number,
  activeTimeouts: Schema.Number,
  drops: Schema.Struct({ reasons: Schema.Struct({ transport: Schema.Number }) }),
  report: Schema.Struct({
    operation: Schema.Literal("close"),
    outcomes: Schema.Array(Schema.Union([AdapterOutcome, RuntimeDisposalOutcome])),
    durationMillis: Schema.Number,
    degraded: Schema.Boolean,
  }),
});
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);
const decodeBlackholeResult = Schema.decodeUnknownSync(BlackholeResult);

it("closes and exits naturally when the Collector blackholes every request", async () => {
  let requests = 0;
  const sockets = new Set<Socket>();
  const server = createServer(() => {
    requests += 1;
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = decodeAddressInfo(server.address());
  if (Option.isNone(address)) throw new Error("The blackhole server did not report a port.");

  const child = spawn("bun", [fixture], {
    env: {
      ...process.env,
      OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.value.port}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk: string | Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk: string | Buffer) => {
    output += chunk.toString();
  });
  const exit = await new Promise<{ readonly code: number | null; readonly timedOut: boolean }>(
    (resolve) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        resolve({ code: null, timedOut: true });
      }, 7_000);
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve({ code, timedOut: false });
      });
    },
  );
  const requestCountAtExit = requests;
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));

  assert.isFalse(exit.timedOut, output);
  assert.strictEqual(exit.code, 0, output);
  assert.isAbove(requests, 0, output);
  assert.strictEqual(requests, requestCountAtExit, output);
  assert.include(output, "WORK_COMPLETED");
  assert.include(output, '"event.name":"job.completed"');
  const resultLine = output.split("\n").find((line) => line.includes('"closeMillis"'));
  if (resultLine === undefined) throw new Error(`Missing close result in ${output}`);
  const result = decodeBlackholeResult(JSON.parse(resultLine));
  const eventOutcome = result.report.outcomes.find(
    (outcome) => outcome.participant === "adapter" && outcome.adapter === "evlog-events",
  );
  const traceOutcome = result.report.outcomes.find(
    (outcome) => outcome.participant === "adapter" && outcome.adapter === "core-traces",
  );
  const metricOutcome = result.report.outcomes.find(
    (outcome) => outcome.participant === "adapter" && outcome.adapter === "core-metrics",
  );
  const runtimeOutcome = result.report.outcomes.find(
    (outcome) => outcome.participant === "runtime-disposal",
  );
  assert.strictEqual(result.activeTimeouts, 0, output);
  assert.strictEqual(result.drops.reasons.transport, 1, output);
  assert.strictEqual(result.report.operation, "close", output);
  assert.isTrue(result.report.degraded, output);
  if (eventOutcome?.participant !== "adapter") {
    throw new Error(`Missing the event outcome in ${output}`);
  }
  assert.strictEqual(eventOutcome.result.kind, "completed", output);
  assert.strictEqual(eventOutcome.stage, "server", output);
  if (traceOutcome?.participant !== "adapter") {
    throw new Error(`Missing the trace outcome in ${output}`);
  }
  assert.strictEqual(traceOutcome.result.kind, "deadline-exceeded", output);
  assert.strictEqual(traceOutcome.stage, "server", output);
  if (traceOutcome.result.kind !== "deadline-exceeded") {
    throw new Error(`Expected the trace deadline in ${output}`);
  }
  assert.isAbove(traceOutcome.result.budgetMillis, 0, output);
  assert.isAtMost(traceOutcome.result.budgetMillis, 3_950, output);
  assert.strictEqual(traceOutcome.result.forcedCleanup.kind, "completed", output);
  if (metricOutcome?.participant !== "adapter") {
    throw new Error(`Missing the metrics outcome in ${output}`);
  }
  assert.strictEqual(metricOutcome.result.kind, "deadline-exceeded", output);
  assert.strictEqual(metricOutcome.stage, "metrics", output);
  if (metricOutcome.result.kind !== "deadline-exceeded") {
    throw new Error(`Expected the metrics deadline in ${output}`);
  }
  assert.strictEqual(metricOutcome.result.budgetMillis, 0, output);
  assert.strictEqual(metricOutcome.result.forcedCleanup.kind, "completed", output);
  if (runtimeOutcome?.participant !== "runtime-disposal") {
    throw new Error(`Missing runtime disposal in ${output}`);
  }
  assert.strictEqual(runtimeOutcome.result.kind, "completed", output);
  assert.isAtMost(result.report.durationMillis, result.closeMillis, output);
  assert.isBelow(output.indexOf("WORK_COMPLETED"), output.indexOf('"closeMillis"'));
}, 10_000);
