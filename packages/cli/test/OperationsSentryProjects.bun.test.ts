import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ambiguousMutation, RemoteApiError } from "../src/ProviderApis.ts";

const roots: Array<string> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await Bun.$`rm -rf ${root}`.quiet();
});

type SentryProjectFixture = {
  readonly slug: string;
  readonly exists: boolean;
  readonly keys: boolean;
  readonly redirectTo?: string;
};

const datasets = ["traces", "logs", "metrics"].map((signal, index) => ({
  id: `dataset-${index}`,
  name: `checkout-prod-${signal}`,
  description: signal,
  kind: signal === "metrics" ? "otel:metrics:v1" : "axiom:events:v1",
  retentionDays: 30,
  useRetentionPeriod: true,
  edgeDeployment: "edge-test",
}));

const tokens = [
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
];

const manifest = (sentry: string) =>
  `version: 1\ncontractVersion: 1\nservice: checkout\nenvironments: [prod]\nretention:\n  - environment: prod\n    days: 30\ndashboards: []\nmonitors: []\nsentry:\n${sentry}`;

type RunOptions = {
  readonly apply: boolean;
  readonly collectorTokenExists: boolean;
  readonly storedSentryProject?: string;
};

const runPlan = async (
  sentryManifest: string,
  projects: ReadonlyArray<SentryProjectFixture>,
  options: RunOptions = { apply: false, collectorTokenExists: true },
) => {
  const root = await mkdtemp(join(tmpdir(), "observability-operations-sentry-projects-"));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, "home");
  await mkdir(join(project, "observability"), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(project, "observability", "operations.yaml"), manifest(sentryManifest));
  await writeFile(
    join(project, "observability", "contract.json"),
    '{"index":1,"contractVersion":1,"service":"checkout","events":[],"metrics":[],"aliases":[]}\n',
  );
  let collectorTokenExists = options.collectorTokenExists;
  const axiom = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v2/tokens" && request.method === "POST") {
        collectorTokenExists = true;
        return Response.json({ id: "token-id", token: "ingest-secret" }, { status: 201 });
      }
      if (path === "/v2/tokens") return Response.json(collectorTokenExists ? tokens : []);
      return Response.json(datasets);
    },
  });
  const requests: Array<string> = [];
  const sentry = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push(`${request.method} ${path}`);
      const match = /^\/api\/0\/projects\/acme\/([^/]+)\/(keys\/)?$/.exec(path);
      const fixture = projects.find((candidate) => candidate.slug === match?.[1]);
      if (match === null || fixture === undefined) return new Response("missing", { status: 404 });
      if (fixture.redirectTo !== undefined) {
        return new Response(null, {
          status: 302,
          headers: { location: `/api/0/projects/acme/${fixture.redirectTo}/${match[2] ?? ""}` },
        });
      }
      if (!fixture.exists) return new Response("missing", { status: 404 });
      if (match[2] !== undefined) {
        return Response.json(
          fixture.keys ? [{ dsn: { public: "https://public@sentry.example/1" } }] : [],
        );
      }
      return Response.json({ slug: match[1], name: match[1] });
    },
  });
  const credentialsPath = join(home, "credentials.json");
  await writeFile(
    credentialsPath,
    `${JSON.stringify({
      version: 3,
      axiom: { token: "axiom-admin", organizationId: "org" },
      sentry: {
        token: "sentry-admin",
        organization: "acme",
        team: "platform",
        baseUrl: `http://127.0.0.1:${sentry.port}`,
      },
      environments:
        options.storedSentryProject === undefined
          ? []
          : [
              {
                project: "checkout",
                environment: "prod",
                providers: {
                  type: "sentry",
                  sentry: {
                    project: options.storedSentryProject,
                    dsn: "https://stored@sentry.example/1",
                  },
                },
              },
            ],
      pendingAxiomMutations: [],
    })}\n`,
    { mode: 0o600 },
  );
  await chmod(credentialsPath, 0o600);
  const run = async (args: ReadonlyArray<string>) => {
    const processHandle = Bun.spawn(
      [
        "bun",
        "packages/cli/src/main.ts",
        "ops",
        ...args,
        "--dir",
        project,
        "--json",
        "--axiom-edge-deployment",
        "edge-test",
      ],
      {
        cwd: join(import.meta.dir, "../../.."),
        env: {
          ...process.env,
          NODE_ENV: "test",
          OBSERVABILITY_HOME: home,
          OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: `http://127.0.0.1:${axiom.port}`,
          OBSERVABILITY_CLI_REQUEST_TIMEOUT_MILLISECONDS: "1000",
        },
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
  try {
    const planned = await run(["plan"]);
    if (!options.apply || planned.exitCode !== 0)
      return { ...planned, requests, applied: undefined };
    const digest: string = JSON.parse(planned.stdout).digest;
    const applied = await run([
      "apply",
      "--plan",
      join(project, ".observability", `plan-${digest}.json`),
    ]);
    return { ...planned, requests, applied };
  } finally {
    await axiom.stop(true);
    await sentry.stop(true);
  }
};

const sentryActions = (stdout: string): ReadonlyArray<{ readonly id: string }> =>
  JSON.parse(stdout).actions.filter(
    (action: { readonly provider: string }) => action.provider === "Sentry",
  );

describe("operations Sentry projects", () => {
  test("reports a renamed Sentry project instead of a network failure", async () => {
    const result = await runPlan("  enabled: true\n", [
      { slug: "checkout", exists: true, keys: true, redirectTo: "checkout-api" },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain("could not be reached");
    expect(result.stderr).toContain("OBS_CLI_REMOTE_REDIRECTED");
    expect(result.stderr).toContain("Sentry project checkout was renamed or moved");
    expect(result.stderr).toContain("/api/0/projects/acme/checkout-api/");
    expect(result.stderr).toContain("sentry.projects");
    expect(result.stderr).not.toContain("sentry-admin");
  });

  test("defaults the Sentry project to the service", async () => {
    const result = await runPlan("  enabled: true\n", [
      { slug: "checkout", exists: true, keys: true },
    ]);
    expect(result.exitCode).toBe(0);
    expect(sentryActions(result.stdout)).toEqual([]);
    expect(result.requests).toEqual([
      "GET /api/0/projects/acme/checkout/",
      "GET /api/0/projects/acme/checkout/keys/",
    ]);
  });

  test("checks every declared Sentry project", async () => {
    const result = await runPlan("  enabled: true\n  projects: [checkout-api, checkout-web]\n", [
      { slug: "checkout-api", exists: true, keys: true },
      { slug: "checkout-web", exists: true, keys: true },
    ]);
    expect(result.exitCode).toBe(0);
    expect(sentryActions(result.stdout)).toEqual([]);
    expect(result.requests).toEqual([
      "GET /api/0/projects/acme/checkout-api/",
      "GET /api/0/projects/acme/checkout-api/keys/",
      "GET /api/0/projects/acme/checkout-web/",
      "GET /api/0/projects/acme/checkout-web/keys/",
    ]);
  });

  test("rejects a declared Sentry project that is missing", async () => {
    const result = await runPlan("  enabled: true\n  projects: [checkout-api, checkout-web]\n", [
      { slug: "checkout-api", exists: true, keys: true },
      { slug: "checkout-web", exists: false, keys: false },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE");
    expect(result.stderr).toContain("Sentry project checkout-web");
    expect(result.requests.some((request) => request.startsWith("POST"))).toBe(false);
  });

  test("rejects a declared Sentry project without a client key", async () => {
    const result = await runPlan("  enabled: true\n  projects: [checkout-api]\n", [
      { slug: "checkout-api", exists: true, keys: false },
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE");
    expect(result.stderr).toContain("Sentry project checkout-api");
  });

  test("provisions a declared-project environment without the canonical Sentry project", async () => {
    const result = await runPlan(
      "  enabled: true\n  projects: [checkout-api]\n",
      [{ slug: "checkout-api", exists: true, keys: true }],
      { apply: true, collectorTokenExists: false },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout).actions).toContainEqual(
      expect.objectContaining({ capability: "ingestion-token", kind: "create" }),
    );
    expect(sentryActions(result.stdout)).toEqual([]);
    expect(result.applied?.exitCode).toBe(0);
    expect(result.requests.some((request) => request.startsWith("POST"))).toBe(false);
    expect(result.requests.every((request) => request.includes("/checkout-api/"))).toBe(true);
  });

  test("rejects a stored environment DSN from an undeclared Sentry project", async () => {
    const result = await runPlan(
      "  enabled: true\n  projects: [checkout-api]\n",
      [{ slug: "checkout-api", exists: true, keys: true }],
      { apply: false, collectorTokenExists: true, storedSentryProject: "checkout" },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_DRIFT_DETECTED");
    expect(result.stderr).toContain("Sentry project checkout");
    expect(result.stderr).not.toContain("stored@sentry.example");
    expect(result.requests).toEqual([]);
  });

  test("accepts a stored environment DSN from a declared Sentry project", async () => {
    const result = await runPlan(
      "  enabled: true\n  projects: [checkout-api]\n",
      [{ slug: "checkout-api", exists: true, keys: true }],
      { apply: false, collectorTokenExists: true, storedSentryProject: "checkout-api" },
    );
    expect(result.exitCode).toBe(0);
    expect(sentryActions(result.stdout)).toEqual([]);
  });

  test("treats a redirected mutation as an unknown outcome", () => {
    const redirected = new RemoteApiError({
      code: "OBS_CLI_REMOTE_REDIRECTED",
      message: "redirected",
      provider: "Axiom",
      status: 303,
      cause: 303,
    });
    expect(ambiguousMutation(redirected)).toBe(true);
  });

  test.each([
    ["an empty list", "  projects: []\n"],
    ["duplicates", "  projects: [checkout-api, checkout-api]\n"],
    ["an invalid slug", "  projects: [Checkout API]\n"],
  ])("rejects %s of Sentry projects", async (_name, projects) => {
    const result = await runPlan(`  enabled: true\n${projects}`, []);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_CLI_MANIFEST_INVALID");
    expect(result.requests).toEqual([]);
  });
});
