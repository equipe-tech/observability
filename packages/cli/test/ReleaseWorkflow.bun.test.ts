import { deployedCanarySuiteTimeoutMilliseconds } from "@equipe-tech/observability/testing";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
);

const ciWorkflowPath = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

const releasePreflightWorkflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release-preflight.yml", import.meta.url),
);

const releaseCanaryScriptPath = fileURLToPath(
  new URL("../../../scripts/release-canary.ts", import.meta.url),
);

const workflow = await Bun.file(workflowPath).text();
const ciWorkflow = await Bun.file(ciWorkflowPath).text();
const releasePreflightWorkflow = await Bun.file(releasePreflightWorkflowPath).text();
const releaseCanaryScript = await Bun.file(releaseCanaryScriptPath).text();

const WorkflowEnvironment = Schema.Struct({
  OBSERVABILITY_E2E_DEPLOYED: Schema.optionalKey(Schema.String),
  AXIOM_INGEST_TOKEN: Schema.optionalKey(Schema.String),
  AXIOM_READ_TOKEN: Schema.optionalKey(Schema.String),
  AXIOM_ORGANIZATION_ID: Schema.optionalKey(Schema.String),
  AXIOM_URL: Schema.optionalKey(Schema.String),
  AXIOM_DATASET_TRACES: Schema.optionalKey(Schema.String),
  AXIOM_DATASET_LOGS: Schema.optionalKey(Schema.String),
  AXIOM_DATASET_METRICS: Schema.optionalKey(Schema.String),
  OTEL_EXPORTER_OTLP_ENDPOINT: Schema.optionalKey(Schema.String),
  EVENT_REF: Schema.optionalKey(Schema.String),
  NODE_AUTH_TOKEN: Schema.optionalKey(Schema.String),
  RELEASE_TAG: Schema.optionalKey(Schema.String),
  DEPLOYED_CANARY_RESULT: Schema.optionalKey(Schema.String),
});

const WorkflowStep = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  "continue-on-error": Schema.optionalKey(Schema.Boolean),
  "timeout-minutes": Schema.optionalKey(Schema.Number),
  with: Schema.optionalKey(
    Schema.Struct({
      "bun-version": Schema.optionalKey(Schema.String),
      ref: Schema.optionalKey(Schema.String),
    }),
  ),
  env: Schema.optionalKey(WorkflowEnvironment),
});

const WorkflowDocument = Schema.Struct({
  permissions: Schema.Record(Schema.String, Schema.String),
  env: Schema.optionalKey(WorkflowEnvironment),
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ steps: Schema.optionalKey(Schema.Array(WorkflowStep)) }),
  ),
});

const ConditionalJob = Schema.Struct({
  uses: Schema.optionalKey(Schema.String),
  "runs-on": Schema.optionalKey(Schema.String),
  permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  needs: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(WorkflowEnvironment),
  "continue-on-error": Schema.optionalKey(Schema.Boolean),
  "timeout-minutes": Schema.optionalKey(Schema.Number),
  steps: Schema.optionalKey(Schema.Array(WorkflowStep)),
});

const WorkflowSecrets = Schema.Struct({
  AXIOM_INGEST_TOKEN: Schema.optionalKey(Schema.String),
  AXIOM_READ_TOKEN: Schema.optionalKey(Schema.String),
});

const ReusableWorkflowJob = Schema.Struct({
  uses: Schema.String,
  with: Schema.Struct({
    ref: Schema.String,
  }),
  secrets: Schema.optionalKey(WorkflowSecrets),
});

const DependentJob = Schema.Struct({
  needs: Schema.Array(Schema.String),
  if: Schema.String,
  environment: Schema.String,
});

const ReleaseGateJob = Schema.Struct({
  if: Schema.String,
  needs: Schema.String,
  steps: Schema.Array(WorkflowStep),
});

const CiWorkflow = Schema.Struct({
  on: Schema.Struct({
    workflow_call: Schema.Struct({
      inputs: Schema.Struct({
        ref: Schema.Struct({ required: Schema.Boolean, type: Schema.String }),
      }),
      secrets: Schema.optionalKey(WorkflowSecrets),
    }),
  }),
  jobs: Schema.Struct({
    verify: ConditionalJob,
  }),
});

const ReleaseWorkflow = Schema.Struct({
  jobs: Schema.Struct({
    verify: ReusableWorkflowJob,
    "deployed-canary": ConditionalJob,
    "canary-gate": ReleaseGateJob,
    release: DependentJob,
    "publish-npm": DependentJob,
  }),
});

const ReleasePreflightWorkflow = Schema.Struct({
  jobs: Schema.Struct({
    readiness: ConditionalJob,
    "deployed-canary": ConditionalJob,
    "canary-gate": ReleaseGateJob,
  }),
});

const parsedCiWorkflow = Schema.decodeUnknownSync(CiWorkflow)(Bun.YAML.parse(ciWorkflow));
const parsedReleaseWorkflow = Schema.decodeUnknownSync(ReleaseWorkflow, {
  onExcessProperty: "preserve",
})(Bun.YAML.parse(workflow));
const parsedReleasePreflightWorkflow = Schema.decodeUnknownSync(ReleasePreflightWorkflow, {
  onExcessProperty: "preserve",
})(Bun.YAML.parse(releasePreflightWorkflow));
const workflowDocuments = await Array.fromAsync(
  new Bun.Glob(".github/workflows/*.yml").scan({
    cwd: fileURLToPath(new URL("../../..", import.meta.url)),
    absolute: true,
  }),
  async (path) =>
    Schema.decodeUnknownSync(WorkflowDocument)(Bun.YAML.parse(await Bun.file(path).text())),
);

type ShellResult = {
  readonly exitCode: number;
  readonly output: string;
  readonly stderr: string;
  readonly stdout: string;
};

const executeShell = async (
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<ShellResult> => {
  const directory = await mkdtemp(join(tmpdir(), "release-workflow-gate-"));
  const outputPath = join(directory, "github-output");
  try {
    const child = Bun.spawn(["bash", "-e", "-c", script], {
      env: { ...process.env, ...environment, GITHUB_OUTPUT: outputPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const output = await readFile(outputPath, "utf8").catch(() => "");
    return { exitCode, output, stderr, stdout };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

describe("release workflow publication gate", () => {
  test("sets up Bun and installs dependencies before every Bun command", () => {
    for (const document of workflowDocuments) {
      for (const job of Object.values(document.jobs)) {
        const steps = job.steps ?? [];
        const firstBunStepIndex = steps.findIndex((step) =>
          step.run?.match(/(^|\s)bun(?:x)?(?:\s|$)/m),
        );
        if (firstBunStepIndex < 0) continue;
        expect(steps[firstBunStepIndex]?.run).toBe("bun install --frozen-lockfile");
        expect(
          steps
            .slice(0, firstBunStepIndex)
            .some(
              (step) =>
                step.uses === "oven-sh/setup-bun@v2" && step.with?.["bun-version"] === "1.4.0",
            ),
        ).toBe(true);
      }
    }
  });

  test("scoped tag pushes verify but cannot publish", () => {
    expect(workflow).toContain('tags:\n      - "*@*.*.*"');
    expect(workflow).not.toContain('tags:\n      - "v*.*.*"');
    expect(workflow.match(/if: github\.event_name == 'workflow_dispatch'/g)).toHaveLength(2);
    expect(workflow).toContain("uses: ./.github/workflows/ci.yml");
  });

  test("dispatch requires an exact tag-bound confirmation", () => {
    expect(workflow).toContain("confirm_tag:");
    expect(workflow).toContain('[[ "$CONFIRM_TAG" == "$tag" ]]');
    expect(workflow).toContain("Publication confirmation must exactly match $tag.");
    expect(workflow).toContain('[[ "$EVENT_REF" == "refs/tags/$tag" ]]');
    expect(workflow.match(/environment: publication/g)).toHaveLength(3);
  });

  test("resolves one package manifest and archive through the release canary script", () => {
    expect(workflow).toContain(
      'bun scripts/release-canary.ts --tag "$tag" --github-output "$GITHUB_OUTPUT"',
    );
    expect(workflow).not.toContain("for candidate in packages/*/package.json");
    expect(workflow).not.toContain("jq -r .version");
    expect(workflow).toContain('npm publish "./dist-release/$ARCHIVE"');
  });

  test("checks out and validates the exact existing tag commit", () => {
    expect(workflow).toContain(
      "ref: ${{ github.event_name == 'workflow_dispatch' && inputs.tag || github.ref }}",
    );
    expect(workflow).toContain('git show-ref --verify --quiet "refs/tags/$tag"');
    expect(workflow).toContain('tag_commit="$(git rev-list -n 1 "$tag")"');
    expect(workflow).toContain('head_commit="$(git rev-parse HEAD)"');
    expect(workflow).toContain('[[ "$head_commit" == "$tag_commit" ]]');
  });

  test("executes both canary gates and rejects every result except success", async () => {
    for (const document of [parsedReleaseWorkflow, parsedReleasePreflightWorkflow]) {
      const gateStep = document.jobs["canary-gate"].steps[0];
      expect(gateStep?.run).toBeDefined();
      if (gateStep?.run === undefined) throw new Error("The canary gate script is missing.");
      for (const canaryResult of ["success", "failure", "skipped", "cancelled", "", undefined]) {
        const result = await executeShell(gateStep.run, {
          DEPLOYED_CANARY_RESULT: canaryResult,
        });
        expect(result.exitCode).toBe(canaryResult === "success" ? 0 : 1);
        expect(result.output).toBe("");
        expect(result.stderr).toBe("");
        expect(result.stdout).toBe("");
      }
    }
  });

  test("gates publication on the direct protected job result", () => {
    expect(parsedReleaseWorkflow.jobs["deployed-canary"].if).toBeUndefined();
    for (const document of [parsedReleaseWorkflow, parsedReleasePreflightWorkflow]) {
      expect(document.jobs["deployed-canary"]["continue-on-error"]).toBeUndefined();
      expect(document.jobs["canary-gate"].needs).toBe("deployed-canary");
      expect(document.jobs["canary-gate"].if).toBe("${{ !cancelled() }}");
      expect(document.jobs["canary-gate"].steps[0]?.env?.DEPLOYED_CANARY_RESULT).toBe(
        "${{ needs.deployed-canary.result }}",
      );
    }
  });

  test("keeps the deployed canary job timeout above the suite budget", () => {
    for (const document of [parsedReleaseWorkflow, parsedReleasePreflightWorkflow]) {
      const timeoutMinutes = document.jobs["deployed-canary"]["timeout-minutes"];
      expect(timeoutMinutes).toBeDefined();
      expect((timeoutMinutes ?? 0) * 60_000).toBeGreaterThanOrEqual(
        deployedCanarySuiteTimeoutMilliseconds + 3 * 60_000,
      );
    }
  });

  test("builds a release graph that cannot bypass the canary gate", () => {
    expect(parsedReleaseWorkflow.jobs.verify.uses).toBe("./.github/workflows/ci.yml");
    expect(parsedReleaseWorkflow.jobs["deployed-canary"].needs).toEqual(["tag-check", "verify"]);
    expect(parsedReleaseWorkflow.jobs.release.needs).toEqual([
      "tag-check",
      "verify",
      "canary-gate",
    ]);
    expect(parsedReleaseWorkflow.jobs["publish-npm"].needs).toEqual(["tag-check", "release"]);
    for (const job of [
      parsedReleaseWorkflow.jobs.release,
      parsedReleaseWorkflow.jobs["publish-npm"],
    ]) {
      expect(job.if).toBe("github.event_name == 'workflow_dispatch'");
      expect(job.environment).toBe("publication");
    }
  });

  test("uses publication environment secrets without inert caller plumbing", () => {
    expect(parsedCiWorkflow.on.workflow_call.secrets).toBeUndefined();
    for (const document of [parsedReleaseWorkflow, parsedReleasePreflightWorkflow]) {
      const canary = document.jobs["deployed-canary"];
      expect(canary.environment).toBe("publication");
      expect(canary["runs-on"]).toBe("ubuntu-latest");
      expect(canary.uses).toBeUndefined();
      expect(canary.env).toBeUndefined();
      expect(canary.permissions).toBeUndefined();
    }
    for (const document of workflowDocuments) {
      expect(document.permissions).toEqual({ contents: "read" });
      expect(document.env).toBeUndefined();
    }
    expect(workflow).not.toContain("secrets: inherit");
    expect(releasePreflightWorkflow).not.toContain("secrets: inherit");
    expect(releasePreflightWorkflow).not.toContain("NPM_TOKEN");
    expect(ciWorkflow).not.toContain("secrets.");
    expect(ciWorkflow).not.toContain("NPM_TOKEN");
    expect(ciWorkflow).not.toContain("environment:");
    expect(ciWorkflow).not.toContain("deployed-canary:");
    expect(parsedReleaseWorkflow.jobs.verify.secrets).toBeUndefined();
  });

  test("isolates ingest, read and npm credentials to their owning steps", () => {
    const canary = parsedReleaseWorkflow.jobs["deployed-canary"];
    expect(canary.env).toBeUndefined();
    const steps = canary.steps ?? [];
    const ingestStep = steps.find((step) => step.name === "Start the production collector");
    const readStep = steps.find((step) => step.name === "Run the deployed release canary");
    const schemaStep = steps.find((step) => step.name === "Report failed canary dataset schemas");
    expect(ingestStep?.env?.AXIOM_INGEST_TOKEN).toBe("${{ secrets.AXIOM_INGEST_TOKEN }}");
    expect(ingestStep?.run).toContain("--require-credential AXIOM_INGEST_TOKEN");
    expect(readStep?.env?.AXIOM_READ_TOKEN).toBe("${{ secrets.AXIOM_READ_TOKEN }}");
    expect(readStep?.run).toContain("--require-credential AXIOM_READ_TOKEN");
    for (const step of steps) {
      if (step !== ingestStep) expect(step.env?.AXIOM_INGEST_TOKEN).toBeUndefined();
      if (step !== readStep && step !== schemaStep) {
        expect(step.env?.AXIOM_READ_TOKEN).toBeUndefined();
      }
      expect(step.env?.NODE_AUTH_TOKEN).toBeUndefined();
    }
    expect(workflow.match(/secrets\.NPM_TOKEN/g)).toHaveLength(1);
    expect(workflow.split("  publish-npm:")[0]).not.toContain("NPM_TOKEN");
  });

  test("requires and counts the deployed canary test", () => {
    const canaryStep = parsedReleaseWorkflow.jobs["deployed-canary"].steps?.find(
      (step) => step.name === "Run the deployed release canary",
    );
    expect(canaryStep?.env?.OBSERVABILITY_E2E_DEPLOYED).toBe("1");
    expect(canaryStep?.run).toContain("bun run test:canary:deployed");
  });

  test("derives the deployed canary service version from its release tag input", () => {
    expect(parsedCiWorkflow.on.workflow_call.inputs.ref).toEqual({
      required: false,
      type: "string",
    });
    expect(parsedReleaseWorkflow.jobs.verify.with.ref).toBe("${{ needs.tag-check.outputs.tag }}");
    const steps = parsedReleaseWorkflow.jobs["deployed-canary"].steps ?? [];
    expect(steps[0]?.with?.ref).toBe("${{ needs.tag-check.outputs.tag }}");
    expect(
      steps.find((step) => step.name === "Resolve release canary identity")?.env?.RELEASE_TAG,
    ).toBe("${{ needs.tag-check.outputs.tag }}");
    expect(workflow).toContain(
      'bun scripts/release-canary.ts --tag "$RELEASE_TAG" --github-env "$GITHUB_ENV"',
    );
    expect(releaseCanaryScript).toContain("OTEL_SERVICE_VERSION");
    expect(workflow).not.toMatch(/serviceVersion: ["']\d+\.\d+\.\d+/);
  });

  test("keeps ordinary CI credential-free and reports the omitted protected gate", () => {
    const reportStep = parsedCiWorkflow.jobs.verify.steps?.find(
      (step) => step.name === "Report deployed canary status",
    );
    expect(reportStep?.if).toBeUndefined();
    expect(reportStep?.run).toContain("runs directly in the Release workflow");
    expect(Object.keys(parsedCiWorkflow.jobs)).toEqual(["verify"]);
  });

  test("mounts a private writable queue without running the Collector as root", () => {
    const start = parsedReleaseWorkflow.jobs["deployed-canary"].steps?.find(
      (step) => step.name === "Start the production collector",
    )?.run;
    expect(start).toContain('queue_directory="${RUNNER_TEMP:?}/release-canary-queue"');
    expect(start).toContain('sudo install -d -m 0700 -o 10001 -g 10001 "$queue_directory"');
    expect(start).toContain('-v "$queue_directory:/var/lib/otelcol/queue"');
    expect(start).toContain("-p 127.0.0.1:24319:13133");
    expect(start).not.toContain("--user");
    expect(start).not.toContain("sudo docker");
    expect(start).not.toContain("--privileged");
  });

  test("requires health success and diagnoses exited or unready Collectors", async () => {
    const start = parsedReleaseWorkflow.jobs["deployed-canary"].steps?.find(
      (step) => step.name === "Start the production collector",
    )?.run;
    if (start === undefined) throw new Error("The Collector startup script is missing.");
    const commands = `
      bun() { return 0; }
      sudo() { printf '%s\\n' "sudo $*" >&2; }
      sleep() { return 0; }
      docker() {
        printf '%s\\n' "docker $*" >&2
        case "$1" in
          run) [[ "$STARTUP_CASE" != "run-failed" ]] ;;
          inspect)
            if [[ "$3" == '{{.State.Running}}' ]]; then
              [[ "$STARTUP_CASE" != "exited" ]] && echo true || echo false
            else
              echo 'startup state'
            fi ;;
          logs) echo 'startup logs' ;;
        esac
      }
      curl() {
        printf '%s\\n' "curl $*" >&2
        [[ "$*" == '--fail --silent --show-error --connect-timeout 1 --max-time 2 -o /dev/null http://127.0.0.1:24319/health' ]] || return 2
        [[ "$STARTUP_CASE" == "healthy" ]]
      }
    `;
    for (const scenario of ["healthy", "exited", "timeout", "run-failed"]) {
      const result = await executeShell(`${commands}\n${start}`, {
        STARTUP_CASE: scenario,
        RUNNER_TEMP: "/runner temp",
        AXIOM_INGEST_TOKEN: "ingest-test",
      });
      expect(result.exitCode).toBe(scenario === "healthy" ? 0 : 1);
      expect(result.stderr).toContain(
        "sudo install -d -m 0700 -o 10001 -g 10001 /runner temp/release-canary-queue",
      );
      expect(result.stderr).toContain(
        "-v /runner temp/release-canary-queue:/var/lib/otelcol/queue",
      );
      const attempts = result.stderr.match(/curl --fail/g) ?? [];
      expect(attempts).toHaveLength(scenario === "healthy" ? 1 : scenario === "timeout" ? 30 : 0);
      if (scenario === "healthy") {
        expect(result.stderr).not.toContain("docker logs");
      } else {
        expect(result.stderr).toContain("docker inspect --format {{json .State}} otel-production");
        expect(result.stderr).toContain("docker logs --tail 100 otel-production");
        expect(result.stdout).toContain("startup logs");
      }
      if (scenario === "exited") expect(result.stdout).toContain("exited before becoming healthy");
      if (scenario === "timeout") expect(result.stdout).toContain("after 30 attempts");
      expect(result.stderr).not.toContain("ingest-test");
    }
  });

  test("preserves Collector diagnostics before cleaning a failed canary", () => {
    const steps = parsedReleaseWorkflow.jobs["deployed-canary"].steps ?? [];
    const canaryIndex = steps.findIndex((step) => step.name === "Run the deployed release canary");
    const logsIndex = steps.findIndex(
      (step) => step.name === "Report failed canary Collector logs",
    );
    const cleanupIndex = steps.findIndex((step) => step.name === "Clean the production collector");
    expect(logsIndex).toBeGreaterThan(canaryIndex);
    expect(cleanupIndex).toBeGreaterThan(logsIndex);
    expect(steps[logsIndex]?.if).toBe("failure()");
    expect(steps[logsIndex]?.run).toBe("docker logs --tail 100 otel-production 2>&1 || true");
    expect(steps[logsIndex]?.env).toBeUndefined();
  });

  test("always cleans only its Collector and queue even if container removal fails", async () => {
    const cleanup = parsedReleaseWorkflow.jobs["deployed-canary"].steps?.find(
      (step) => step.name === "Clean the production collector",
    );
    expect(cleanup?.if).toBe("always()");
    if (cleanup?.run === undefined) throw new Error("The Collector cleanup script is missing.");
    const commands = `
      docker() { printf '%s\\n' "docker $*"; return 1; }
      sudo() { printf '%s\\n' "sudo $*"; }
    `;
    const result = await executeShell(`${commands}\n${cleanup.run}`, {
      RUNNER_TEMP: "/runner temp",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(
      "docker rm -f otel-production\nsudo rm -rf -- /runner temp/release-canary-queue\n",
    );
    const missingTemp = await executeShell(`${commands}\n${cleanup.run}`, {
      RUNNER_TEMP: undefined,
    });
    expect(missingTemp.exitCode).not.toBe(0);
    expect(missingTemp.stdout).not.toContain("sudo rm");
  });

  test("keeps the ingest token out of the docker command arguments", () => {
    expect(workflow).toContain('export AXIOM_TOKEN="$AXIOM_INGEST_TOKEN"');
    expect(workflow).toContain("-e AXIOM_TOKEN \\");
    expect(workflow).not.toContain('-e AXIOM_TOKEN="$AXIOM_INGEST_TOKEN"');
  });

  test("keeps direct protected canary steps identical except checkout and candidate identity", () => {
    const releaseSteps = parsedReleaseWorkflow.jobs["deployed-canary"].steps ?? [];
    const preflightSteps = parsedReleasePreflightWorkflow.jobs["deployed-canary"].steps ?? [];
    expect(releaseSteps.length).toBeGreaterThan(0);
    expect(preflightSteps).toHaveLength(releaseSteps.length);
    for (const [index, step] of releaseSteps.entries()) {
      if (step.uses === "actions/checkout@v4") {
        expect(preflightSteps[index]).toEqual({
          ...step,
          with: { ref: "${{ github.sha }}" },
        });
      } else if (step.name === "Resolve release canary identity") {
        expect(preflightSteps[index]).toEqual({
          ...step,
          env: { RELEASE_TAG: "${{ format('{0}@{1}', inputs.package, inputs.version) }}" },
        });
      } else {
        expect(preflightSteps[index]).toEqual(step);
      }
    }
  });

  test("runs preflight canary only after readiness on the immutable master dispatch commit", () => {
    const { readiness, "deployed-canary": canary } = parsedReleasePreflightWorkflow.jobs;
    expect(canary.needs).toEqual(["readiness"]);
    expect(canary.if).toBe("github.ref == 'refs/heads/master'");
    expect(readiness["continue-on-error"]).toBeUndefined();
    expect(readiness.steps?.find((step) => step.uses === "actions/checkout@v4")?.with?.ref).toBe(
      "${{ github.sha }}",
    );
    expect(Object.keys(parsedReleasePreflightWorkflow.jobs)).toEqual([
      "readiness",
      "deployed-canary",
      "canary-gate",
    ]);
    expect(releasePreflightWorkflow).not.toContain("refs/tags/");
    expect(releasePreflightWorkflow).not.toContain("git show-ref");
    expect(releasePreflightWorkflow).not.toContain("gh release");
    expect(releasePreflightWorkflow).not.toContain("npm publish");
    expect(releasePreflightWorkflow).not.toMatch(/git (?:tag|push)/);
  });

  test("rejects preflight dispatch outside master before readiness", async () => {
    const requireBranch = parsedReleasePreflightWorkflow.jobs.readiness.steps?.[0];
    expect(requireBranch?.name).toBe("Require the default branch");
    expect(requireBranch?.env?.EVENT_REF).toBe("${{ github.ref }}");
    if (requireBranch?.run === undefined) throw new Error("The preflight branch check is missing.");
    for (const ref of [
      "refs/heads/master",
      "refs/heads/feature",
      "refs/tags/observability@0.3.0",
      "",
      undefined,
    ]) {
      const result = await executeShell(requireBranch.run, { EVENT_REF: ref });
      expect(result.exitCode).toBe(ref === "refs/heads/master" ? 0 : 1);
    }
  });

  test("diagnoses only failed canaries with bounded read-only dataset schema access", () => {
    for (const document of [parsedReleaseWorkflow, parsedReleasePreflightWorkflow]) {
      const steps = document.jobs["deployed-canary"].steps ?? [];
      const canaryIndex = steps.findIndex(
        (step) => step.name === "Run the deployed release canary",
      );
      const schemaIndex = steps.findIndex(
        (step) => step.name === "Report failed canary dataset schemas",
      );
      const cleanupIndex = steps.findIndex(
        (step) => step.name === "Clean the production collector",
      );
      const schemaStep = steps[schemaIndex];
      expect(steps[canaryIndex]?.id).toBe("canary");
      expect(schemaIndex).toBeGreaterThan(canaryIndex);
      expect(cleanupIndex).toBeGreaterThan(schemaIndex);
      expect(schemaStep?.if).toBe("failure() && steps.canary.outcome == 'failure'");
      expect(schemaStep?.["timeout-minutes"]).toBe(2);
      expect(schemaStep?.run).toBe("bun scripts/axiom-schema.ts");
      expect(schemaStep?.env).toEqual({
        AXIOM_READ_TOKEN: "${{ secrets.AXIOM_READ_TOKEN }}",
        AXIOM_ORGANIZATION_ID: "${{ vars.AXIOM_ORGANIZATION_ID }}",
        AXIOM_URL: "${{ vars.AXIOM_URL }}",
        AXIOM_DATASET_TRACES: "${{ vars.AXIOM_DATASET_TRACES }}",
        AXIOM_DATASET_LOGS: "${{ vars.AXIOM_DATASET_LOGS }}",
        AXIOM_DATASET_METRICS: "${{ vars.AXIOM_DATASET_METRICS }}",
      });
      for (const step of steps) expect(step["continue-on-error"]).toBeUndefined();
    }
  });

  test("uses release canary identity resolution in preflight", () => {
    const steps = parsedReleasePreflightWorkflow.jobs.readiness?.steps ?? [];
    const resolveStepIndex = steps.findIndex(
      (step) => step.name === "Resolve the selected release",
    );
    const validateStepIndex = steps.findIndex(
      (step) => step.name === "Validate the selected release",
    );
    expect(resolveStepIndex).toBeGreaterThanOrEqual(0);
    expect(validateStepIndex).toBeGreaterThan(resolveStepIndex);
    expect(releasePreflightWorkflow).toContain(
      'bun scripts/release-canary.ts --tag "$SLUG@$VERSION" --github-env "$GITHUB_ENV"',
    );
    expect(releasePreflightWorkflow).toContain(
      'bun scripts/npm-publication-state.ts "$RELEASE_PACKAGE_NAME" "$VERSION"',
    );
    expect(releasePreflightWorkflow).not.toContain('"@equipe-tech/$SLUG"');
    expect(releasePreflightWorkflow).not.toContain("for candidate in packages/*/package.json");
    expect(releasePreflightWorkflow).not.toContain("jq -r .version");
  });

  test("rebuilds and verifies the archive before publication", () => {
    expect(workflow.match(/bun scripts\/release-candidate\.ts/g)).toHaveLength(2);
    expect(workflow.match(/sha256sum --check/g)).toHaveLength(2);
    expect(workflow).toContain('cmp ".release-candidate/$ARCHIVE" "dist-release/$ARCHIVE"');
  });

  test("passes the archive to the real npm publish parser without Git interpretation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "npm-publication-path-"));
    try {
      const packageDirectory = join(directory, "package");
      const archiveDirectory = join(directory, "dist-release");
      await mkdir(packageDirectory);
      await mkdir(archiveDirectory);
      await writeFile(
        join(packageDirectory, "package.json"),
        JSON.stringify({
          name: "release-path-fixture",
          version: "0.0.0",
        }),
      );
      const archive = "release-path-fixture-0.0.0.tgz";
      const pack = Bun.spawn(
        ["tar", "-czf", join(archiveDirectory, archive), "-C", directory, "package"],
        {
          stdout: "ignore",
          stderr: "pipe",
          timeout: 10_000,
        },
      );
      const [packExit, packError] = await Promise.all([
        pack.exited,
        new Response(pack.stderr).text(),
      ]);
      expect(packExit).toBe(0);
      expect(packError).toBe("");
      const publication = workflow.match(/^\s*npm publish .+$/m)?.[0];
      if (publication === undefined) throw new Error("The npm publication command is missing.");
      const userConfig = join(directory, "npmrc");
      await writeFile(userConfig, "");
      const child = Bun.spawn(
        [
          "bash",
          "-eu",
          "-c",
          `${publication} --dry-run --offline --ignore-scripts --json=false --registry http://127.0.0.1:1 --userconfig "$USER_CONFIG"`,
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            ARCHIVE: archive,
            NPM_TAG: "latest",
            NODE_AUTH_TOKEN: "",
            USER_CONFIG: userConfig,
            NPM_CONFIG_CACHE: join(directory, "npm-cache"),
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "protocol.allow",
            GIT_CONFIG_VALUE_0: "never",
          },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        },
      );
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe("+ release-path-fixture@0.0.0");
      expect(stderr).not.toContain("ls-remote");
      expect(stderr).not.toContain("npm error");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("converges when release and npm publication already exist", () => {
    expect(workflow).toContain('if ! gh release view "$TAG"');
    expect(workflow).toContain("--clobber");
    expect(workflow).toContain('state="$(bun scripts/npm-publication-state.ts');
    expect(workflow).toContain('if [[ "$state" == "published" ]]; then exit 0; fi');
  });
});
