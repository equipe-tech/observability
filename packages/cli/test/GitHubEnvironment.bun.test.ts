import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: Array<string> = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type CommandResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const runCli = (
  args: ReadonlyArray<string>,
  home: string,
  executableDirectory: string,
): Promise<CommandResult> => {
  const child = Bun.spawn(["bun", "packages/cli/src/main.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: {
      ...process.env,
      OBSERVABILITY_HOME: home,
      PATH: `${executableDirectory}:${process.env.PATH ?? ""}`,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  return Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([exitCode, stdout, stderr]) => ({ exitCode, stdout, stderr }));
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "observability-github-environment-"));
  roots.push(root);
  const home = join(root, "home");
  const project = join(root, "project");
  const bin = join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(bin, { recursive: true });
  const credentials = {
    version: 3,
    environments: [
      {
        project: "checkout",
        environment: "staging",
        providers: {
          type: "combined",
          axiom: {
            tokenId: "token-id",
            token: "axiom-private-value",
            tracesDataset: "checkout-staging-traces",
            logsDataset: "checkout-staging-logs",
            metricsDataset: "checkout-staging-metrics",
            datasets: {
              traces: {
                id: "traces",
                name: "checkout-staging-traces",
                kind: "axiom:events:v1",
                retentionDays: 30,
                useRetentionPeriod: true,
                edgeDeployment: "edge-test",
              },
              logs: {
                id: "logs",
                name: "checkout-staging-logs",
                kind: "axiom:events:v1",
                retentionDays: 30,
                useRetentionPeriod: true,
                edgeDeployment: "edge-test",
              },
              metrics: {
                id: "metrics",
                name: "checkout-staging-metrics",
                kind: "otel:metrics:v1",
                retentionDays: 30,
                useRetentionPeriod: true,
                edgeDeployment: "edge-test",
              },
            },
            correlation: {
              type: "operator-confirmed",
              groupName: "checkout staging",
              groupSlug: "checkout-staging",
              tracesDataset: "checkout-staging-traces",
              logsDataset: "checkout-staging-logs",
              metricsDataset: "checkout-staging-metrics",
              confirmedAt: "2026-01-01T00:00:00.000Z",
            },
          },
          sentry: { project: "checkout", dsn: "https://public@sentry.example.test/1" },
        },
      },
    ],
    pendingAxiomMutations: [],
  };
  const credentialsPath = join(home, "credentials.json");
  await writeFile(credentialsPath, `${JSON.stringify(credentials)}\n`, { mode: 0o600 });
  await chmod(credentialsPath, 0o600);
  const gh = join(bin, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
set -eu
printf '%s\\n' "$*" >> ${JSON.stringify(join(root, "calls"))}
case "$*" in
  "api repos/acme/app/environments/staging")
    if test -f ${JSON.stringify(join(root, "insecure"))}; then
      printf '%s\\n' '{"id":7,"name":"staging","protection_rules":[],"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":false}}'
    else
      printf '%s\\n' '{"id":7,"name":"staging","protection_rules":[{"type":"required_reviewers","prevent_self_review":true,"reviewers":[{"reviewer":{"id":42,"type":"User"}}]}],"deployment_branch_policy":{"protected_branches":true,"custom_branch_policies":false}}'
    fi
    ;;
  "api --paginate --slurp repos/acme/app/environments/staging/variables?per_page=100")
    if test -f ${JSON.stringify(join(root, "drift"))}; then
      printf '%s\\n' '[{"variables":[{"name":"OTEL_SERVICE_NAME","value":"changed","updated_at":"2026-01-02T00:00:00Z"}]}]'
    elif test -f ${JSON.stringify(join(root, "variable-inputs"))}; then
      printf '%s\\n' '[{"variables":[{"name":"OTEL_SERVICE_NAME","value":"checkout","updated_at":"2026-01-02T00:00:00Z"},{"name":"OTEL_SERVICE_VERSION","value":"abc1234","updated_at":"2026-01-02T00:00:00Z"},{"name":"OTEL_DEPLOYMENT_ENVIRONMENT","value":"staging","updated_at":"2026-01-02T00:00:00Z"},{"name":"OBSERVABILITY_TELEMETRY_ROLLOUT","value":"disabled","updated_at":"2026-01-02T00:00:00Z"},{"name":"OTEL_EXPORTER_OTLP_ENDPOINT","value":"http://checkout-otel-collector:4318","updated_at":"2026-01-02T00:00:00Z"},{"name":"AXIOM_DATASET_TRACES","value":"checkout-staging-traces","updated_at":"2026-01-02T00:00:00Z"},{"name":"AXIOM_DATASET_LOGS","value":"checkout-staging-logs","updated_at":"2026-01-02T00:00:00Z"},{"name":"AXIOM_DATASET_METRICS","value":"checkout-staging-metrics","updated_at":"2026-01-02T00:00:00Z"},{"name":"AXIOM_EDGE_DEPLOYMENT","value":"edge-test","updated_at":"2026-01-02T00:00:00Z"}]}]'
    else
      printf '%s\\n' '[{"variables":[]}]'
    fi
    ;;
  "api --paginate --slurp repos/acme/app/environments/staging/secrets?per_page=100")
    if test -f ${JSON.stringify(join(root, "secret-inputs"))} && ! test -f ${JSON.stringify(join(root, "hide-secret"))}; then
      printf '%s\\n' '[{"secrets":[{"name":"AXIOM_TOKEN","updated_at":"2026-01-02T00:00:00Z"},{"name":"SENTRY_DSN","updated_at":"2026-01-02T00:00:00Z"}]}]'
    else
      printf '%s\\n' '[{"secrets":[]}]'
    fi
    ;;
  "api --method POST repos/acme/app/environments/staging/variables --input -")
    cat >> ${JSON.stringify(join(root, "variable-inputs"))}
    printf '\\n' >> ${JSON.stringify(join(root, "variable-inputs"))}
    printf '%s\\n' '{}'
    ;;
  secret\\ set*)
    cat >> ${JSON.stringify(join(root, "secret-inputs"))}
    printf '\\n' >> ${JSON.stringify(join(root, "secret-inputs"))}
    if test "$3" = AXIOM_TOKEN && test -f ${JSON.stringify(join(root, "fail-secret"))}; then exit 42; fi
    ;;
  *)
    exit 41
    ;;
esac
`,
    { mode: 0o700 },
  );
  await chmod(gh, 0o700);
  return { root, home, project, bin };
};

describe("GitHub Environment synchronization", () => {
  test("plans and applies allowlisted writes without leaking secrets", async () => {
    const target = await fixture();
    const planned = await runCli(
      [
        "env",
        "github",
        "plan",
        "--dir",
        target.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      target.home,
      target.bin,
    );
    expect(planned.exitCode).toBe(0);
    expect(planned.stderr).toBe("");
    expect(planned.stdout).not.toContain("axiom-private-value");
    expect(planned.stdout).not.toContain("public@sentry");
    expect(planned.stdout).toContain('"rollout": "disabled"');
    expect(planned.stdout).toContain('"requiredReviewerIds": [\n    42\n  ]');
    expect(planned.stdout).toContain(
      "Secret actions overwrite by name because GitHub never returns secret contents.",
    );
    const planPath = planned.stdout.match(/plan-file (.+)\n/)?.[1];
    expect(planPath).toBeDefined();
    if (planPath === undefined) throw new Error("missing plan path");
    const planContent = await readFile(planPath, "utf8");
    expect(planContent).not.toContain("axiom-private-value");
    expect(planContent).not.toContain("public@sentry");
    expect((await stat(planPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(target.project, ".observability"))).mode & 0o777).toBe(0o700);

    const applied = await runCli(
      ["env", "github", "apply", "--plan", planPath],
      target.home,
      target.bin,
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    expect(applied.stdout).not.toContain("axiom-private-value");
    expect(applied.stdout).not.toContain("public@sentry");
    expect(applied.stdout).toContain('"secretVerification": "presence-only"');
    const calls = await readFile(join(target.root, "calls"), "utf8");
    expect(calls).not.toContain("axiom-private-value");
    expect(calls).not.toContain("public@sentry");
    expect(calls).toContain("secret set AXIOM_TOKEN --repo acme/app --env staging");
    expect(calls).toContain("api --paginate --slurp");
    expect(await readFile(join(target.root, "secret-inputs"), "utf8")).toContain(
      "axiom-private-value",
    );
    const repeated = await runCli(
      ["env", "github", "apply", "--plan", planPath],
      target.home,
      target.bin,
    );
    expect(repeated.exitCode).toBe(1);
    expect(repeated.stderr).toContain("OBS_CLI_GITHUB_PLAN_STALE");
  });

  test("reports unknown mutation outcomes and permits safe overwrite recovery", async () => {
    const target = await fixture();
    const planned = await runCli(
      [
        "env",
        "github",
        "plan",
        "--dir",
        target.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      target.home,
      target.bin,
    );
    const planPath = planned.stdout.match(/plan-file (.+)\n/)?.[1];
    if (planPath === undefined) throw new Error("missing plan path");
    await writeFile(join(target.root, "fail-secret"), "yes\n");
    const unknown = await runCli(
      ["env", "github", "apply", "--plan", planPath],
      target.home,
      target.bin,
    );
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toContain("OBS_CLI_GITHUB_APPLY_OUTCOME_UNKNOWN");
    expect(unknown.stderr).not.toContain("axiom-private-value");
    const statePath = [
      ...new Bun.Glob("github-apply-*.json").scanSync(join(target.project, ".observability")),
    ][0];
    expect(statePath).toBeDefined();
    if (statePath === undefined) throw new Error("missing apply state");
    const state = await readFile(join(target.project, ".observability", statePath), "utf8");
    expect(state).toContain('"status": "outcome-unknown"');
    expect(state).not.toContain("axiom-private-value");
    await rm(join(target.root, "fail-secret"));
    const replanned = await runCli(
      [
        "env",
        "github",
        "plan",
        "--dir",
        target.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      target.home,
      target.bin,
    );
    const recoveryPlanPath = replanned.stdout.match(/plan-file (.+)\n/)?.[1];
    if (recoveryPlanPath === undefined) throw new Error("missing recovery plan path");
    const recovered = await runCli(
      ["env", "github", "apply", "--plan", recoveryPlanPath],
      target.home,
      target.bin,
    );
    expect(recovered.exitCode).toBe(0);
  });

  test("rejects stale, malformed, and unapproved rollout plans", async () => {
    const target = await fixture();
    const planned = await runCli(
      [
        "deploy",
        "plan",
        "--dir",
        target.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
        "--rollout",
        "enabled",
      ],
      target.home,
      target.bin,
    );
    expect(planned.exitCode).toBe(0);
    const planPath = planned.stdout.match(/plan-file (.+)\n/)?.[1];
    if (planPath === undefined) throw new Error("missing plan path");
    const rejected = await runCli(["deploy", "apply", "--plan", planPath], target.home, target.bin);
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("OBS_CLI_GITHUB_ROLLOUT_APPROVAL_REQUIRED");
    expect(rejected.stderr).not.toContain("axiom-private-value");

    const malformedPath = join(target.root, "malformed.json");
    await writeFile(malformedPath, '{"version":1,"digest":"forged"}\n');
    const malformed = await runCli(
      ["deploy", "apply", "--plan", malformedPath, "--approve-rollout"],
      target.home,
      target.bin,
    );
    expect(malformed.exitCode).toBe(1);
    expect(malformed.stderr).toContain("OBS_CLI_GITHUB_PLAN_INVALID");

    const disabledPlan = await runCli(
      [
        "deploy",
        "plan",
        "--dir",
        target.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      target.home,
      target.bin,
    );
    const stalePath = disabledPlan.stdout.match(/plan-file (.+)\n/)?.[1];
    if (stalePath === undefined) throw new Error("missing stale plan path");
    await writeFile(join(target.root, "drift"), "yes\n");
    const stale = await runCli(["deploy", "apply", "--plan", stalePath], target.home, target.bin);
    expect(stale.exitCode).toBe(1);
    expect(stale.stderr).toContain("OBS_CLI_GITHUB_PLAN_STALE");
  });

  test("enforces protection policy and post-write secret metadata read-back", async () => {
    const insecure = await fixture();
    await writeFile(join(insecure.root, "insecure"), "yes\n");
    const rejected = await runCli(
      [
        "env",
        "github",
        "plan",
        "--dir",
        insecure.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      insecure.home,
      insecure.bin,
    );
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stderr).toContain("must require at least one reviewer");

    const unreadable = await fixture();
    const planned = await runCli(
      [
        "env",
        "github",
        "plan",
        "--dir",
        unreadable.project,
        "--repo",
        "acme/app",
        "--name",
        "checkout",
        "--environment",
        "staging",
        "--release",
        "abc1234",
      ],
      unreadable.home,
      unreadable.bin,
    );
    const planPath = planned.stdout.match(/plan-file (.+)\n/)?.[1];
    if (planPath === undefined) throw new Error("missing plan path");
    await writeFile(join(unreadable.root, "hide-secret"), "yes\n");
    const applied = await runCli(
      ["env", "github", "apply", "--plan", planPath],
      unreadable.home,
      unreadable.bin,
    );
    expect(applied.exitCode).toBe(1);
    expect(applied.stderr).toContain("OBS_CLI_GITHUB_READBACK_FAILED");
    expect(applied.stderr).not.toContain("axiom-private-value");
  });
});
