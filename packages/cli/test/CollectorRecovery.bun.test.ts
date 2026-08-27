import { afterAll, describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { access, chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../../..", import.meta.url));
const image = "otel/opentelemetry-collector-contrib:0.159.0";
const signalCleanupMode = process.env["OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_TEST"] === "1";
const signalCleanupScenario =
  process.env["OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_SCENARIO"] ?? "resources";
const enabled = process.env["OBSERVABILITY_COLLECTOR_RECOVERY"] === "1" || signalCleanupMode;
const signalReadyFile = process.env["OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_READY_FILE"] ?? "";
const evidenceRoot = process.env["OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT"] ?? "";
const runId = `obs10-${process.pid}-${crypto.randomUUID().slice(0, 8)}`;
const network = `${runId}-network`;
const containers = new Set<string>();
let root = "";
let rootAllocation = Promise.resolve("");
let signalHandlersInstalled = false;
let terminationRequested = false;
let terminationExitCode = 1;

const runDocker = (args: ReadonlyArray<string>): string => {
  const result = Bun.spawnSync(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = result.stdout.toString().trim();
  const stderr = result.stderr.toString().trim();
  if (result.exitCode !== 0) {
    throw new Error(`docker ${args.join(" ")} failed with ${result.exitCode}: ${stderr}`);
  }
  return stdout;
};

const dockerLogs = (container: string): string => {
  const result = Bun.spawnSync(["docker", "logs", container], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`docker logs ${container} failed with ${result.exitCode}`);
  }
  return `${result.stdout.toString()}${result.stderr.toString()}`;
};

const hostPort = (container: string, port: number): number => {
  const binding = runDocker(["port", container, `${port}/tcp`]);
  const value = Number(binding.slice(binding.lastIndexOf(":") + 1));
  expect(Number.isInteger(value)).toBe(true);
  return value;
};

const saveEvidence = async (name: string, content: string): Promise<void> => {
  if (evidenceRoot !== "") {
    await mkdir(evidenceRoot, { recursive: true });
    await writeFile(join(evidenceRoot, name), `${content.trimEnd()}\n`);
  }
};

const waitForText = async (
  load: () => Promise<string>,
  predicate: (value: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> => {
  const deadline = Date.now() + timeoutMs;
  let latest = "";
  while (Date.now() < deadline) {
    try {
      latest = await load();
      if (predicate(latest)) {
        return latest;
      }
    } catch {
      latest = "";
    }
    await Bun.sleep(100);
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms: ${latest}`);
};

const fetchText = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
};

const tracePayload = (name: string, sequence: number): string => {
  const traceId = sequence.toString(16).padStart(32, "0");
  const spanId = sequence.toString(16).padStart(16, "0");
  return JSON.stringify({
    resourceSpans: [
      {
        resource: {},
        scopeSpans: [
          {
            scope: {},
            spans: [
              {
                traceId,
                spanId,
                name,
                startTimeUnixNano: "1",
                endTimeUnixNano: "2",
                status: {},
              },
            ],
          },
        ],
      },
    ],
  });
};

const logPayload = (name: string): string =>
  JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "canary.id", value: { stringValue: name } }] },
        scopeLogs: [{ scope: {}, logRecords: [{ body: { stringValue: name } }] }],
      },
    ],
  });

const metricPayload = (name: string): string =>
  JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "canary.id", value: { stringValue: name } }] },
        scopeMetrics: [
          {
            scope: {},
            metrics: [
              {
                name,
                sum: {
                  dataPoints: [{ asInt: "1" }],
                  aggregationTemporality: 2,
                  isMonotonic: true,
                },
              },
            ],
          },
        ],
      },
    ],
  });

const send = async (port: number, signal: string, body: string): Promise<number> => {
  const response = await fetch(`http://127.0.0.1:${port}/v1/${signal}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await response.text();
  return response.status;
};

interface RecoverySignal {
  readonly signal: string;
  readonly exporter: string;
  readonly identity: string;
  readonly body: string;
}

const recoverySignals = (phase: string, sequence: number): ReadonlyArray<RecoverySignal> => {
  const traceIdentity = `${runId}-${phase}-trace`;
  const logIdentity = `${runId}-${phase}-log`;
  const metricIdentity = `${runId}.${phase}.metric`;
  return [
    {
      signal: "traces",
      exporter: "otlphttp/traces",
      identity: traceIdentity,
      body: tracePayload(traceIdentity, sequence),
    },
    {
      signal: "logs",
      exporter: "otlphttp/logs",
      identity: logIdentity,
      body: logPayload(logIdentity),
    },
    {
      signal: "metrics",
      exporter: "otlphttp/metrics",
      identity: metricIdentity,
      body: metricPayload(metricIdentity),
    },
  ];
};

const sendRecoverySignals = async (
  port: number,
  signals: ReadonlyArray<RecoverySignal>,
): Promise<void> => {
  for (const signal of signals) {
    expect(await send(port, signal.signal, signal.body)).toBe(200);
  }
};

const sourceConfig = (sink: string, queueSize: number): string => `extensions:
  file_storage/queue:
    directory: /var/lib/otelcol/queue
    create_directory: true
    max_size: 2147483648
    fsync: true
    recreate: false
  health_check:
    endpoint: 0.0.0.0:13133
    path: /health
receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
        max_request_body_size: 8388608
exporters:
  otlphttp/traces:
    endpoint: http://${sink}:4318
    encoding: json
    compression: none
    sending_queue:
      enabled: true
      storage: file_storage/queue
      queue_size: ${queueSize}
      num_consumers: 1
      block_on_overflow: false
      batch:
        flush_timeout: 200ms
        min_size: 1
        max_size: 8388608
        sizer: bytes
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 2s
      max_elapsed_time: 0
  otlphttp/logs:
    endpoint: http://${sink}:4318
    encoding: json
    compression: none
    sending_queue:
      enabled: true
      storage: file_storage/queue
      queue_size: ${queueSize}
      num_consumers: 1
      block_on_overflow: false
      batch:
        flush_timeout: 200ms
        min_size: 1
        max_size: 8388608
        sizer: bytes
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 2s
      max_elapsed_time: 0
  otlphttp/metrics:
    endpoint: http://${sink}:4318
    encoding: json
    compression: none
    sending_queue:
      enabled: true
      storage: file_storage/queue
      queue_size: ${queueSize}
      num_consumers: 1
      block_on_overflow: false
      batch:
        flush_timeout: 200ms
        min_size: 1
        max_size: 8388608
        sizer: bytes
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 2s
      max_elapsed_time: 0
service:
  telemetry:
    metrics:
      level: detailed
      readers:
        - pull:
            exporter:
              prometheus:
                host: 0.0.0.0
                port: 8888
  extensions: [file_storage/queue, health_check]
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [otlphttp/traces]
    logs:
      receivers: [otlp]
      exporters: [otlphttp/logs]
    metrics:
      receivers: [otlp]
      exporters: [otlphttp/metrics]
`;

const sinkConfig = (): string => `receivers:
  otlp:
    protocols:
      http:
        endpoint: 0.0.0.0:4318
exporters:
  file/receipts:
    path: /receipts/otlp.jsonl
    format: json
    flush_interval: 100ms
service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [file/receipts]
    logs:
      receivers: [otlp]
      exporters: [file/receipts]
    metrics:
      receivers: [otlp]
      exporters: [file/receipts]
`;

const startSource = (
  name: string,
  config: string,
  queue: string,
): {
  readonly id: string;
  readonly otlpPort: number;
  readonly healthPort: number;
  readonly metricsPort: number;
} => {
  containers.add(name);
  const id = runDocker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--publish",
    "127.0.0.1::4318",
    "--publish",
    "127.0.0.1::13133",
    "--publish",
    "127.0.0.1::8888",
    "--user",
    "10001:10001",
    "--volume",
    `${config}:/etc/otelcol/config.yaml:ro`,
    "--volume",
    `${queue}:/var/lib/otelcol/queue`,
    image,
    "--config=/etc/otelcol/config.yaml",
  ]);
  return {
    id,
    otlpPort: hostPort(name, 4318),
    healthPort: hostPort(name, 13133),
    metricsPort: hostPort(name, 8888),
  };
};

const startSink = (name: string, config: string, receipts: string): string => {
  containers.add(name);
  return runDocker([
    "run",
    "--detach",
    "--name",
    name,
    "--network",
    network,
    "--volume",
    `${config}:/etc/otelcol/config.yaml:ro`,
    "--volume",
    `${receipts}:/receipts`,
    image,
    "--config=/etc/otelcol/config.yaml",
  ]);
};

const removeContainer = (name: string): void => {
  if (containers.delete(name)) {
    runDocker(["rm", "--force", name]);
  }
};

const receiptCount = (receipts: string, identity: string): number =>
  receipts.split("\n").filter((line) => line.includes(identity)).length;

const metricValue = (metrics: string, name: string, exporter: string): number => {
  const line = metrics
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith(`${name}{`) && candidate.includes(`exporter="${exporter}"`),
    );
  if (line === undefined) {
    throw new Error(`${name} for ${exporter} was absent`);
  }
  return Number(line.slice(line.lastIndexOf(" ") + 1));
};

const queuesAreEmpty = (metrics: string): boolean =>
  ["otlphttp/traces", "otlphttp/logs", "otlphttp/metrics"].every(
    (exporter) => metricValue(metrics, "otelcol_exporter_queue_size", exporter) === 0,
  );

const waitForSustainedEmptyQueues = async (metricsPort: number): Promise<string> => {
  const first = await waitForText(
    () => fetchText(`http://127.0.0.1:${metricsPort}/metrics`),
    queuesAreEmpty,
  );
  expect(queuesAreEmpty(first)).toBe(true);
  await Bun.sleep(1_000);
  const second = await fetchText(`http://127.0.0.1:${metricsPort}/metrics`);
  expect(queuesAreEmpty(second)).toBe(true);
  return second;
};

const receiverMetricValue = (metrics: string, name: string): number => {
  const line = metrics
    .split("\n")
    .find(
      (candidate) =>
        candidate.startsWith(`${name}{`) &&
        candidate.includes('receiver="otlp"') &&
        candidate.includes('transport="http"'),
    );
  if (line === undefined) {
    throw new Error(`${name} for the OTLP HTTP receiver was absent`);
  }
  return Number(line.slice(line.lastIndexOf(" ") + 1));
};

interface SaturationResult {
  readonly signal: string;
  readonly acceptedNames: ReadonlyArray<string>;
  readonly allNames: ReadonlyArray<string>;
  readonly statuses: ReadonlyArray<number>;
}

const SignalCleanupReady = Schema.Struct({
  phase: Schema.NonEmptyString,
  root: Schema.NonEmptyString.pipe(Schema.optionalKey),
  container: Schema.NonEmptyString.pipe(Schema.optionalKey),
  network: Schema.NonEmptyString.pipe(Schema.optionalKey),
  runId: Schema.NonEmptyString,
});

const decodeSignalCleanupReady = Schema.decodeUnknownSync(SignalCleanupReady);

interface CollectorCleanupScenario {
  readonly name: string;
  readonly scenario: string;
  readonly signals: ReadonlyArray<NodeJS.Signals>;
  readonly expectedExitCode: number;
}

const collectorCleanupScenarios: ReadonlyArray<CollectorCleanupScenario> = [
  { name: "active resources", scenario: "resources", signals: ["SIGINT"], expectedExitCode: 130 },
  { name: "allocation", scenario: "allocation", signals: ["SIGTERM"], expectedExitCode: 143 },
  {
    name: "repeated signals",
    scenario: "allocation",
    signals: ["SIGINT", "SIGINT"],
    expectedExitCode: 130,
  },
  {
    name: "mixed signals",
    scenario: "allocation",
    signals: ["SIGTERM", "SIGINT"],
    expectedExitCode: 143,
  },
  { name: "normal failure", scenario: "failure", signals: [], expectedExitCode: 1 },
];

const waitForFile = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await Bun.file(path).exists()) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`The cleanup harness did not create ${path}.`);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const waitForAbsence = async (path: string): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (!(await pathExists(path))) {
      return;
    }
    await Bun.sleep(25);
  }
  throw new Error(`The cleanup harness left ${path}.`);
};

let cleanupStarted = false;
let cleanupResult = Promise.resolve();

const cleanupResources = async (): Promise<void> => {
  try {
    root = await rootAllocation;
  } catch {
    root = "";
  }
  for (const container of containers) {
    Bun.spawnSync(["docker", "rm", "--force", container], {
      stdout: "ignore",
      stderr: "ignore",
    });
  }
  containers.clear();
  Bun.spawnSync(["docker", "network", "rm", network], {
    stdout: "ignore",
    stderr: "ignore",
  });
  const temporaryRoot = root;
  root = "";
  if (temporaryRoot !== "") {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
  const remainingContainers = Bun.spawnSync([
    "docker",
    "ps",
    "--all",
    "--filter",
    `name=${runId}`,
    "--format",
    "{{.Names}}",
  ]).stdout.toString();
  const remainingNetworks = Bun.spawnSync([
    "docker",
    "network",
    "ls",
    "--filter",
    `name=${network}`,
    "--format",
    "{{.Name}}",
  ]).stdout.toString();
  await saveEvidence(
    "cleanup.txt",
    `containers=${remainingContainers.trim()}\nnetworks=${remainingNetworks.trim()}`,
  );
};

const cleanup = (): Promise<void> => {
  if (!cleanupStarted) {
    cleanupStarted = true;
    cleanupResult = cleanupResources();
  }
  return cleanupResult;
};

const terminateAfterCleanup = (exitCode: number): void => {
  if (!terminationRequested) {
    terminationRequested = true;
    terminationExitCode = exitCode;
    cleanup().then(
      () => process.exit(terminationExitCode),
      () => process.exit(terminationExitCode),
    );
    return;
  }
  cleanup().then(
    () => undefined,
    () => undefined,
  );
};

const onSigint = (): void => terminateAfterCleanup(130);
const onSigterm = (): void => terminateAfterCleanup(143);

const installSignalHandlers = (): void => {
  if (!signalHandlersInstalled) {
    signalHandlersInstalled = true;
    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
  }
};

const beginRootAllocation = (allocate: () => Promise<string>): Promise<string> => {
  rootAllocation = allocate();
  installSignalHandlers();
  return rootAllocation;
};

afterAll(async () => {
  if (!enabled) {
    return;
  }
  await cleanup();
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  signalHandlersInstalled = false;
});

const signalCleanupDescribe = signalCleanupMode ? describe : describe.skip;

signalCleanupDescribe("Collector recovery signal cleanup", () => {
  test("cleans the bounded signal scenario", async () => {
    if (signalReadyFile === "") {
      throw new Error("The signal cleanup test requires a ready file path.");
    }
    const allocate = async (): Promise<string> => {
      if (signalCleanupScenario === "allocation") {
        await writeFile(signalReadyFile, JSON.stringify({ phase: "allocation", runId }));
        await Bun.sleep(250);
      }
      return mkdtemp(join(tmpdir(), `${runId}-`));
    };
    root = await beginRootAllocation(allocate);
    if (terminationRequested) {
      await cleanup();
      await Bun.sleep(30_000);
    }
    if (signalCleanupScenario !== "allocation") {
      runDocker(["network", "create", network]);
      const container = `${runId}-signal`;
      containers.add(container);
      runDocker(["create", "--name", container, "--network", network, image]);
      await writeFile(
        signalReadyFile,
        JSON.stringify({ phase: signalCleanupScenario, root, container, network, runId }),
      );
      if (signalCleanupScenario === "failure") {
        throw new Error("The recovery cleanup failure test failed as requested.");
      }
    }
    await new Promise<never>(() => undefined);
  }, 30_000);
});

const recoveryDescribe = enabled && !signalCleanupMode ? describe : describe.skip;

recoveryDescribe("Collector recovery", () => {
  test("persists every signal across restart and rejects requests at queue saturation", async () => {
    root = await beginRootAllocation(() => mkdtemp(join(tmpdir(), `${runId}-`)));
    runDocker(["network", "create", network]);
    await saveEvidence("run.txt", `run_id=${runId}\nnetwork=${network}\nroot=${root}`);
    await saveEvidence(
      "image-digest.txt",
      runDocker(["image", "inspect", image, "--format", "{{.Id}}"]),
    );

    const recoveryQueue = join(root, "recovery-queue");
    const recoveryReceipts = join(root, "recovery-receipts");
    const recoveryConfig = join(root, "recovery-source.yaml");
    const recoverySinkConfig = join(root, "recovery-sink.yaml");
    await Promise.all([
      mkdir(recoveryQueue),
      mkdir(recoveryReceipts),
      writeFile(recoveryConfig, sourceConfig(`${runId}-sink`, 64)),
      writeFile(recoverySinkConfig, sinkConfig()),
    ]);
    await Promise.all([chmod(recoveryQueue, 0o777), chmod(recoveryReceipts, 0o777)]);

    const recoveryReceiptPath = join(recoveryReceipts, "otlp.jsonl");
    const beforeOutage = recoverySignals("before-outage", 1);
    const duringOutage = recoverySignals("during-outage", 2);
    const afterRestart = recoverySignals("after-restart", 3);
    const expectedRecoverySignals = [...beforeOutage, ...duringOutage, ...afterRestart];
    await saveEvidence(
      "recovery-identities.json",
      JSON.stringify(expectedRecoverySignals, undefined, 2),
    );

    startSink(`${runId}-sink`, recoverySinkConfig, recoveryReceipts);
    const original = startSource(`${runId}-source`, recoveryConfig, recoveryQueue);
    await saveEvidence("recovery-source-original-id.txt", original.id);
    await waitForText(
      () => fetchText(`http://127.0.0.1:${original.healthPort}/health`),
      (value) => value.length > 0,
    );
    await sendRecoverySignals(original.otlpPort, beforeOutage);
    const beforeOutageReceipts = await waitForText(
      () => readFile(recoveryReceiptPath, "utf8"),
      (value) => beforeOutage.every((signal) => value.includes(signal.identity)),
    );
    for (const signal of beforeOutage) {
      expect(receiptCount(beforeOutageReceipts, signal.identity)).toBe(1);
    }
    await waitForSustainedEmptyQueues(original.metricsPort);

    removeContainer(`${runId}-sink`);
    await Bun.sleep(250);
    await sendRecoverySignals(original.otlpPort, duringOutage);
    const queued = await waitForText(
      () => fetchText(`http://127.0.0.1:${original.metricsPort}/metrics`),
      (value) =>
        duringOutage.every(
          (signal) => metricValue(value, "otelcol_exporter_queue_size", signal.exporter) === 1,
        ),
    );
    expect(queued).toContain("otelcol_exporter_queue_capacity");
    await saveEvidence("recovery-queued-metrics.txt", queued);
    expect(await fetchText(`http://127.0.0.1:${original.healthPort}/health`)).toContain(
      "Server available",
    );
    await saveEvidence("recovery-source-original.log", dockerLogs(`${runId}-source`));

    removeContainer(`${runId}-source`);
    const restarted = startSource(`${runId}-source-restarted`, recoveryConfig, recoveryQueue);
    expect(restarted.id).not.toBe(original.id);
    await saveEvidence("recovery-source-restarted-id.txt", restarted.id);
    await waitForText(
      () => fetchText(`http://127.0.0.1:${restarted.healthPort}/health`),
      (value) => value.length > 0,
    );

    startSink(`${runId}-sink`, recoverySinkConfig, recoveryReceipts);
    await waitForText(
      () => readFile(recoveryReceiptPath, "utf8"),
      (value) => duringOutage.every((signal) => value.includes(signal.identity)),
    );
    await sendRecoverySignals(restarted.otlpPort, afterRestart);
    await waitForText(
      () => readFile(recoveryReceiptPath, "utf8"),
      (value) =>
        [...duringOutage, ...afterRestart].every((signal) => value.includes(signal.identity)),
    );
    const drainedMetrics = await waitForSustainedEmptyQueues(restarted.metricsPort);
    const afterRestartReceipts = await readFile(recoveryReceiptPath, "utf8");
    const finalRecoveryReceipts = `${beforeOutageReceipts.trimEnd()}\n${afterRestartReceipts}`;
    for (const signal of expectedRecoverySignals) {
      expect(receiptCount(finalRecoveryReceipts, signal.identity)).toBe(1);
    }
    await saveEvidence("recovery-final-receipts.jsonl", finalRecoveryReceipts);
    await saveEvidence("recovery-drained-metrics.txt", drainedMetrics);

    const saturationQueue = join(root, "saturation-queue");
    const saturationReceipts = join(root, "saturation-receipts");
    const saturationConfig = join(root, "saturation-source.yaml");
    const saturationSinkConfig = join(root, "saturation-sink.yaml");
    await Promise.all([
      mkdir(saturationQueue),
      mkdir(saturationReceipts),
      writeFile(saturationConfig, sourceConfig(`${runId}-saturation-sink`, 4)),
      writeFile(saturationSinkConfig, sinkConfig()),
    ]);
    await Promise.all([chmod(saturationQueue, 0o777), chmod(saturationReceipts, 0o777)]);

    const saturation = startSource(`${runId}-saturation-source`, saturationConfig, saturationQueue);
    await waitForText(
      () => fetchText(`http://127.0.0.1:${saturation.healthPort}/health`),
      (value) => value.length > 0,
    );
    const saturationSignals = [
      {
        signal: "traces",
        exporter: "otlphttp/traces",
        enqueueFailureMetric: "otelcol_exporter_enqueue_failed_spans",
        receiverRefusalMetric: "otelcol_receiver_refused_spans",
        payload: (name: string, index: number) => tracePayload(name, index + 10),
      },
      {
        signal: "logs",
        exporter: "otlphttp/logs",
        enqueueFailureMetric: "otelcol_exporter_enqueue_failed_log_records",
        receiverRefusalMetric: "otelcol_receiver_refused_log_records",
        payload: (name: string) => logPayload(name),
      },
      {
        signal: "metrics",
        exporter: "otlphttp/metrics",
        enqueueFailureMetric: "otelcol_exporter_enqueue_failed_metric_points",
        receiverRefusalMetric: "otelcol_receiver_refused_metric_points",
        payload: (name: string) => metricPayload(name.replaceAll("-", ".")),
      },
    ];
    const saturationResults: Array<SaturationResult> = [];
    for (const saturationSignal of saturationSignals) {
      const requests = Array.from({ length: 8 }, (_, index) => {
        const name = `${runId}-saturation-${saturationSignal.signal}-${index + 1}`;
        return {
          name,
          response: send(
            saturation.otlpPort,
            saturationSignal.signal,
            saturationSignal.payload(name, index),
          ),
        };
      });
      const statuses = await Promise.all(requests.map((request) => request.response));
      const acceptedNames = requests
        .filter((_, index) => statuses[index] === 200)
        .map((request) => request.name);
      expect(statuses.filter((status) => status === 200)).toHaveLength(4);
      expect(statuses.filter((status) => status === 503)).toHaveLength(4);
      saturationResults.push({
        signal: saturationSignal.signal,
        acceptedNames,
        allNames: requests.map((request) => request.name),
        statuses,
      });
    }
    await saveEvidence("saturation-statuses.json", JSON.stringify(saturationResults, undefined, 2));

    const saturatedMetrics = await waitForText(
      () => fetchText(`http://127.0.0.1:${saturation.metricsPort}/metrics`),
      (value) =>
        saturationSignals.every(
          (signal) =>
            metricValue(value, "otelcol_exporter_queue_size", signal.exporter) === 4 &&
            metricValue(value, signal.enqueueFailureMetric, signal.exporter) === 4 &&
            receiverMetricValue(value, signal.receiverRefusalMetric) === 4,
        ),
    );
    for (const signal of saturationSignals) {
      expect(
        metricValue(saturatedMetrics, "otelcol_exporter_queue_capacity", signal.exporter),
      ).toBe(4);
    }
    await saveEvidence("saturation-metrics.txt", saturatedMetrics);
    expect(await fetchText(`http://127.0.0.1:${saturation.healthPort}/health`)).toContain(
      "Server available",
    );

    startSink(`${runId}-saturation-sink`, saturationSinkConfig, saturationReceipts);
    const saturationReceiptPath = join(saturationReceipts, "otlp.jsonl");
    await waitForText(
      () => readFile(saturationReceiptPath, "utf8"),
      (value) =>
        saturationResults.every((result) =>
          result.acceptedNames.every((name) =>
            result.signal === "metrics"
              ? value.includes(name.replaceAll("-", "."))
              : value.includes(name),
          ),
        ),
    );
    await waitForSustainedEmptyQueues(saturation.metricsPort);
    const finalSaturationReceipts = await readFile(saturationReceiptPath, "utf8");
    for (const result of saturationResults) {
      for (const name of result.allNames) {
        const receiptName = result.signal === "metrics" ? name.replaceAll("-", ".") : name;
        const expectedCount = result.acceptedNames.includes(name) ? 1 : 0;
        expect(receiptCount(finalSaturationReceipts, receiptName)).toBe(expectedCount);
      }
    }
    await saveEvidence("saturation-final-receipts.jsonl", finalSaturationReceipts);
    await saveEvidence(
      "collector-logs.txt",
      [
        dockerLogs(`${runId}-source-restarted`),
        dockerLogs(`${runId}-sink`),
        dockerLogs(`${runId}-saturation-source`),
        dockerLogs(`${runId}-saturation-sink`),
      ].join("\n"),
    );
  }, 120_000);

  for (const scenario of collectorCleanupScenarios) {
    test(`cleans recovery resources for ${scenario.name}`, async () => {
      const controlRoot = await mkdtemp(join(tmpdir(), "collector-cleanup-test-"));
      const readyFile = join(controlRoot, "ready.json");
      const child = Bun.spawn(
        ["bun", "test", "packages/cli/test/CollectorRecovery.bun.test.ts", "--timeout", "30000"],
        {
          cwd: projectRoot,
          env: {
            ...process.env,
            OBSERVABILITY_COLLECTOR_RECOVERY: "0",
            OBSERVABILITY_COLLECTOR_RECOVERY_ARTIFACT_ROOT: "",
            OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_TEST: "1",
            OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_SCENARIO: scenario.scenario,
            OBSERVABILITY_COLLECTOR_RECOVERY_SIGNAL_READY_FILE: readyFile,
          },
          stdout: "ignore",
          stderr: "ignore",
        },
      );
      let childRoot = "";
      let childContainer = "";
      let childNetwork = "";
      let childRunId = "";
      let exited = false;
      try {
        await waitForFile(readyFile);
        const content: unknown = JSON.parse(await readFile(readyFile, "utf8"));
        const ready = decodeSignalCleanupReady(content);
        childRoot = ready.root ?? "";
        childContainer = ready.container ?? "";
        childNetwork = ready.network ?? "";
        childRunId = ready.runId;
        for (const signal of scenario.signals) {
          child.kill(signal);
        }
        const exitCode = await child.exited;
        exited = true;
        expect(exitCode).toBe(scenario.expectedExitCode);
        if (childRoot !== "") {
          await waitForAbsence(childRoot);
        }
        const remainingRoots = (await readdir(tmpdir())).filter((entry) =>
          entry.startsWith(`${childRunId}-`),
        );
        const remainingContainers = runDocker([
          "ps",
          "--all",
          "--filter",
          `name=${childRunId}`,
          "--format",
          "{{.Names}}",
        ]);
        const remainingNetworks = runDocker([
          "network",
          "ls",
          "--filter",
          `name=${childRunId}`,
          "--format",
          "{{.Name}}",
        ]);
        expect(remainingRoots).toEqual([]);
        expect(remainingContainers).toBe("");
        expect(remainingNetworks).toBe("");
      } finally {
        if (!exited) {
          child.kill("SIGKILL");
          await child.exited;
        }
        if (childContainer !== "") {
          Bun.spawnSync(["docker", "rm", "--force", childContainer], {
            stdout: "ignore",
            stderr: "ignore",
          });
        }
        if (childNetwork !== "") {
          Bun.spawnSync(["docker", "network", "rm", childNetwork], {
            stdout: "ignore",
            stderr: "ignore",
          });
        }
        if (childRoot !== "") {
          await rm(childRoot, { recursive: true, force: true });
        }
        await rm(controlRoot, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
