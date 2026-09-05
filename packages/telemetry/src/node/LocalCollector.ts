import { Schema } from "effect";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConformanceTargetBinding } from "../testing/conformance/ConformanceModel.ts";
import {
  assessTelemetryDestination,
  type TelemetryDestinationReceipt,
} from "../testing/conformance/TelemetryEvidence.ts";
import {
  startOtlpCaptureServer,
  type CapturedTelemetry,
  type OtlpCaptureServer,
} from "../testing/index.ts";

export class LocalCollectorError extends Schema.TaggedError<LocalCollectorError>()(
  "LocalCollectorError",
  {
    code: Schema.Literal("OBS_CONFORMANCE_LOCAL_COLLECTOR_FAILED"),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const collectorError = (message: string, cause: unknown): LocalCollectorError =>
  new LocalCollectorError({
    code: "OBS_CONFORMANCE_LOCAL_COLLECTOR_FAILED",
    message,
    cause,
  });

export type LocalCollectorDestination = OtlpCaptureServer & {
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
const DockerGateway = Schema.String.check(Schema.isPattern(/^(?:[0-9]{1,3}[.]){3}[0-9]{1,3}$/));
const decodeDockerPort = Schema.decodeUnknownSync(DockerPort);
const decodeDockerGateway = Schema.decodeUnknownSync(DockerGateway);

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
      else {
        reject(
          collectorError(`${args.join(" ")} failed: ${stderr.trim()}`, {
            exitCode,
            command: args[0] ?? "",
          }),
        );
      }
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
  throw collectorError(
    `The isolated Collector did not listen at ${endpoint.origin}.`,
    endpoint.origin,
  );
};

export const startLocalCollectorDestination = async (): Promise<LocalCollectorDestination> => {
  const collectorInstance = `observability-conformance-${crypto.randomUUID()}`;
  let destination: OtlpCaptureServer | undefined;
  let directory: string | undefined;
  let running = false;
  try {
    const linuxGateway =
      process.platform === "linux"
        ? decodeDockerGateway(
            await command([
              "docker",
              "network",
              "inspect",
              "bridge",
              "--format",
              "{{(index .IPAM.Config 0).Gateway}}",
            ]),
          )
        : undefined;
    directory = await mkdtemp(join(tmpdir(), "observability-conformance-"));
    destination =
      linuxGateway === undefined
        ? await startOtlpCaptureServer()
        : await startOtlpCaptureServer({ host: linuxGateway });
    const destinationHost = linuxGateway ?? "host.docker.internal";
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
        `    endpoint: http://${destinationHost}:${destination.endpoint.port}`,
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
    const acquiredDestination = destination;
    const acquiredDirectory = directory;
    return {
      endpoint,
      telemetry: acquiredDestination.telemetry,
      destinationTelemetry: acquiredDestination.telemetry,
      destinationEndpoint: acquiredDestination.endpoint,
      collectorInstance,
      awaitDestination: async (runId) => {
        for (let attempt = 0; attempt < 40; attempt++) {
          if (
            acquiredDestination
              .telemetry()
              .logs.some((log) => log.attributes.get("run.id") === runId)
          ) {
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        const logs = await command(["docker", "logs", collectorInstance]);
        throw collectorError(
          `Collector destination did not observe run ${runId}. Collector logs: ${logs}`,
          runId,
        );
      },
      destinationReceipt: (runId, binding) =>
        assessTelemetryDestination({
          topology: "local",
          runId,
          identity: binding.identity,
          observationId: collectorInstance,
          readback: acquiredDestination.telemetry,
        }),
      stop: () => {
        stopPromise ??= Promise.all([
          running
            ? command(["docker", "rm", "--force", collectorInstance]).then(() => undefined)
            : Promise.resolve(),
          acquiredDestination.stop(),
        ]).then(() => rm(acquiredDirectory, { recursive: true, force: true }));
        running = false;
        return stopPromise;
      },
    };
  } catch (cause) {
    if (running) {
      await command(["docker", "rm", "--force", collectorInstance]).catch(() => undefined);
    }
    if (destination !== undefined) await destination.stop();
    if (directory !== undefined) await rm(directory, { recursive: true, force: true });
    throw collectorError(`The isolated Collector could not start: ${String(cause)}`, cause);
  }
};
