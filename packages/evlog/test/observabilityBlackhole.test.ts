import { Option, Schema } from "effect";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { assert, it } from "vite-plus/test";

const fixture = fileURLToPath(new URL("./fixtures/observability-blackhole.ts", import.meta.url));
const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

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
      }, 6_000);
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
  assert.include(output, '"activeTimeouts":0');
  assert.include(output, '"event.name":"job.completed"');
  assert.include(output, '"transport":1');
  assert.include(output, '"degraded":true');
  assert.include(output, '"participant":"runtime-disposal","result":{"kind":"completed"');
  const closeMatch = /"closeMillis":(\d+)/.exec(output);
  if (closeMatch?.[1] === undefined) throw new Error(`Missing close duration in ${output}`);
  assert.isAtMost(Number(closeMatch[1]), 5_000, output);
  assert.isBelow(output.indexOf("WORK_COMPLETED"), output.indexOf('"closeMillis"'));
}, 10_000);
