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
      const legacyIntent = {
        id: "axiom.dataset.legacy-interrupted",
        operation: "create",
        resource: "checkout-legacy-interrupted",
        desiredFingerprint: "legacy-interrupted-fingerprint",
        status: "pending",
        updatedAt: "2026-01-03T00:00:00.000Z",
      };
      beforeScopedApply.mutations.push(stagingIntent, prodIntent, legacyIntent);
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
      expect(
        JSON.stringify(
          scopedState.mutations.find((mutation: { id: string }) => mutation.id === legacyIntent.id),
        ),
      ).toBe(JSON.stringify(legacyIntent));
      const legacyBlocked = await runCli(
        ["ops", "verify", "--dir", project, "--environment", "staging"],
        home,
        baseUrl,
      );
      expect(legacyBlocked.exitCode).not.toBe(0);
      expect(legacyBlocked.stderr).toContain("OBS_CLI_MUTATION_UNRESOLVED");
      scopedState.mutations = scopedState.mutations.filter(
        (mutation: { id: string }) =>
          mutation.id !== stagingIntent.id &&
          mutation.id !== prodIntent.id &&
          mutation.id !== legacyIntent.id,
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
