import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: Array<string> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await Bun.$`rm -rf ${root}`.quiet();
});

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = async (
  args: ReadonlyArray<string>,
  home: string,
  baseUrl: string,
): Promise<CommandResult> => {
  const processHandle = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      NODE_ENV: "test",
      OBSERVABILITY_HOME: home,
      OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL: baseUrl,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);
  return { exitCode, stdout, stderr };
};

describe("operations CLI", () => {
  test("plans without mutation, applies with read-back, and produces an empty second plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-operations-"));
    roots.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, "observability"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(project, "observability", "operations.yaml"),
      "version: 1\ncontractVersion: 1\nservice: checkout\nenvironments: [prod]\nretention:\n  - environment: prod\n    days: 30\ndashboards: []\nmonitors: []\nsentry:\n  enabled: false\n",
    );
    await writeFile(
      join(project, "observability", "contract.json"),
      '{"index":1,"contractVersion":1,"service":"checkout","events":[],"metrics":[],"aliases":[]}\n',
    );
    const credentialsPath = join(home, "credentials.json");
    await writeFile(
      credentialsPath,
      '{"version":3,"axiom":{"token":"secret-token","organizationId":"org"},"environments":[],"pendingAxiomMutations":[]}\n',
      { mode: 0o600 },
    );
    await chmod(credentialsPath, 0o600);

    const datasets: Array<{
      id: string;
      name: string;
      description: string;
      kind: string;
      retentionDays: number;
      useRetentionPeriod: boolean;
    }> = [
      {
        id: "prod-eu-isolation",
        name: "checkout-prod-eu-logs",
        description: "unrelated environment",
        kind: "axiom:events:v1",
        retentionDays: 90,
        useRetentionPeriod: true,
      },
    ];
    let mutations = 0;
    let skipReadBack = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v2/datasets") return new Response("missing", { status: 404 });
        if (request.method === "GET") return Response.json(datasets);
        mutations += 1;
        const body = await request.json();
        const document = JSON.stringify(body);
        const name = /"name":"([^"]+)"/.exec(document)?.[1] ?? "invalid";
        const kind = /"kind":"([^"]+)"/.exec(document)?.[1] ?? "invalid";
        const dataset = {
          id: `dataset-${datasets.length}`,
          name,
          description: `OpenTelemetry data for ${name}`,
          kind,
          retentionDays: 0,
          useRetentionPeriod: false,
        };
        if (!skipReadBack) datasets.push(dataset);
        return Response.json(dataset, { status: 201 });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const first = await runCli(["ops", "plan", "--dir", project, "--json"], home, baseUrl);
      expect(first.exitCode).toBe(0);
      expect(mutations).toBe(0);
      const firstPlan = JSON.parse(first.stdout);
      expect(
        firstPlan.actions.find((action: { id: string }) => action.id === "axiom.retention.prod")
          ?.kind,
      ).toBe("manual");
      expect(first.stdout).not.toContain("secret-token");
      const plans = await readdir(join(project, ".observability"));
      const planName = plans.find((name) => name.startsWith("plan-"));
      expect(planName).toBeDefined();
      if (planName === undefined) throw new Error("Plan file was not written.");
      const planPath = join(project, ".observability", planName);
      const planContent = await readFile(planPath, "utf8");
      expect(planContent).not.toContain("query");
      expect(planContent).not.toContain("secret-token");

      await mkdir(join(home, "operations"), { recursive: true });
      const lockPath = join(home, "operations", "checkout.lock");
      await writeFile(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600 });
      const locked = await runCli(
        ["ops", "apply", "--dir", project, "--plan", planPath],
        home,
        baseUrl,
      );
      expect(locked.exitCode).not.toBe(0);
      expect(locked.stderr).toContain("OBS_CLI_OPERATIONS_STATE_BUSY");
      expect(mutations).toBe(0);
      await rm(lockPath);

      datasets.push({
        id: "stale-precondition",
        name: "checkout-prod-logs",
        description: "stale",
        kind: "otel:logs:v1",
        retentionDays: 0,
        useRetentionPeriod: false,
      });
      const stale = await runCli(
        ["ops", "apply", "--dir", project, "--plan", planPath],
        home,
        baseUrl,
      );
      expect(stale.exitCode).not.toBe(0);
      expect(stale.stderr).toContain("OBS_CLI_PLAN_STALE");
      datasets.pop();

      const applied = await runCli(
        ["ops", "apply", "--dir", project, "--plan", planPath, "--json"],
        home,
        baseUrl,
      );
      expect(applied.exitCode).toBe(0);
      expect(mutations).toBe(3);
      expect(datasets).toHaveLength(4);

      const second = await runCli(["ops", "plan", "--dir", project, "--json"], home, baseUrl);
      expect(second.exitCode).toBe(0);
      const secondPlan = JSON.parse(second.stdout);
      expect(secondPlan.actions).toEqual([]);
      expect(secondPlan.pendingManualActions).toHaveLength(2);
      const statePath = join(home, "operations", "checkout.json");
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(statePath, "utf8")).not.toContain("secret-token");

      const verified = await runCli(["ops", "verify", "--dir", project], home, baseUrl);
      expect(verified.exitCode).not.toBe(0);
      expect(verified.stderr).toContain("OBS_CLI_MANUAL_ACTION_PENDING");

      for (const dataset of datasets) {
        dataset.retentionDays = 30;
        dataset.useRetentionPeriod = true;
      }
      const confirmationPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const confirmationPlan = JSON.parse(confirmationPlanResult.stdout);
      const confirmationPath = join(
        project,
        ".observability",
        `plan-${confirmationPlan.digest}.json`,
      );
      const invalidConfirmation = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          confirmationPath,
          "--confirm-manual",
          "axiom.missing.prod",
        ],
        home,
        baseUrl,
      );
      expect(invalidConfirmation.stderr).toContain("OBS_CLI_PLAN_INVALID");
      const confirmed = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          confirmationPath,
          "--confirm-manual",
          "axiom.retention.prod",
          "--confirm-manual",
          "axiom.correlation.prod",
        ],
        home,
        baseUrl,
      );
      expect(confirmed.exitCode).toBe(0);
      expect((await runCli(["ops", "verify", "--dir", project], home, baseUrl)).exitCode).toBe(0);

      const retentionDrift = datasets.find((dataset) => dataset.name === "checkout-prod-logs");
      if (retentionDrift === undefined) throw new Error("Created dataset is missing.");
      retentionDrift.retentionDays = 7;
      const drift = await runCli(["ops", "verify", "--dir", project], home, baseUrl);
      expect(drift.stderr).toContain("OBS_CLI_DRIFT_DETECTED");
      retentionDrift.retentionDays = 30;

      const firstDataset = datasets.find((dataset) => dataset.name === "checkout-prod-traces");
      if (firstDataset === undefined) throw new Error("Created dataset is missing.");
      firstDataset.kind = "otel:logs:v1";
      const destructivePlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const destructivePlan = JSON.parse(destructivePlanResult.stdout);
      expect(destructivePlan.actions[0]?.kind).toBe("destructive");
      const destructivePath = join(
        project,
        ".observability",
        `plan-${destructivePlan.digest}.json`,
      );
      const refused = await runCli(
        ["ops", "apply", "--dir", project, "--plan", destructivePath],
        home,
        baseUrl,
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.stderr).toContain("OBS_CLI_PLAN_DESTRUCTIVE");
      const authorized = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          destructivePath,
          "--allow-destructive",
          "--confirm-manual",
          "axiom.dataset.checkout-prod-traces",
        ],
        home,
        baseUrl,
      );
      expect(authorized.exitCode).toBe(0);

      datasets.splice(0);
      const unknownPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const unknownPlan = JSON.parse(unknownPlanResult.stdout);
      const unknownPath = join(project, ".observability", `plan-${unknownPlan.digest}.json`);
      skipReadBack = true;
      const unknown = await runCli(
        ["ops", "apply", "--dir", project, "--plan", unknownPath],
        home,
        baseUrl,
      );
      expect(unknown.exitCode).not.toBe(0);
      expect(unknown.stderr).toContain("OBS_CLI_READ_BACK_TIMEOUT");
      expect(unknown.stderr).not.toContain("secret-token");
      await writeFile(
        statePath,
        (await readFile(statePath, "utf8")).replace(
          '"status": "outcome-unknown"',
          '"status": "pending"',
        ),
        { mode: 0o600 },
      );
      const blocked = await runCli(
        ["ops", "apply", "--dir", project, "--plan", unknownPath],
        home,
        baseUrl,
      );
      expect(blocked.stderr).toContain("OBS_CLI_APPLY_OUTCOME_UNKNOWN");
      expect(await readFile(statePath, "utf8")).toContain('"status": "outcome-unknown"');
    } finally {
      await server.stop(true);
    }
  });
});
