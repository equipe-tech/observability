import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: Array<string> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await Bun.$`rm -rf ${root}`.quiet();
});

const multiStepTimeoutMilliseconds = 120_000;
const criticalNotifier = "notifier-critical-7Qx";
const warningNotifier = "notifier-warning-9Lm";
const initialDashboardVersion = "9007199254740993123";

const contract = {
  index: 1,
  contractVersion: 1,
  service: "checkout",
  events: [
    {
      name: "payment.attempt",
      kind: "operation",
      attributes: ["payment.provider", "payment.result"],
      attributeClassifications: [
        { name: "payment.provider", classification: "public" },
        { name: "payment.result", classification: "public" },
      ],
    },
  ],
  metrics: [
    { name: "payment.count", kind: "counter", unit: "1", attributes: ["payment.result"] },
    { name: "payment.latency", kind: "histogram", unit: "ms", attributes: ["payment.provider"] },
  ],
  aliases: [],
};

const monitorOperations = (id: string, notifier: string) => `    owner: payments
    window: 10m
    thresholdRationale: Initial conservative threshold until 30 days of history exist.
    thresholdReviewDate: 2026-12-01
    cooldown: 15m
    notifierRef: env:${notifier}
    runbookUrl: https://example.com/runbooks/${id}
    syntheticTest:
      procedure: Emit one policy-safe canary in the staging dataset.
      expected: The monitor fires after one evaluation window.
    recovery:
      procedure: Stop the canary and confirm two healthy windows.
`;

const manifest = `version: 1
contractVersion: 1
service: checkout
environments: [prod]
retention:
  - environment: prod
    days: 30
sentry:
  enabled: false
dashboards:
  - id: payments
    title: Payments
    panels:
      - id: attempts
        title: Attempts by provider
        sources:
          - kind: event
            name: payment.attempt
        query: signal(logs) | where event.name == "payment.attempt" | summarize count() by payment.provider, bin(timestamp, 5m)
      - id: latency
        title: Latency p95
        sources:
          - kind: metric
            name: payment.latency
        query: signal(metrics) | where metric.name == "payment.latency" | summarize quantile(value, 0.95) by payment.provider
monitors:
  - id: payment-failures
    title: Payment failures
    source:
      kind: metric
      name: payment.count
    query: signal(metrics) | where metric.name == "payment.count" and payment.result == "failed" | summarize sum(value)
    severity: critical
    threshold:
      operator: ">="
      value: 5
      unit: count
    noDataBehavior: ok
${monitorOperations("payment-failures", "AXIOM_NOTIFIER_CRITICAL_ID")}  - id: payment-silence
    title: Payment silence
    source:
      kind: event
      name: payment.attempt
    query: signal(logs) | where event.name == "payment.attempt" | summarize count()
    severity: warning
    threshold:
      operator: "<"
      value: 1
      unit: count
    noDataBehavior: alert
${monitorOperations("payment-silence", "AXIOM_NOTIFIER_WARNING_ID")}`;

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  args: ReadonlyArray<string>,
  home: string,
  baseUrl: string,
  notifiers: boolean = true,
): Promise<CommandResult> => {
  const environment: { [name: string]: string | undefined } = {
    ...process.env,
    NODE_ENV: "test",
    OBSERVABILITY_HOME: home,
    OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: baseUrl,
    OBSERVABILITY_CLI_REQUEST_TIMEOUT_MILLISECONDS: "1000",
  };
  if (notifiers) {
    environment.AXIOM_NOTIFIER_CRITICAL_ID = criticalNotifier;
    environment.AXIOM_NOTIFIER_WARNING_ID = warningNotifier;
  } else {
    delete environment.AXIOM_NOTIFIER_CRITICAL_ID;
    delete environment.AXIOM_NOTIFIER_WARNING_ID;
  }
  const processHandle = Bun.spawn(
    ["bun", "packages/cli/src/main.ts", ...args, "--axiom-edge-deployment", "edge-test"],
    {
      cwd: join(import.meta.dir, "../../.."),
      env: environment,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
};

type ProviderChart = {
  id: string;
  name?: string;
  type: string;
  datasetId?: string;
  text?: string;
  colorScheme?: string;
  query?: { apl?: string; mpl?: string; queryOptions?: ProviderQueryOptions };
};

type ProviderQueryOptions = {
  aggChartOpts: string;
  containsTimeFilter: string;
  datasets: string;
  editorContent: string;
  endTime: string;
  quickRange: string;
  resultsHistogram: string;
  selection: string;
  shownColumns: string;
  startTime: string;
};

const providerDefaultQueryOptions: ProviderQueryOptions = {
  aggChartOpts: "{}",
  containsTimeFilter: "false",
  datasets: "[]",
  editorContent: "",
  endTime: "",
  quickRange: "",
  resultsHistogram: "",
  selection: "",
  shownColumns: "",
  startTime: "",
};

const omitFalseFields = (monitor: ProviderMonitor): string =>
  JSON.stringify(monitor, (_key, value) => (value === false ? undefined : value));

type ProviderLayout = {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  moved?: boolean;
  static?: boolean;
};

type ProviderDashboardDocument = {
  name: string;
  owner: string;
  description: string;
  charts: Array<ProviderChart>;
  layout: Array<ProviderLayout>;
  refreshTime: number;
  schemaVersion: number;
  timeWindowStart: string;
  timeWindowEnd: string;
  uid?: string;
  sharedByOrg?: string;
};

type StoredDashboard = {
  id: string;
  version: string;
  dashboard: ProviderDashboardDocument;
};

type ProviderMonitor = {
  id: string;
  name: string;
  description: string;
  type: string;
  operator: string;
  threshold: number;
  aplQuery: string;
  notifierIds: Array<string>;
  alertOnNoData?: boolean;
  intervalMinutes?: number;
  rangeMinutes?: number;
  notifyEveryRun?: boolean;
  disabled?: boolean;
  disabledUntil?: string;
  createdAt?: string;
  updatedAt?: string;
};

const makeAxiomServer = () => {
  const datasets = ["traces", "logs", "metrics"].map((signal, index) => ({
    id: `dataset-${index}`,
    name: `checkout-prod-${signal}`,
    description: signal,
    kind: signal === "metrics" ? "otel:metrics:v1" : "axiom:events:v1",
    retentionDays: 30,
    useRetentionPeriod: true,
    edgeDeployment: "edge-test",
  }));
  const dashboards = new Map<string, StoredDashboard>();
  const monitors: Array<ProviderMonitor> = [];
  const requests: Array<string> = [];
  const writes: Array<{ readonly method: string; readonly path: string; readonly body: string }> =
    [];
  let tokenCreated = false;
  let nextId = 0;
  const faults = {
    ambiguousMonitorPosts: 0,
    droppedMonitorPosts: 0,
    hiddenMonitorReads: 0,
    consoleEditOnRead: 0,
    dashboardEditOnRead: 0,
    rejectedDashboardPosts: 0,
  };
  const providerChart = (chart: ProviderChart): ProviderChart => ({
    ...chart,
    colorScheme: "Classic",
    query: { ...chart.query, queryOptions: providerDefaultQueryOptions },
  });
  const storeDashboard = (
    uid: string,
    id: string,
    version: string,
    document: ProviderDashboardDocument,
  ) => {
    dashboards.set(uid, {
      id,
      version,
      dashboard: {
        ...document,
        charts: document.charts.map(providerChart),
        layout: document.layout.map((item) => ({ ...item, moved: false, static: false })),
        uid,
        sharedByOrg: "",
      },
    });
  };
  const envelope = (uid: string, stored: StoredDashboard): string =>
    JSON.stringify({
      createdAt: "2026-09-01T00:00:00Z",
      createdBy: "operator",
      dashboard: {
        ...stored.dashboard,
        version: stored.version,
        previewSettings: { version: 1.5 },
      },
      id: stored.id,
      uid,
      updatedAt: "2026-09-02T00:00:00Z",
      updatedBy: "operator",
      version: "__VERSION__",
    }).replace('"__VERSION__"', stored.version);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      requests.push(`${request.method} ${path}`);
      const body = request.method === "GET" ? "" : await request.text();
      if (request.method !== "GET") writes.push({ method: request.method, path, body });
      if (request.headers.get("authorization") !== "Bearer secret-token") {
        return new Response("unauthorized", { status: 401 });
      }
      if (path === "/v2/datasets" && request.method === "GET") return Response.json(datasets);
      if (path === "/v2/tokens") {
        if (request.method === "GET") {
          return Response.json(
            tokenCreated
              ? [
                  {
                    id: "token-id",
                    name: "checkout-prod-collector",
                    description: "collector",
                    datasetCapabilities: {
                      "checkout-prod-traces": { ingest: ["create"] },
                      "checkout-prod-logs": { ingest: ["create"] },
                      "checkout-prod-metrics": { ingest: ["create"] },
                    },
                    orgCapabilities: {},
                    viewCapabilities: {},
                  },
                ]
              : [],
          );
        }
        tokenCreated = true;
        return Response.json({ id: "token-id", token: "ingest-secret" }, { status: 201 });
      }
      const dashboardUid = /^\/v2\/dashboards\/uid\/([^/]+)$/.exec(path)?.[1];
      if (dashboardUid !== undefined) {
        const uid = decodeURIComponent(dashboardUid);
        if (request.method === "GET" && faults.dashboardEditOnRead > 0) {
          faults.dashboardEditOnRead -= 1;
          const edited = dashboards.get(uid);
          if (faults.dashboardEditOnRead === 0 && edited !== undefined) {
            edited.version = (BigInt(edited.version) + 1n).toString();
            edited.dashboard = {
              ...edited.dashboard,
              charts: edited.dashboard.charts.map((chart) => ({ ...chart, colorScheme: "Dark" })),
            };
          }
        }
        const stored = dashboards.get(uid);
        if (request.method === "GET") {
          return stored === undefined
            ? Response.json({ message: "not found" }, { status: 404 })
            : new Response(envelope(uid, stored), {
                headers: { "content-type": "application/json" },
              });
        }
        if (request.method === "PUT") {
          if (stored === undefined) return Response.json({}, { status: 404 });
          const version = /,"version":([0-9]+)}$/.exec(body)?.[1];
          if (version !== stored.version) {
            return Response.json({ status: 412, title: "Version conflict" }, { status: 412 });
          }
          const update = JSON.parse(body);
          storeDashboard(uid, stored.id, (BigInt(version) + 1n).toString(), update.dashboard);
          return Response.json({ status: "updated" });
        }
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/v2/dashboards" && request.method === "POST") {
        if (faults.rejectedDashboardPosts > 0) {
          faults.rejectedDashboardPosts -= 1;
          return Response.json({ message: "invalid dashboard" }, { status: 400 });
        }
        const create = JSON.parse(body);
        if (dashboards.has(create.uid)) {
          return Response.json({ status: 409, title: "Conflict" }, { status: 409 });
        }
        nextId += 1;
        storeDashboard(
          create.uid,
          `dashboard-${nextId}`,
          initialDashboardVersion,
          create.dashboard,
        );
        return Response.json({ status: "created" }, { status: 201 });
      }
      if (path === "/v2/monitors" && request.method === "GET") {
        if (faults.consoleEditOnRead > 0) {
          faults.consoleEditOnRead -= 1;
          if (faults.consoleEditOnRead === 0) {
            for (const monitor of monitors) {
              monitor.disabled = true;
              monitor.updatedAt = "2026-09-03T00:00:00Z";
            }
          }
        }
        const hidden = faults.hiddenMonitorReads > 0;
        if (hidden) faults.hiddenMonitorReads -= 1;
        const visible = hidden
          ? monitors.filter((monitor) => monitor.id === "monitor-unmanaged")
          : monitors;
        return new Response(`[${visible.map(omitFalseFields).join(",")}]`, {
          headers: { "content-type": "application/json" },
        });
      }
      if (path === "/v2/monitors" && request.method === "POST") {
        const document = JSON.parse(body);
        if (faults.droppedMonitorPosts > 0) {
          faults.droppedMonitorPosts -= 1;
          return new Response("upstream timeout", { status: 503 });
        }
        nextId += 1;
        const { mplQuery, aplQuery, ...settings } = document;
        const monitor = {
          ...settings,
          id: `monitor-${nextId}`,
          aplQuery: mplQuery ?? aplQuery,
          createdAt: "2026-09-01T00:00:00Z",
          createdBy: "operator",
          updatedAt: `2026-09-01T00:00:${String(nextId).padStart(2, "0")}Z`,
          disabled: false,
        };
        monitors.push(monitor);
        if (faults.ambiguousMonitorPosts > 0) {
          faults.ambiguousMonitorPosts -= 1;
          return new Response("upstream timeout", { status: 503 });
        }
        return Response.json(monitor);
      }
      const monitorId = /^\/v2\/monitors\/([^/]+)$/.exec(path)?.[1];
      if (monitorId !== undefined && request.method === "PUT") {
        const index = monitors.findIndex((monitor) => monitor.id === monitorId);
        if (index < 0) return Response.json({}, { status: 404 });
        const { mplQuery, aplQuery, ...settings } = JSON.parse(body);
        const current = monitors[index];
        monitors[index] = {
          ...settings,
          id: monitorId,
          createdAt: current?.createdAt,
          updatedAt: `2026-09-02T00:00:${String(writes.length).padStart(2, "0")}Z`,
          aplQuery: mplQuery ?? aplQuery,
        };
        return Response.json(monitors[index]);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    faults,
    baseUrl: `http://127.0.0.1:${server.port}`,
    dashboards,
    monitors,
    requests,
    writes,
    storeDashboard,
    stop: () => server.stop(true),
  };
};

const createProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "observability-axiom-resources-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, "observability"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(project, "observability", "operations.yaml"), manifest);
  await writeFile(join(project, "observability", "contract.json"), `${JSON.stringify(contract)}\n`);
  const credentialsPath = join(home, "credentials.json");
  await writeFile(
    credentialsPath,
    '{"version":3,"axiom":{"token":"secret-token","organizationId":"org"},"environments":[],"pendingAxiomMutations":[]}\n',
    { mode: 0o600 },
  );
  await chmod(credentialsPath, 0o600);
  return { project, home };
};

const planFile = async (project: string, digest: string): Promise<string> => {
  const name = (await readdir(join(project, ".observability"))).find(
    (entry) => entry === `plan-${digest}.json`,
  );
  if (name === undefined) throw new Error(`Plan ${digest} was not written.`);
  return join(project, ".observability", name);
};

const resourceWrites = (
  writes: ReadonlyArray<{ readonly method: string; readonly path: string }>,
): ReadonlyArray<string> =>
  writes
    .filter(
      (write) => write.path.startsWith("/v2/dashboards") || write.path.startsWith("/v2/monitors"),
    )
    .map((write) => `${write.method} ${write.path}`);

describe("operations CLI Axiom dashboards and monitors", () => {
  test(
    "creates, converges and detects console drift without touching unmanaged resources",
    async () => {
      const { project, home } = await createProject();
      const axiom = makeAxiomServer();
      axiom.storeDashboard("unrelated-dashboard", "dashboard-unrelated", "42", {
        name: "Hand-made dashboard",
        owner: "someone",
        description: "console",
        charts: [{ id: "note", type: "Note", text: "hello" }],
        layout: [{ i: "note", x: 0, y: 0, w: 12, h: 2 }],
        refreshTime: 60,
        schemaVersion: 2,
        timeWindowStart: "qr-now-1h",
        timeWindowEnd: "qr-now",
      });
      axiom.monitors.push({
        id: "monitor-unmanaged",
        name: "Payment failures (prod)",
        description: "created in the console",
        type: "Threshold",
        operator: "Above",
        threshold: 1,
        aplQuery: "['checkout-prod-logs'] | count",
        notifierIds: ["manual-notifier"],
      });
      const unmanagedDashboard = JSON.stringify(axiom.dashboards.get("unrelated-dashboard"));
      const unmanagedMonitor = JSON.stringify(axiom.monitors[0]);
      try {
        const missingNotifier = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
          false,
        );
        expect(missingNotifier.exitCode).not.toBe(0);
        expect(missingNotifier.stderr).toContain("OBS_CLI_NOTIFIER_UNRESOLVED");
        expect(missingNotifier.stderr).toContain("AXIOM_NOTIFIER_CRITICAL_ID");

        const planned = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
        );
        expect(planned.stderr).toBe("");
        expect(planned.exitCode).toBe(0);
        const plan = JSON.parse(planned.stdout);
        const resourceActions = plan.actions
          .filter((action: { capability: string }) =>
            ["dashboard", "monitor"].includes(action.capability),
          )
          .map((action: { id: string; kind: string; resource: string }) => [
            action.id,
            action.kind,
            action.resource,
          ]);
        expect(resourceActions).toEqual([
          ["axiom.dashboard.prod.payments", "create", "checkout-prod-payments"],
          ["axiom.monitor.prod.payment-failures", "create", "checkout-prod-payment-failures"],
          ["axiom.monitor.prod.payment-silence", "create", "checkout-prod-payment-silence"],
        ]);
        expect(plan.pendingManualActions).toEqual([]);
        const planPath = await planFile(project, plan.digest);
        const planContent = await readFile(planPath, "utf8");
        for (const secret of [
          criticalNotifier,
          warningNotifier,
          "secret-token",
          "summarize",
          "interpolate_cumulative_histogram",
          "checkout-prod-logs']",
          "status",
        ]) {
          expect(planContent).not.toContain(secret);
        }
        expect(resourceWrites(axiom.writes)).toEqual([]);

        const applied = await runCli(
          ["ops", "apply", "--dir", project, "--plan", planPath, "--json"],
          home,
          axiom.baseUrl,
        );
        expect(applied.stderr).toBe("");
        expect(applied.exitCode).toBe(0);
        expect(resourceWrites(axiom.writes)).toEqual([
          "POST /v2/dashboards",
          "POST /v2/monitors",
          "POST /v2/monitors",
        ]);
        const dashboard = axiom.dashboards.get("checkout-prod-payments");
        expect(dashboard?.dashboard.owner).toBe("X-AXIOM-EVERYONE");
        expect(dashboard?.dashboard.description).toBe(
          "observability-managed:checkout/prod/payments",
        );
        expect(JSON.stringify(dashboard?.dashboard.charts)).toContain(
          "['checkout-prod-logs']\\n| where ['attributes.event.name'] == 'payment.attempt'\\n| summarize count() by ['attributes.payment.provider'], bin(_time, 5m)",
        );
        expect(JSON.stringify(dashboard?.dashboard.charts)).toContain(
          '"mpl":"`checkout-prod-metrics`:`payment.latency`\\n| bucket by `payment.provider` using interpolate_cumulative_histogram(rate, 0.95)"',
        );
        const failures = axiom.monitors.find((monitor) => monitor.id === "monitor-2");
        expect(failures).toMatchObject({
          name: "Payment failures (prod)",
          type: "Threshold",
          operator: "AboveOrEqual",
          threshold: 5,
          alertOnNoData: false,
          intervalMinutes: 5,
          rangeMinutes: 10,
          notifierIds: [criticalNotifier],
          notifyEveryRun: false,
          aplQuery:
            '`checkout-prod-metrics`:`payment.count`\n| where `payment.result` == "failed"\n| map increase\n| align using sum\n| group using sum',
        });
        expect(String(failures?.description)).toContain(
          "runbook: https://example.com/runbooks/payment-failures",
        );
        const silence = axiom.monitors.find((monitor) => monitor.id === "monitor-3");
        expect(silence).toMatchObject({
          operator: "Below",
          alertOnNoData: true,
          notifierIds: [warningNotifier],
        });

        const confirmationResult = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
        );
        const confirmationPlan = JSON.parse(confirmationResult.stdout);
        expect(
          confirmationPlan.actions.filter((action: { capability: string }) =>
            ["dashboard", "monitor"].includes(action.capability),
          ),
        ).toEqual([]);
        const confirmed = await runCli(
          [
            "ops",
            "apply",
            "--dir",
            project,
            "--plan",
            await planFile(project, confirmationPlan.digest),
            "--confirm-manual",
            "axiom.retention.prod",
            "--confirm-manual",
            "axiom.correlation.prod",
          ],
          home,
          axiom.baseUrl,
        );
        expect(confirmed.stderr).toBe("");
        expect(confirmed.exitCode).toBe(0);
        expect(
          (await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl)).exitCode,
        ).toBe(0);

        const writesBeforeSecondApply = resourceWrites(axiom.writes).length;
        const secondResult = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
        );
        const secondPlan = JSON.parse(secondResult.stdout);
        expect(secondPlan.actions).toEqual([]);
        const secondApply = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, secondPlan.digest)],
          home,
          axiom.baseUrl,
        );
        expect(secondApply.exitCode).toBe(0);
        expect(resourceWrites(axiom.writes)).toHaveLength(writesBeforeSecondApply);

        const managedMonitor = axiom.monitors.find((monitor) => monitor.id === "monitor-2");
        if (managedMonitor === undefined) throw new Error("Managed monitor is missing.");
        managedMonitor.disabled = true;
        managedMonitor.disabledUntil = "2026-10-01T00:00:00Z";
        const silenced = await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl);
        expect(silenced.exitCode).toBe(0);
        managedMonitor.threshold = 50;
        const managedDashboard = axiom.dashboards.get("checkout-prod-payments");
        if (managedDashboard === undefined) throw new Error("Managed dashboard is missing.");
        const editedCharts = managedDashboard.dashboard.charts.map((chart, index) =>
          index === 0 ? { ...chart, name: "Renamed in the console" } : chart,
        );
        managedDashboard.dashboard = { ...managedDashboard.dashboard, charts: editedCharts };
        const drift = await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl);
        expect(drift.exitCode).not.toBe(0);
        expect(drift.stderr).toContain("OBS_CLI_DRIFT_DETECTED");

        const repairResult = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
        );
        const repairPlan = JSON.parse(repairResult.stdout);
        expect(
          repairPlan.actions.map((action: { id: string; kind: string }) => [
            action.id,
            action.kind,
          ]),
        ).toEqual([
          ["axiom.dashboard.prod.payments", "update"],
          ["axiom.monitor.prod.payment-failures", "update"],
        ]);
        const repaired = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, repairPlan.digest)],
          home,
          axiom.baseUrl,
        );
        expect(repaired.stderr).toBe("");
        expect(repaired.exitCode).toBe(0);
        expect(resourceWrites(axiom.writes).slice(writesBeforeSecondApply)).toEqual([
          "PUT /v2/dashboards/uid/checkout-prod-payments",
          "PUT /v2/monitors/monitor-2",
        ]);
        expect(axiom.dashboards.get("checkout-prod-payments")?.version).toBe(
          (BigInt(initialDashboardVersion) + 1n).toString(),
        );
        expect(axiom.monitors.find((monitor) => monitor.id === "monitor-2")).toMatchObject({
          threshold: 5,
          disabled: true,
          disabledUntil: "2026-10-01T00:00:00Z",
        });
        expect(
          (await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl)).exitCode,
        ).toBe(0);

        const optionsDashboard = axiom.dashboards.get("checkout-prod-payments");
        if (optionsDashboard === undefined) throw new Error("Managed dashboard is missing.");
        optionsDashboard.dashboard = {
          ...optionsDashboard.dashboard,
          charts: optionsDashboard.dashboard.charts.map((chart) => ({
            ...chart,
            query: {
              ...chart.query,
              queryOptions: { ...providerDefaultQueryOptions, quickRange: "qr-now-7d" },
            },
          })),
        };
        const optionsDrift = await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl);
        expect(optionsDrift.exitCode).not.toBe(0);
        expect(optionsDrift.stderr).toContain("OBS_CLI_DRIFT_DETECTED");
        const optionsPlan = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          (
            await runCli(
              [
                "ops",
                "apply",
                "--dir",
                project,
                "--plan",
                await planFile(project, optionsPlan.digest),
              ],
              home,
              axiom.baseUrl,
            )
          ).exitCode,
        ).toBe(0);
        expect(
          (await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl)).exitCode,
        ).toBe(0);

        expect(JSON.stringify(axiom.dashboards.get("unrelated-dashboard"))).toBe(
          unmanagedDashboard,
        );
        expect(JSON.stringify(axiom.monitors[0])).toBe(unmanagedMonitor);
        expect(axiom.requests.filter((entry) => entry.startsWith("DELETE"))).toEqual([]);
        expect(
          axiom.writes.filter(
            (write) =>
              write.path.includes("unrelated-dashboard") ||
              write.path.includes("monitor-unmanaged"),
          ),
        ).toEqual([]);
        const statePath = join(home, "operations", "checkout.json");
        const state = await readFile(statePath, "utf8");
        expect(state).not.toContain(criticalNotifier);
        expect(state).not.toContain("summarize");
      } finally {
        await axiom.stop();
      }
    },
    multiStepTimeoutMilliseconds,
  );

  test(
    "refuses an unmanaged dashboard on the managed uid and rejects concurrent dashboard edits",
    async () => {
      const { project, home } = await createProject();
      const axiom = makeAxiomServer();
      axiom.storeDashboard("checkout-prod-payments", "dashboard-console", "7", {
        name: "Payments made by hand",
        owner: "someone",
        description: "console",
        charts: [],
        layout: [],
        refreshTime: 60,
        schemaVersion: 2,
        timeWindowStart: "qr-now-1h",
        timeWindowEnd: "qr-now",
      });
      const unmanaged = JSON.stringify(axiom.dashboards.get("checkout-prod-payments"));
      try {
        const refused = await runCli(
          ["ops", "plan", "--dir", project, "--json"],
          home,
          axiom.baseUrl,
        );
        expect(refused.exitCode).not.toBe(0);
        expect(refused.stderr).toContain("OBS_CLI_PROVIDER_RESOURCE_UNMANAGED");
        expect(JSON.stringify(axiom.dashboards.get("checkout-prod-payments"))).toBe(unmanaged);
        expect(axiom.writes.filter((write) => write.path.startsWith("/v2/dashboards"))).toEqual([]);

        axiom.dashboards.delete("checkout-prod-payments");
        const created = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          (
            await runCli(
              ["ops", "apply", "--dir", project, "--plan", await planFile(project, created.digest)],
              home,
              axiom.baseUrl,
            )
          ).exitCode,
        ).toBe(0);

        const managedDashboard2 = axiom.dashboards.get("checkout-prod-payments");
        if (managedDashboard2 === undefined) throw new Error("Managed dashboard is missing.");
        managedDashboard2.dashboard = { ...managedDashboard2.dashboard, name: "Renamed" };
        const update = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          update.actions.find(
            (action: { id: string }) => action.id === "axiom.dashboard.prod.payments",
          )?.kind,
        ).toBe("update");
        const writesBeforeConflict = axiom.writes.filter((write) => write.method === "PUT").length;
        axiom.faults.dashboardEditOnRead = 2;
        const concurrent = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, update.digest)],
          home,
          axiom.baseUrl,
        );
        expect(concurrent.stderr).toContain("OBS_CLI_AXIOM_RESOURCE_CONFLICT");
        expect(axiom.writes.filter((write) => write.method === "PUT")).toHaveLength(
          writesBeforeConflict,
        );
        expect(
          managedDashboard2.dashboard.charts.every((chart) => chart.colorScheme === "Dark"),
        ).toBe(true);
      } finally {
        await axiom.stop();
      }
    },
    multiStepTimeoutMilliseconds,
  );

  test(
    "never repeats an ambiguous monitor creation without destructive authorization",
    async () => {
      const { project, home } = await createProject();
      const axiom = makeAxiomServer();
      try {
        const planned = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        axiom.faults.ambiguousMonitorPosts = 1;
        const ambiguous = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, planned.digest)],
          home,
          axiom.baseUrl,
        );
        expect(ambiguous.exitCode).not.toBe(0);
        expect(ambiguous.stderr).toContain("OBS_CLI_APPLY_OUTCOME_UNKNOWN");
        const statePath = join(home, "operations", "checkout.json");
        expect(JSON.parse(await readFile(statePath, "utf8")).mutations).toContainEqual(
          expect.objectContaining({
            id: "axiom.monitor.prod.payment-failures",
            status: "outcome-unknown",
          }),
        );

        axiom.faults.hiddenMonitorReads = 1;
        const lagging = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          lagging.actions.find(
            (action: { id: string }) => action.id === "axiom.monitor.prod.payment-failures",
          )?.kind,
        ).toBe("destructive");
        const refused = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, lagging.digest)],
          home,
          axiom.baseUrl,
        );
        expect(refused.exitCode).not.toBe(0);
        expect(axiom.writes.filter((write) => write.path === "/v2/monitors")).toHaveLength(1);

        const converged = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          converged.actions
            .filter((action: { capability: string }) => action.capability === "monitor")
            .map((action: { id: string; kind: string }) => [action.id, action.kind]),
        ).toEqual([["axiom.monitor.prod.payment-silence", "create"]]);
        const finished = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, converged.digest)],
          home,
          axiom.baseUrl,
        );
        expect(finished.stderr).toBe("");
        expect(finished.exitCode).toBe(0);
        expect(axiom.writes.filter((write) => write.path === "/v2/monitors")).toHaveLength(2);
        expect(axiom.monitors).toHaveLength(2);

        const edited = axiom.monitors.find((monitor) => monitor.name === "Payment failures (prod)");
        if (edited === undefined) throw new Error("Managed monitor is missing.");
        edited.threshold = 9;
        const update = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(update.actions.map((action: { kind: string }) => action.kind)).toEqual(["update"]);
        axiom.faults.consoleEditOnRead = 2;
        const concurrent = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, update.digest)],
          home,
          axiom.baseUrl,
        );
        expect(concurrent.exitCode).not.toBe(0);
        expect(concurrent.stderr).toContain("OBS_CLI_AXIOM_RESOURCE_CONFLICT");
        expect(edited).toMatchObject({ threshold: 9, disabled: true });
        expect(axiom.writes.filter((write) => write.method === "PUT")).toEqual([]);
      } finally {
        await axiom.stop();
      }
    },
    multiStepTimeoutMilliseconds,
  );

  test(
    "recreates a monitor lost by an ambiguous creation only with destructive authorization",
    async () => {
      const { project, home } = await createProject();
      const axiom = makeAxiomServer();
      try {
        const planned = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        axiom.faults.droppedMonitorPosts = 1;
        const ambiguous = await runCli(
          ["ops", "apply", "--dir", project, "--plan", await planFile(project, planned.digest)],
          home,
          axiom.baseUrl,
        );
        expect(ambiguous.stderr).toContain("OBS_CLI_APPLY_OUTCOME_UNKNOWN");
        const verify = await runCli(["ops", "verify", "--dir", project], home, axiom.baseUrl);
        expect(verify.stderr).toContain("OBS_CLI_MUTATION_UNRESOLVED");
        const retry = JSON.parse(
          (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
        );
        expect(
          retry.actions
            .filter((action: { capability: string }) => action.capability === "monitor")
            .map((action: { id: string; kind: string }) => [action.id, action.kind]),
        ).toEqual([
          ["axiom.monitor.prod.payment-failures", "destructive"],
          ["axiom.monitor.prod.payment-silence", "create"],
        ]);
        const retryPath = await planFile(project, retry.digest);
        const refused = await runCli(
          ["ops", "apply", "--dir", project, "--plan", retryPath],
          home,
          axiom.baseUrl,
        );
        expect(refused.stderr).toContain("OBS_CLI_PLAN_DESTRUCTIVE");
        expect(axiom.monitors).toHaveLength(0);

        const monitorRetryKinds = async () => {
          const plan = JSON.parse(
            (await runCli(["ops", "plan", "--dir", project, "--json"], home, axiom.baseUrl)).stdout,
          );
          return {
            plan,
            kind: plan.actions.find(
              (action: { id: string }) => action.id === "axiom.monitor.prod.payment-failures",
            )?.kind,
          };
        };
        axiom.dashboards.delete("checkout-prod-payments");
        axiom.faults.rejectedDashboardPosts = 1;
        const earlierFailure = await monitorRetryKinds();
        expect(earlierFailure.kind).toBe("destructive");
        const failedEarlier = await runCli(
          [
            "ops",
            "apply",
            "--dir",
            project,
            "--plan",
            await planFile(project, earlierFailure.plan.digest),
            "--allow-destructive",
          ],
          home,
          axiom.baseUrl,
        );
        expect(failedEarlier.exitCode).not.toBe(0);
        expect(axiom.monitors).toHaveLength(0);

        axiom.faults.droppedMonitorPosts = 1;
        const secondRetry = await monitorRetryKinds();
        expect(secondRetry.kind).toBe("destructive");
        const secondAmbiguous = await runCli(
          [
            "ops",
            "apply",
            "--dir",
            project,
            "--plan",
            await planFile(project, secondRetry.plan.digest),
            "--allow-destructive",
          ],
          home,
          axiom.baseUrl,
        );
        expect(secondAmbiguous.stderr).toContain("OBS_CLI_APPLY_OUTCOME_UNKNOWN");

        const finalRetry = await monitorRetryKinds();
        expect(finalRetry.kind).toBe("destructive");
        const authorized = await runCli(
          [
            "ops",
            "apply",
            "--dir",
            project,
            "--plan",
            await planFile(project, finalRetry.plan.digest),
            "--allow-destructive",
          ],
          home,
          axiom.baseUrl,
        );
        expect(authorized.stderr).toBe("");
        expect(authorized.exitCode).toBe(0);
        expect(axiom.monitors.map((monitor) => monitor.name).sort()).toEqual([
          "Payment failures (prod)",
          "Payment silence (prod)",
        ]);
      } finally {
        await axiom.stop();
      }
    },
    multiStepTimeoutMilliseconds,
  );
});
