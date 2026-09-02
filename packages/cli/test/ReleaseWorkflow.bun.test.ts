import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(
  new URL("../../../.github/workflows/release.yml", import.meta.url),
);

const ciWorkflowPath = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

const releaseCanaryScriptPath = fileURLToPath(
  new URL("../../../scripts/release-canary.ts", import.meta.url),
);

const workflow = await Bun.file(workflowPath).text();
const ciWorkflow = await Bun.file(ciWorkflowPath).text();
const releaseCanaryScript = await Bun.file(releaseCanaryScriptPath).text();

const WorkflowStep = Schema.Struct({
  name: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(Schema.Struct({ "bun-version": Schema.optionalKey(Schema.String) })),
  env: Schema.optionalKey(
    Schema.Struct({ OBSERVABILITY_E2E_DEPLOYED: Schema.optionalKey(Schema.String) }),
  ),
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
});

const WorkflowSecrets = Schema.Struct({
  AXIOM_INGEST_TOKEN: Schema.optionalKey(Schema.String),
  AXIOM_READ_TOKEN: Schema.optionalKey(Schema.String),
});

const ReusableWorkflowJob = Schema.Struct({
  uses: Schema.String,
  with: Schema.Struct({ run_deployed_canary: Schema.Boolean }),
  secrets: Schema.optionalKey(WorkflowSecrets),
});

const DependentJob = Schema.Struct({ needs: Schema.Array(Schema.String) });

const CiWorkflow = Schema.Struct({
  on: Schema.Struct({
    workflow_call: Schema.Struct({ secrets: Schema.optionalKey(WorkflowSecrets) }),
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

type WorkflowContext = {
  readonly eventName: "push" | "pull_request" | "workflow_call";
  readonly runDeployedCanary: boolean;
};

type JobResult = "success" | "skipped" | "failure";

const ordinaryEvents: ReadonlyArray<WorkflowContext["eventName"]> = ["push", "pull_request"];

const evaluateWorkflowCondition = (
  expression: string | undefined,
  context: WorkflowContext,
): boolean => {
  if (expression === undefined) return true;
  const condition = expression
    .replace(/^\$\{\{\s*/, "")
    .replace(/\s*}}$/, "")
    .trim();
  const disjunction = condition.split("||");
  if (disjunction.length > 1) {
    return disjunction.some((part) => evaluateWorkflowCondition(part.trim(), context));
  }
  const conjunction = condition.split("&&");
  if (conjunction.length > 1) {
    return conjunction.every((part) => evaluateWorkflowCondition(part.trim(), context));
  }
  if (condition.startsWith("!")) {
    return !evaluateWorkflowCondition(condition.slice(1).trim(), context);
  }
  if (condition === "inputs.run_deployed_canary") return context.runDeployedCanary;
  if (condition === "always()") return true;
  const eventComparison = /^github\.event_name\s*(==|!=)\s*'([^']+)'$/.exec(condition);
  if (eventComparison !== null) {
    const [, operator, eventName] = eventComparison;
    return operator === "==" ? context.eventName === eventName : context.eventName !== eventName;
  }
  throw new Error(`Unsupported workflow condition: ${condition}`);
};

const evaluateCiGraph = (context: WorkflowContext): Map<string, JobResult> => {
  const results = new Map<string, JobResult>();
  results.set("verify", "success");
  const deployedCanaryResult = evaluateWorkflowCondition(
    parsedCiWorkflow.jobs["deployed-canary"].if,
    context,
  )
    ? "success"
    : "skipped";
  results.set("deployed-canary", deployedCanaryResult);
  const gateRuns = evaluateWorkflowCondition(parsedCiWorkflow.jobs["canary-gate"].if, context);
  const gateResult = gateRuns
    ? context.runDeployedCanary && deployedCanaryResult !== "success"
      ? "failure"
      : "success"
    : "skipped";
  results.set("canary-gate", gateResult);
  return results;
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

  test("evaluates the deployed canary gate for every caller event", () => {
    const events: ReadonlyArray<WorkflowContext["eventName"]> = [
      "push",
      "pull_request",
      "workflow_call",
    ];
    for (const eventName of events) {
      const omitted = evaluateCiGraph({ eventName, runDeployedCanary: false });
      expect(omitted.get("deployed-canary")).toBe("skipped");
      expect(omitted.get("canary-gate")).toBe("success");
      const requested = evaluateCiGraph({ eventName, runDeployedCanary: true });
      expect(requested.get("deployed-canary")).toBe("success");
      expect(requested.get("canary-gate")).toBe("success");
    }
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

  test("derives the deployed canary service version from the release tag", () => {
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
    expect(reportStep).toBeDefined();
    for (const eventName of ordinaryEvents) {
      expect(evaluateCiGraph({ eventName, runDeployedCanary: false }).get("deployed-canary")).toBe(
        "skipped",
      );
      expect(
        evaluateWorkflowCondition(reportStep?.if, { eventName, runDeployedCanary: false }),
      ).toBe(true);
      expect(
        evaluateWorkflowCondition(reportStep?.if, { eventName, runDeployedCanary: true }),
      ).toBe(false);
    }
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
