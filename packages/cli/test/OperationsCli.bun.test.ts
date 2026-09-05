import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
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
      OBSERVABILITY_CLI_REQUEST_TIMEOUT_MILLISECONDS: "100",
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
  test("rejects unsupported YAML before planning or provider calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-operations-yaml-"));
    roots.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, "observability"), { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(
      join(project, "observability", "operations.yaml"),
      "%YAML 1.1\n---\nversion: 1\ncontractVersion: 1\nservice: checkout\nenvironments: [staging, prod]\nretention:\n  - environment: staging\n    <<: &retention\n      days: 3:00\n  - environment: prod\n    <<: *retention\ndashboards: []\nmonitors: []\nsentry: { enabled: false }\n",
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
    let providerCalls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        providerCalls += 1;
        return Response.json([]);
      },
    });
    try {
      const result = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        `http://127.0.0.1:${server.port}`,
      );
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("OBS_CLI_MANIFEST_INVALID");
      expect(providerCalls).toBe(0);
      expect(await readdir(project)).toEqual(["observability"]);
    } finally {
      await server.stop(true);
    }
  });

  test("requires destructive authorization again when confirming pending retention", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-operations-retention-"));
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

    const datasets = ["traces", "logs", "metrics"].map((signal, index) => ({
      id: `dataset-${index}`,
      name: `checkout-prod-${signal}`,
      description: signal,
      kind: signal === "metrics" ? "otel:metrics:v1" : "axiom:events:v1",
      retentionDays: 90,
      useRetentionPeriod: true,
    }));
    let writes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v2/datasets") return new Response("missing", { status: 404 });
        if (request.method === "GET") return Response.json(datasets);
        writes += 1;
        return new Response("unexpected write", { status: 500 });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    try {
      const firstPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(firstPlanResult.stderr).toBe("");
      expect(firstPlanResult.exitCode).toBe(0);
      const firstPlan = JSON.parse(firstPlanResult.stdout);
      expect(
        firstPlan.actions.find((action: { id: string }) => action.id === "axiom.retention.prod")
          ?.kind,
      ).toBe("destructive");
      const firstPlanPath = join(project, ".observability", `plan-${firstPlan.digest}.json`);
      const firstApply = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          firstPlanPath,
          "--allow-destructive",
          "--json",
        ],
        home,
        baseUrl,
      );
      expect(firstApply.exitCode).toBe(0);
      expect(writes).toBe(0);

      const confirmationPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(confirmationPlanResult.exitCode).toBe(0);
      const confirmationPlan = JSON.parse(confirmationPlanResult.stdout);
      expect(confirmationPlan.digest).toBe(JSON.parse(firstApply.stdout).digest);
      expect(confirmationPlan.actions).toEqual([]);
      expect(confirmationPlan.pendingManualActions).toContainEqual(
        expect.objectContaining({ id: "axiom.retention.prod", status: "pending" }),
      );
      const confirmationPath = join(
        project,
        ".observability",
        `plan-${confirmationPlan.digest}.json`,
      );
      const statePath = join(home, "operations", "checkout.json");
      const stateBeforeRejectedConfirmation = await readFile(statePath, "utf8");
      const rejected = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          confirmationPath,
          "--confirm-manual",
          "axiom.retention.prod",
        ],
        home,
        baseUrl,
      );
      expect(rejected.exitCode).not.toBe(0);
      expect(rejected.stderr).toContain("OBS_CLI_PLAN_DESTRUCTIVE");
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeRejectedConfirmation);
      expect(writes).toBe(0);

      const confirmed = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          confirmationPath,
          "--allow-destructive",
          "--confirm-manual",
          "axiom.retention.prod",
          "--json",
        ],
        home,
        baseUrl,
      );
      expect(confirmed.exitCode).toBe(0);
      expect(writes).toBe(0);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(
        state.manualActions.find((action: { id: string }) => action.id === "axiom.retention.prod")
          ?.status,
      ).toBe("operator-confirmed");
    } finally {
      await server.stop(true);
    }
  });

  test("refreshes pending retention classification from current desired and observed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-operations-retention-drift-"));
    roots.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, "observability"), { recursive: true });
    await mkdir(home, { recursive: true });
    const manifestPath = join(project, "observability", "operations.yaml");
    const manifest = (days: number) =>
      `version: 1\ncontractVersion: 1\nservice: checkout\nenvironments: [prod]\nretention:\n  - environment: prod\n    days: ${days}\ndashboards: []\nmonitors: []\nsentry:\n  enabled: false\n`;
    await writeFile(manifestPath, manifest(30));
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

    const datasets = ["traces", "logs", "metrics"].map((signal, index) => ({
      id: `dataset-${index}`,
      name: `checkout-prod-${signal}`,
      description: signal,
      kind: signal === "metrics" ? "otel:metrics:v1" : "axiom:events:v1",
      retentionDays: 7,
      useRetentionPeriod: true,
    }));
    let writes = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v2/datasets") return new Response("missing", { status: 404 });
        if (request.method === "GET") return Response.json(datasets);
        writes += 1;
        return new Response("unexpected write", { status: 500 });
      },
    });
    const baseUrl = `http://127.0.0.1:${server.port}`;
    const planPath = (digest: string) => join(project, ".observability", `plan-${digest}.json`);
    try {
      const initialResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(initialResult.exitCode).toBe(0);
      const initialPlan = JSON.parse(initialResult.stdout);
      expect(
        initialPlan.actions.find((action: { id: string }) => action.id === "axiom.retention.prod")
          ?.kind,
      ).toBe("manual");
      expect(initialPlan.actions.map((action: { id: string }) => action.id)).toContain(
        "axiom.correlation.prod",
      );
      const stagedResult = await runCli(
        ["ops", "apply", "--dir", project, "--plan", planPath(initialPlan.digest), "--json"],
        home,
        baseUrl,
      );
      expect(stagedResult.exitCode).toBe(0);
      const stagedPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(stagedPlanResult.exitCode).toBe(0);
      const stagedPlan = JSON.parse(stagedPlanResult.stdout);
      const stagedReplayPath = join(root, "staged-plan.json");
      await writeFile(stagedReplayPath, await readFile(planPath(stagedPlan.digest), "utf8"));
      expect(stagedPlan.pendingManualActions).toHaveLength(2);
      expect(writes).toBe(0);

      for (const dataset of datasets) dataset.retentionDays = 90;
      const destructiveResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(destructiveResult.exitCode).toBe(0);
      const destructivePlan = JSON.parse(destructiveResult.stdout);
      expect(destructivePlan.digest).not.toBe(stagedPlan.digest);
      expect(destructivePlan.actions).toEqual([]);
      expect(destructivePlan.pendingManualActions).toContainEqual(
        expect.objectContaining({
          id: "axiom.retention.prod",
          kind: "destructive",
          status: "pending",
        }),
      );
      expect(destructivePlan.pendingManualActions).toContainEqual(
        expect.objectContaining({
          id: "axiom.correlation.prod",
          kind: "manual",
          status: "pending",
        }),
      );
      const destructiveReplayPath = join(root, "destructive-plan.json");
      await writeFile(
        destructiveReplayPath,
        await readFile(planPath(destructivePlan.digest), "utf8"),
      );
      const statePath = join(home, "operations", "checkout.json");
      const stateBeforeRejections = await readFile(statePath, "utf8");
      const staleInitial = await runCli(
        ["ops", "apply", "--dir", project, "--plan", stagedReplayPath],
        home,
        baseUrl,
      );
      expect(staleInitial.exitCode).not.toBe(0);
      expect(staleInitial.stderr).toContain("OBS_CLI_PLAN_STALE");
      const rejectedDestructive = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          planPath(destructivePlan.digest),
          "--confirm-manual",
          "axiom.retention.prod",
          "--confirm-manual",
          "axiom.correlation.prod",
        ],
        home,
        baseUrl,
      );
      expect(rejectedDestructive.exitCode).not.toBe(0);
      expect(rejectedDestructive.stderr).toContain("OBS_CLI_PLAN_DESTRUCTIVE");
      expect(await readFile(statePath, "utf8")).toBe(stateBeforeRejections);
      expect(writes).toBe(0);

      await writeFile(manifestPath, manifest(60));
      const changedDesiredResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(changedDesiredResult.exitCode).toBe(0);
      const changedDesiredPlan = JSON.parse(changedDesiredResult.stdout);
      expect(changedDesiredPlan.digest).not.toBe(destructivePlan.digest);
      expect(changedDesiredPlan.pendingManualActions).not.toContainEqual(
        expect.objectContaining({ id: "axiom.retention.prod" }),
      );
      expect(changedDesiredPlan.actions).toContainEqual(
        expect.objectContaining({ id: "axiom.retention.prod", kind: "destructive" }),
      );
      const staleDestructive = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          destructiveReplayPath,
          "--allow-destructive",
          "--confirm-manual",
          "axiom.retention.prod",
        ],
        home,
        baseUrl,
      );
      expect(staleDestructive.exitCode).not.toBe(0);
      expect(staleDestructive.stderr).toContain("OBS_CLI_PLAN_STALE");
      const restagedResult = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          planPath(changedDesiredPlan.digest),
          "--allow-destructive",
          "--json",
        ],
        home,
        baseUrl,
      );
      expect(restagedResult.exitCode).toBe(0);
      const restagedPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      expect(restagedPlanResult.exitCode).toBe(0);
      const restagedPlan = JSON.parse(restagedPlanResult.stdout);
      const restagedReplayPath = join(root, "restaged-plan.json");
      await writeFile(restagedReplayPath, await readFile(planPath(restagedPlan.digest), "utf8"));
      expect(restagedPlan.pendingManualActions).toContainEqual(
        expect.objectContaining({ id: "axiom.retention.prod", kind: "destructive" }),
      );
      expect(writes).toBe(0);

      for (const dataset of datasets) dataset.retentionDays = 30;
      const manualResult = await runCli(["ops", "plan", "--dir", project, "--json"], home, baseUrl);
      expect(manualResult.exitCode).toBe(0);
      const manualPlan = JSON.parse(manualResult.stdout);
      expect(manualPlan.digest).not.toBe(restagedPlan.digest);
      expect(manualPlan.pendingManualActions).toContainEqual(
        expect.objectContaining({ id: "axiom.retention.prod", kind: "manual" }),
      );
      const staleRestaged = await runCli(
        ["ops", "apply", "--dir", project, "--plan", restagedReplayPath],
        home,
        baseUrl,
      );
      expect(staleRestaged.exitCode).not.toBe(0);
      expect(staleRestaged.stderr).toContain("OBS_CLI_PLAN_STALE");
      const confirmed = await runCli(
        [
          "ops",
          "apply",
          "--dir",
          project,
          "--plan",
          planPath(manualPlan.digest),
          "--confirm-manual",
          "axiom.retention.prod",
          "--confirm-manual",
          "axiom.correlation.prod",
        ],
        home,
        baseUrl,
      );
      expect(confirmed.exitCode).toBe(0);
      const state = JSON.parse(await readFile(statePath, "utf8"));
      expect(state.manualActions).toContainEqual(
        expect.objectContaining({
          id: "axiom.retention.prod",
          kind: "manual",
          status: "operator-confirmed",
        }),
      );
      expect(writes).toBe(0);
    } finally {
      await server.stop(true);
    }
  });

  test("plans without mutation, applies with read-back, and produces an empty second plan", async () => {
    const root = await mkdtemp(join(tmpdir(), "observability-operations-"));
    roots.push(root);
    const project = join(root, "project");
    const home = join(root, "home");
    await mkdir(join(project, "observability"), { recursive: true });
    await mkdir(home, { recursive: true });
    const manifestPath = join(project, "observability", "operations.yaml");
    const manifestContent =
      "version: 1\ncontractVersion: 1\nservice: checkout\nenvironments: [prod]\nretention:\n  - environment: prod\n    days: 30\ndashboards: []\nmonitors: []\nsentry:\n  enabled: false\n";
    await writeFile(manifestPath, manifestContent);
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
    let mutationStatus = 201;
    let readStatus = 200;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname !== "/v2/datasets") return new Response("missing", { status: 404 });
        if (request.method === "GET") {
          return readStatus === 200
            ? Response.json(datasets)
            : Response.json({ error: "read failed" }, { status: readStatus });
        }
        mutations += 1;
        if (mutationStatus !== 201) {
          if (mutationStatus === 503) readStatus = 500;
          return new Response("rejected", { status: mutationStatus });
        }
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
      expect(first.stderr).toBe("");
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

      const applied = await runCli(
        ["ops", "apply", "--dir", project, "--plan", planPath, "--json"],
        home,
        baseUrl,
      );
      expect(applied.exitCode).toBe(0);
      expect(mutations).toBe(3);
      expect(datasets).toHaveLength(4);

      const secondPlan = JSON.parse(applied.stdout);
      expect(secondPlan.actions).toEqual([]);
      expect(secondPlan.pendingManualActions).toHaveLength(2);
      const statePath = join(home, "operations", "checkout.json");
      expect((await stat(join(home, "operations"))).mode & 0o777).toBe(0o700);
      expect((await stat(join(project, ".observability"))).mode & 0o777).toBe(0o700);
      expect((await stat(statePath)).mode & 0o777).toBe(0o600);
      expect(await readFile(statePath, "utf8")).not.toContain("secret-token");

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
      const baselineState = await readFile(statePath, "utf8");
      const baselineMutationCalls = mutations;
      expect((await runCli(["ops", "verify", "--dir", project], home, baseUrl)).exitCode).toBe(0);
      expect(await readFile(statePath, "utf8")).toBe(baselineState);
      expect(mutations).toBe(baselineMutationCalls);

      for (const status of ["pending", "outcome-unknown"]) {
        const unresolvedState = JSON.parse(baselineState);
        unresolvedState.mutations.push({
          id: `axiom.dataset.unresolved-${status}`,
          operation: "create",
          resource: `checkout-prod-unresolved-${status}`,
          environment: "prod",
          desiredFingerprint: "unresolved-fingerprint",
          status,
          updatedAt: new Date().toISOString(),
        });
        const unresolvedContent = `${JSON.stringify(unresolvedState, null, 2)}\n`;
        await writeFile(statePath, unresolvedContent, { mode: 0o600 });
        const verified = await runCli(
          ["ops", "verify", "--dir", project, "--environment", "prod"],
          home,
          baseUrl,
        );
        expect(verified.exitCode).not.toBe(0);
        expect(verified.stderr).toContain("OBS_CLI_MUTATION_UNRESOLVED");
        expect(await readFile(statePath, "utf8")).toBe(unresolvedContent);
        expect(mutations).toBe(baselineMutationCalls);
      }

      for (const [status, environment] of [
        ["resolved", "prod"],
        ["pending", "staging"],
      ]) {
        const scopedState = JSON.parse(baselineState);
        scopedState.mutations.push({
          id: `axiom.dataset.${environment}-${status}`,
          operation: "create",
          resource: `checkout-${environment}-${status}`,
          environment,
          desiredFingerprint: "scoped-fingerprint",
          status,
          updatedAt: new Date().toISOString(),
        });
        const scopedContent = `${JSON.stringify(scopedState, null, 2)}\n`;
        await writeFile(statePath, scopedContent, { mode: 0o600 });
        expect(
          (
            await runCli(
              ["ops", "verify", "--dir", project, "--environment", "prod"],
              home,
              baseUrl,
            )
          ).exitCode,
        ).toBe(0);
        expect(await readFile(statePath, "utf8")).toBe(scopedContent);
        expect(mutations).toBe(baselineMutationCalls);
      }
      await writeFile(statePath, baselineState, { mode: 0o600 });

      await writeFile(
        manifestPath,
        manifestContent
          .replace("environments: [prod]", "environments: [prod, staging]")
          .replace("    days: 30", "    days: 30\n  - environment: staging\n    days: 30"),
      );
      for (const suffix of ["logs", "metrics", "traces"]) {
        const prodDataset = datasets.find((dataset) => dataset.name === `checkout-prod-${suffix}`);
        if (prodDataset === undefined) throw new Error(`Missing prod ${suffix} dataset.`);
        datasets.push({
          ...prodDataset,
          id: `staging-${suffix}`,
          name: `checkout-staging-${suffix}`,
        });
      }
      const stagingPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--environment", "staging", "--json"],
        home,
        baseUrl,
      );
      const stagingPlan = JSON.parse(stagingPlanResult.stdout);
      const stagingPath = join(project, ".observability", `plan-${stagingPlan.digest}.json`);
      const beforeScopedApply = JSON.parse(await readFile(statePath, "utf8"));
      const stagingIntent = {
        id: "axiom.dataset.staging-interrupted",
        operation: "create",
        resource: "checkout-staging-interrupted",
        environment: "staging",
        desiredFingerprint: "staging-interrupted-fingerprint",
        status: "pending",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const prodIntent = {
        id: "axiom.dataset.prod-interrupted",
        operation: "create",
        resource: "checkout-prod-interrupted",
        environment: "prod",
        desiredFingerprint: "prod-interrupted-fingerprint",
        status: "outcome-unknown",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };
      beforeScopedApply.mutations.push(stagingIntent, prodIntent);
      await writeFile(statePath, `${JSON.stringify(beforeScopedApply, null, 2)}\n`, {
        mode: 0o600,
      });
      expect(
        (
          await runCli(
            ["ops", "apply", "--dir", project, "--environment", "staging", "--plan", stagingPath],
            home,
            baseUrl,
          )
        ).exitCode,
      ).toBe(0);
      const scopedState = JSON.parse(await readFile(statePath, "utf8"));
      expect(
        scopedState.manualActions
          .filter((action: { environment: string }) => action.environment === "prod")
          .map((action: { id: string }) => action.id)
          .sort(),
      ).toEqual(["axiom.correlation.prod", "axiom.retention.prod"]);
      expect(
        scopedState.mutations.find((mutation: { id: string }) => mutation.id === stagingIntent.id)
          ?.status,
      ).toBe("resolved");
      expect(
        JSON.stringify(
          scopedState.mutations.find((mutation: { id: string }) => mutation.id === prodIntent.id),
        ),
      ).toBe(JSON.stringify(prodIntent));
      const invalidState = structuredClone(scopedState);
      invalidState.mutations.push({
        id: "axiom.dataset.environment-missing",
        operation: "create",
        resource: "checkout-unknown-interrupted",
        desiredFingerprint: "missing-environment-fingerprint",
        status: "pending",
        updatedAt: "2026-01-03T00:00:00.000Z",
      });
      await writeFile(statePath, `${JSON.stringify(invalidState, null, 2)}\n`, { mode: 0o600 });
      const invalidStateResult = await runCli(
        ["ops", "verify", "--dir", project, "--environment", "staging"],
        home,
        baseUrl,
      );
      expect(invalidStateResult.exitCode).not.toBe(0);
      expect(invalidStateResult.stderr).toContain("OBS_CLI_OPERATIONS_STATE_INVALID");
      expect(invalidStateResult.stderr).toContain("Remove the invalid file and rerun ops plan");
      scopedState.mutations = scopedState.mutations.filter(
        (mutation: { id: string }) =>
          mutation.id !== stagingIntent.id && mutation.id !== prodIntent.id,
      );
      await writeFile(statePath, `${JSON.stringify(scopedState, null, 2)}\n`, { mode: 0o600 });
      await writeFile(manifestPath, manifestContent);

      const stateWithRemovedResource = JSON.parse(await readFile(statePath, "utf8"));
      stateWithRemovedResource.manualActions.push({
        id: "axiom.dashboard.prod.removed",
        provider: "Axiom",
        capability: "dashboard",
        environment: "prod",
        desiredFingerprint: "removed-resource-fingerprint",
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });
      await writeFile(statePath, `${JSON.stringify(stateWithRemovedResource, null, 2)}\n`, {
        mode: 0o600,
      });
      expect((await runCli(["ops", "verify", "--dir", project], home, baseUrl)).exitCode).toBe(0);

      const metricsIndex = datasets.findIndex(
        (dataset) => dataset.name === "checkout-prod-metrics",
      );
      const missingMetrics = datasets[metricsIndex];
      const canonicalLogs = datasets.find((dataset) => dataset.name === "checkout-prod-logs");
      if (missingMetrics === undefined || canonicalLogs === undefined) {
        throw new Error("Expected dataset prerequisites are missing.");
      }
      datasets.splice(metricsIndex, 1);
      datasets.push(
        { ...canonicalLogs, id: "duplicate-logs" },
        {
          ...missingMetrics,
          id: "prefixed-metrics",
          name: "checkout-prod-metrics-copy",
        },
      );
      const duplicatePlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const duplicatePlan = JSON.parse(duplicatePlanResult.stdout);
      expect(
        duplicatePlan.actions.some(
          (action: { id: string }) => action.id === "axiom.dataset.checkout-prod-metrics",
        ),
      ).toBeTrue();
      expect(
        duplicatePlan.actions.some(
          (action: { id: string }) => action.id === "axiom.retention.prod",
        ),
      ).toBeTrue();
      datasets.pop();
      datasets.pop();
      datasets.push(missingMetrics);

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
      expect(await readFile(statePath, "utf8")).toContain('"status": "outcome-unknown"');
      skipReadBack = false;
      const reconciled = await runCli(
        ["ops", "apply", "--dir", project, "--plan", unknownPath],
        home,
        baseUrl,
      );
      expect(reconciled.exitCode).toBe(0);

      datasets.splice(0);
      const ambiguousPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const ambiguousPlan = JSON.parse(ambiguousPlanResult.stdout);
      const ambiguousPath = join(project, ".observability", `plan-${ambiguousPlan.digest}.json`);
      mutationStatus = 503;
      const ambiguous = await runCli(
        ["ops", "apply", "--dir", project, "--plan", ambiguousPath],
        home,
        baseUrl,
      );
      expect(ambiguous.stderr).toContain("OBS_CLI_APPLY_OUTCOME_UNKNOWN");
      expect(await readFile(statePath, "utf8")).toContain('"status": "outcome-unknown"');
      mutationStatus = 201;
      readStatus = 200;

      const rejectedPlanResult = await runCli(
        ["ops", "plan", "--dir", project, "--json"],
        home,
        baseUrl,
      );
      const rejectedPlan = JSON.parse(rejectedPlanResult.stdout);
      const rejectedPath = join(project, ".observability", `plan-${rejectedPlan.digest}.json`);
      mutationStatus = 400;
      const rejected = await runCli(
        ["ops", "apply", "--dir", project, "--plan", rejectedPath],
        home,
        baseUrl,
      );
      expect(rejected.stderr).toContain("OBS_CLI_REMOTE_FAILED");
      const rejectedState = JSON.parse(await readFile(statePath, "utf8"));
      expect(
        rejectedState.mutations.some(
          (mutation: { status: string }) => mutation.status === "pending",
        ),
      ).toBeFalse();
      mutationStatus = 201;
      const retried = await runCli(
        ["ops", "apply", "--dir", project, "--plan", rejectedPath],
        home,
        baseUrl,
      );
      expect(retried.exitCode).toBe(0);
      expect(await readFile(statePath, "utf8")).not.toContain("axiom.dashboard.prod.removed");
    } finally {
      await server.stop(true);
    }
  });
});
