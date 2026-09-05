import { Schema } from "effect";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  startOtlpCaptureServer,
  telemetryDestinationReceipt,
  type CapturedTelemetry,
  type ConformanceTargetBinding,
  type OtlpCaptureServer,
  type TelemetryDestinationReceipt,
} from "@equipe-tech/observability/testing";
import { fixtureError } from "./FixtureError.ts";

export type LocalCollector = OtlpCaptureServer & {
  readonly destinationTelemetry: () => CapturedTelemetry;
  readonly destinationEndpoint: URL;
  readonly collectorInstance: string;
  readonly awaitDestination: (runId: string) => Promise<void>;
  readonly destinationReceipt: (
    runId: string,
    binding: ConformanceTargetBinding,
  ) => TelemetryDestinationReceipt;
};

const DockerPort = Schema.String.check(Schema.isPattern(/127[.]0[.]0[.]1:[0-9]+/));
const decodeDockerPort = Schema.decodeUnknownSync(DockerPort);

const command = (args: ReadonlyArray<string>): Promise<string> =>
  new Promise((resolve, reject) => {
    const process = spawn(args[0] ?? "", args.slice(1));
    let stdout = "";
    let stderr = "";
    process.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process.on("error", reject);
    process.on("close", (exitCode) => {
      if (exitCode === 0) resolve(`${stdout}${stderr}`.trim());
      else reject(fixtureError(`${args.join(" ")} failed: ${stderr.trim()}`));
    });
  });

const waitForCollector = async (endpoint: URL): Promise<void> => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const reachable = await fetch(endpoint, {
      signal: AbortSignal.timeout(1_000),
    }).then(
      () => true,
      () => false,
    );
    if (reachable) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw fixtureError(`The isolated Collector did not listen at ${endpoint.origin}.`);
};

export const startLocalCollector = async (): Promise<LocalCollector> => {
  const destination = await startOtlpCaptureServer();
  const directory = await mkdtemp(join(tmpdir(), "observability-conformance-"));
  const collectorInstance = `observability-conformance-${crypto.randomUUID()}`;
  const destinationPort = destination.endpoint.port;
  const configPath = join(directory, "collector.yaml");
  await writeFile(
    configPath,
    [
      "receivers:",
      "  otlp:",
      "    protocols:",
      "      http:",
      "        endpoint: 0.0.0.0:4318",
      "exporters:",
      "  otlphttp/destination:",
      `    endpoint: http://host.docker.internal:${destinationPort}`,
      "    compression: none",
      "    encoding: json",
      "service:",
      "  pipelines:",
      "    traces:",
      "      receivers: [otlp]",
      "      exporters: [otlphttp/destination]",
      "    metrics:",
      "      receivers: [otlp]",
      "      exporters: [otlphttp/destination]",
      "    logs:",
      "      receivers: [otlp]",
      "      exporters: [otlphttp/destination]",
      "",
    ].join("\n"),
  );
  let running = false;
  try {
    await command([
      "docker",
      "run",
      "--detach",
      "--rm",
      "--name",
      collectorInstance,
      "--add-host",
      "host.docker.internal:host-gateway",
      "--publish",
      "127.0.0.1::4318",
      "--volume",
      `${configPath}:/etc/otelcol/config.yaml:ro`,
      "otel/opentelemetry-collector-contrib:0.159.0",
      "--config=/etc/otelcol/config.yaml",
    ]);
    running = true;
    const address = decodeDockerPort(
      await command(["docker", "port", collectorInstance, "4318/tcp"]),
    );
    const endpoint = new URL(`http://${address}`);
    await waitForCollector(endpoint);
    let stopPromise: Promise<void> | undefined;
    return {
      endpoint,
      telemetry: destination.telemetry,
      destinationTelemetry: destination.telemetry,
      destinationEndpoint: destination.endpoint,
      collectorInstance,
      awaitDestination: async (runId) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (destination.telemetry().logs.some((log) => log.attributes.get("run.id") === runId)) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const logs = await command(["docker", "logs", collectorInstance]);
        throw fixtureError(
          `Collector destination did not observe run ${runId}. Collector logs: ${logs}`,
        );
      },
      destinationReceipt: (runId, binding) =>
        telemetryDestinationReceipt({
          topology: "local",
          runId,
          identity: binding.identity,
          observationId: collectorInstance,
          telemetry: destination.telemetry(),
        }),
      stop: () => {
        stopPromise ??= Promise.all([
          running
            ? command(["docker", "rm", "--force", collectorInstance]).then(() => undefined)
            : Promise.resolve(),
          destination.stop(),
        ]).then(() => rm(directory, { recursive: true, force: true }));
        running = false;
        return stopPromise;
      },
    };
  } catch (cause) {
    if (running) {
      await command(["docker", "rm", "--force", collectorInstance]).catch(() => undefined);
    }
    await destination.stop();
    await rm(directory, { recursive: true, force: true });
    throw fixtureError(`The isolated Collector could not start: ${String(cause)}`);
  }
};
