import { Option, Schema } from "effect";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { afterEach, assert, describe, it } from "vite-plus/test";

const fixture = fileURLToPath(new URL("./fixtures/node-main.ts", import.meta.url));

type CollectorRequest = {
  readonly path: string;
  readonly body: string;
};

const AddressInfo = Schema.Struct({ port: Schema.Number });
const decodeAddressInfo = Schema.decodeUnknownOption(AddressInfo);

type Collector = {
  readonly endpoint: string;
  readonly requests: ReadonlyArray<CollectorRequest>;
  readonly server: Server;
};

const startCollector = (): Promise<Collector> =>
  new Promise((resolve, reject) => {
    const requests: Array<CollectorRequest> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: string | Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requests.push({ path: request.url ?? "", body });
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = decodeAddressInfo(server.address());
      if (Option.isNone(address)) {
        reject(new Error("The stub collector did not report a port."));
        return;
      }
      resolve({
        endpoint: `http://127.0.0.1:${address.value.port}`,
        requests,
        server,
      });
    });
    server.on("error", reject);
  });

const spawnFixture = (mode: string, endpoint: string, runId: string): ChildProcess =>
  spawn("bun", [fixture, mode], {
    env: {
      ...process.env,
      OTEL_SERVICE_NAME: "node-adapter-test",
      OTEL_SERVICE_VERSION: "0.1.0",
      OTEL_DEPLOYMENT_ENVIRONMENT: "test",
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      NODE_RUN_ID: runId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

const waitForExit = (child: ChildProcess): Promise<number | null> =>
  new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

const waitForOutput = (child: ChildProcess, marker: string): Promise<void> =>
  new Promise((resolve) => {
    let output = "";
    child.stdout?.on("data", (chunk: string | Buffer) => {
      output += chunk.toString();
      if (output.includes(marker)) {
        resolve();
      }
    });
  });

const collectOutput = (child: ChildProcess): (() => string) => {
  let output = "";
  const append = (chunk: string | Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return () => output;
};

describe("node runMain", () => {
  const servers: Array<Server> = [];

  afterEach(() => {
    for (const server of servers.splice(0)) {
      server.close();
    }
  });

  it("runs the program with telemetry from the environment and exits with code 0", async () => {
    const collector = await startCollector();
    servers.push(collector.server);
    const runId = `node-success-${Date.now()}`;
    const child = spawnFixture("success", collector.endpoint, runId);
    const exitCode = await waitForExit(child);

    assert.strictEqual(exitCode, 0);
    const traces = collector.requests.filter((request) => request.path === "/v1/traces");
    const logs = collector.requests.filter((request) => request.path === "/v1/logs");
    assert.isTrue(traces.some((request) => request.body.includes("node.main")));
    assert.isTrue(
      logs.some(
        (request) => request.body.includes("node.main.completed") && request.body.includes(runId),
      ),
    );
    const resources = collector.requests.map((request) => request.body).join("\n");
    assert.include(resources, "node-adapter-test");
  }, 30_000);

  it("interrupts on SIGTERM, flushes telemetry and exits with code 130", async () => {
    const collector = await startCollector();
    servers.push(collector.server);
    const runId = `node-signal-${Date.now()}`;
    const child = spawnFixture("signal", collector.endpoint, runId);
    await waitForOutput(child, "ready");
    child.kill("SIGTERM");
    const exitCode = await waitForExit(child);

    assert.strictEqual(exitCode, 130);
    assert.isTrue(
      collector.requests.some(
        (request) =>
          request.path === "/v1/logs" &&
          request.body.includes("node.main.started") &&
          request.body.includes(runId),
      ),
    );
    assert.isTrue(
      collector.requests.some(
        (request) => request.path === "/v1/traces" && request.body.includes("node.signal"),
      ),
    );
  }, 30_000);

  it("fails startup with exit code 1 when the telemetry environment is invalid", async () => {
    const collector = await startCollector();
    servers.push(collector.server);
    const child = spawnFixture("invalid-env", collector.endpoint, "unused");
    const output = collectOutput(child);
    const exitCode = await waitForExit(child);

    assert.strictEqual(exitCode, 1);
    assert.include(output(), "InvalidTelemetryEnvironment");
    assert.strictEqual(collector.requests.length, 0);
  }, 30_000);
});
