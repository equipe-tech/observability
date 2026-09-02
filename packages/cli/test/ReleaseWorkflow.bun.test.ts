import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
  CANARY_REQUESTED: Schema.optionalKey(Schema.String),
  CANARY_RESULT: Schema.optionalKey(Schema.String),
  DEPLOYED_CANARY_RESULT: Schema.optionalKey(Schema.String),
});

const WorkflowStep = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Struct({ "bun-version": Schema.optionalKey(Schema.String) })),
  env: Schema.optionalKey(WorkflowEnvironment),
});

const WorkflowDocument = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({ steps: Schema.optionalKey(Schema.Array(WorkflowStep)) }),
  ),
});

const ConditionalJob = Schema.Struct({
  if: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Array(WorkflowStep)),
});

const GateJob = Schema.Struct({
  if: Schema.String,
  needs: Schema.Array(Schema.String),
  outputs: Schema.Struct({ result: Schema.String }),
  steps: Schema.Array(WorkflowStep),
});

const WorkflowSecrets = Schema.Struct({
  AXIOM_INGEST_TOKEN: Schema.optionalKey(Schema.String),
  AXIOM_READ_TOKEN: Schema.optionalKey(Schema.String),
});

const ReusableWorkflowJob = Schema.Struct({
  uses: Schema.String,
  with: Schema.Struct({
    ref: Schema.String,
    release_tag: Schema.String,
    run_deployed_canary: Schema.Boolean,
  }),
  secrets: Schema.optionalKey(WorkflowSecrets),
});

const DependentJob = Schema.Struct({ needs: Schema.Array(Schema.String) });

const ReleaseGateJob = Schema.Struct({
  needs: Schema.String,
  steps: Schema.Array(WorkflowStep),
});

const CiWorkflow = Schema.Struct({
  on: Schema.Struct({
    workflow_call: Schema.Struct({
      inputs: Schema.Struct({
        release_tag: Schema.Struct({ required: Schema.Boolean, type: Schema.String }),
      }),
      outputs: Schema.Struct({
        deployed_canary_result: Schema.Struct({ value: Schema.String }),
      }),
      secrets: Schema.optionalKey(WorkflowSecrets),
    }),
  }),
  jobs: Schema.Struct({
    verify: ConditionalJob,
    "deployed-canary": ConditionalJob,
    "canary-gate": GateJob,
  }),
});

const ReleaseWorkflow = Schema.Struct({
  jobs: Schema.Struct({
    verify: ReusableWorkflowJob,
    "canary-gate": ReleaseGateJob,
    release: DependentJob,
    "publish-npm": DependentJob,
  }),
});

const parsedCiWorkflow = Schema.decodeUnknownSync(CiWorkflow)(Bun.YAML.parse(ciWorkflow));
const parsedReleaseWorkflow = Schema.decodeUnknownSync(ReleaseWorkflow)(Bun.YAML.parse(workflow));
const workflowDocuments = [
  Schema.decodeUnknownSync(WorkflowDocument)(Bun.YAML.parse(ciWorkflow)),
  Schema.decodeUnknownSync(WorkflowDocument)(Bun.YAML.parse(workflow)),
];

type GateCase = {
  readonly requested: "true" | "false";
  readonly result: "success" | "failure" | "skipped" | "cancelled";
  readonly exitCode: number;
  readonly output: string;
};

type ShellResult = {
  readonly exitCode: number;
  readonly output: string;
  readonly stderr: string;
  readonly stdout: string;
};

const gateCases: ReadonlyArray<GateCase> = [
  { requested: "false", result: "skipped", exitCode: 0, output: "result=not-requested\n" },
  { requested: "false", result: "failure", exitCode: 0, output: "result=not-requested\n" },
  { requested: "true", result: "success", exitCode: 0, output: "result=success\n" },
  { requested: "true", result: "failure", exitCode: 1, output: "" },
  { requested: "true", result: "skipped", exitCode: 1, output: "" },
  { requested: "true", result: "cancelled", exitCode: 1, output: "" },
];

const executeShell = async (
  script: string,
  environment: NodeJS.ProcessEnv,
): Promise<ShellResult> => {
  const directory = await mkdtemp(join(tmpdir(), "release-workflow-gate-"));
  const outputPath = join(directory, "github-output");
  try {
    const child = Bun.spawn(["bash", "-euo", "pipefail", "-c", script], {
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
    expect(workflow.match(/environment: publication/g)).toHaveLength(2);
  });

  test("resolves one package manifest and archive through the release canary script", () => {
    expect(workflow).toContain(
      'bun scripts/release-canary.ts --tag "$tag" --github-output "$GITHUB_OUTPUT"',
    );
    expect(workflow).not.toContain("for candidate in packages/*/package.json");
    expect(workflow).not.toContain("jq -r .version");
    expect(workflow).toContain('npm publish "dist-release/$ARCHIVE"');
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

  test("executes the reusable workflow canary gate script", async () => {
    const gateStep = parsedCiWorkflow.jobs["canary-gate"].steps.find(
      (step) => step.id === "result",
    );
    expect(gateStep?.run).toBeDefined();
    if (gateStep?.run === undefined) throw new Error("The reusable canary gate script is missing.");
    for (const gateCase of gateCases) {
      const result = await executeShell(gateStep.run, {
        CANARY_REQUESTED: gateCase.requested,
        CANARY_RESULT: gateCase.result,
      });
      expect(result.exitCode).toBe(gateCase.exitCode);
      expect(result.output).toBe(gateCase.output);
      expect(result.stderr).toBe("");
      if (gateCase.exitCode === 1) {
        expect(result.stdout).toContain("The requested deployed canary did not succeed.");
      } else {
        expect(result.stdout).toBe("");
      }
    }
  });

  test("executes the release workflow canary gate script", async () => {
    const gateStep = parsedReleaseWorkflow.jobs["canary-gate"].steps?.[0];
    expect(gateStep?.run).toBeDefined();
    if (gateStep?.run === undefined) throw new Error("The release canary gate script is missing.");
    for (const canaryResult of ["success", "failure", "skipped", "cancelled"]) {
      const result = await executeShell(gateStep.run, {
        CANARY_REQUESTED: "true",
        CANARY_RESULT: canaryResult,
        DEPLOYED_CANARY_RESULT: canaryResult,
      });
      expect(result.exitCode).toBe(canaryResult === "success" ? 0 : 1);
      expect(result.output).toBe("");
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("");
    }
  });

  test("wires the reusable gate output into the release gate", () => {
    expect(parsedCiWorkflow.on.workflow_call.outputs.deployed_canary_result.value).toBe(
      "${{ jobs.canary-gate.outputs.result }}",
    );
    expect(parsedCiWorkflow.jobs["canary-gate"].outputs.result).toBe(
      "${{ steps.result.outputs.result }}",
    );
    expect(parsedReleaseWorkflow.jobs["canary-gate"].steps?.[0]?.env?.DEPLOYED_CANARY_RESULT).toBe(
      "${{ needs.verify.outputs.deployed_canary_result }}",
    );
  });

  test("builds a release graph that cannot bypass the canary gate", () => {
    expect(parsedReleaseWorkflow.jobs.verify.uses).toBe("./.github/workflows/ci.yml");
    expect(parsedReleaseWorkflow.jobs.verify.with.run_deployed_canary).toBe(true);
    expect(parsedCiWorkflow.jobs["canary-gate"].needs).toEqual(["verify", "deployed-canary"]);
    expect(parsedReleaseWorkflow.jobs.release.needs).toContain("canary-gate");
    expect(parsedReleaseWorkflow.jobs["publish-npm"].needs).toContain("release");
  });

  test("uses publication environment secrets without inert caller plumbing", () => {
    expect(parsedCiWorkflow.on.workflow_call.secrets).toBeUndefined();
    expect(parsedCiWorkflow.jobs["deployed-canary"].environment).toBe("publication");
    expect(parsedReleaseWorkflow.jobs.verify.secrets).toBeUndefined();
  });

  test("requires and counts an explicitly requested deployed canary test", () => {
    const canaryStep = parsedCiWorkflow.jobs["deployed-canary"].steps?.find(
      (step) => step.name === "Run the deployed release canary",
    );
    expect(canaryStep?.env?.OBSERVABILITY_E2E_DEPLOYED).toBe("1");
    expect(canaryStep?.run).toContain("bun run test:canary:deployed");
  });

  test("derives the deployed canary service version from its release tag input", () => {
    expect(parsedCiWorkflow.on.workflow_call.inputs.release_tag).toEqual({
      required: false,
      type: "string",
    });
    expect(parsedReleaseWorkflow.jobs.verify.with.release_tag).toBe(
      "${{ needs.tag-check.outputs.tag }}",
    );
    expect(parsedReleaseWorkflow.jobs.verify.with.ref).toBe("${{ needs.tag-check.outputs.tag }}");
    expect(ciWorkflow).toContain("RELEASE_TAG: ${{ inputs.release_tag }}");
    expect(ciWorkflow).toContain(
      'bun scripts/release-canary.ts --tag "$RELEASE_TAG" --github-env "$GITHUB_ENV"',
    );
    expect(releaseCanaryScript).toContain("OTEL_SERVICE_VERSION");
    expect(ciWorkflow).not.toMatch(/serviceVersion: ["']\d+\.\d+\.\d+/);
  });

  test("keeps ordinary CI credential-free and reports the omitted protected gate", () => {
    const reportStep = parsedCiWorkflow.jobs.verify.steps?.find(
      (step) => step.name === "Report deployed canary status",
    );
    expect(parsedCiWorkflow.jobs["deployed-canary"].if).toBe("${{ inputs.run_deployed_canary }}");
    expect(reportStep?.if).toBe("${{ !inputs.run_deployed_canary }}");
    expect(parsedCiWorkflow.jobs["canary-gate"].if).toBe("${{ !cancelled() }}");
  });

  test("keeps the ingest token out of the docker command arguments", () => {
    expect(ciWorkflow).toContain('export AXIOM_TOKEN="$AXIOM_INGEST_TOKEN"');
    expect(ciWorkflow).toContain("-e AXIOM_TOKEN \\");
    expect(ciWorkflow).not.toContain('-e AXIOM_TOKEN="$AXIOM_INGEST_TOKEN"');
  });

  test("uses release canary identity resolution in preflight", () => {
    expect(releasePreflightWorkflow).toContain(
      'bun scripts/release-canary.ts --tag "$SLUG@$VERSION" --github-env "$GITHUB_ENV"',
    );
    expect(releasePreflightWorkflow).not.toContain("for candidate in packages/*/package.json");
    expect(releasePreflightWorkflow).not.toContain("jq -r .version");
  });

  test("rebuilds and verifies the archive before publication", () => {
    expect(workflow.match(/bun scripts\/release-candidate\.ts/g)).toHaveLength(2);
    expect(workflow.match(/sha256sum --check/g)).toHaveLength(2);
    expect(workflow).toContain('cmp ".release-candidate/$ARCHIVE" "dist-release/$ARCHIVE"');
  });

  test("converges when release and npm publication already exist", () => {
    expect(workflow).toContain('if ! gh release view "$TAG"');
    expect(workflow).toContain("--clobber");
    expect(workflow).toContain('state="$(bun scripts/npm-publication-state.ts');
    expect(workflow).toContain('if [[ "$state" == "published" ]]; then exit 0; fi');
  });
});
