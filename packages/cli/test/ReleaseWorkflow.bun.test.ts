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

const ConditionalJob = Schema.Struct({ if: Schema.optionalKey(Schema.String) });

const ReusableWorkflowJob = Schema.Struct({
  uses: Schema.String,
  with: Schema.Struct({ run_deployed_canary: Schema.Boolean }),
});

const DependentJob = Schema.Struct({ needs: Schema.Array(Schema.String) });

const CiWorkflow = Schema.Struct({
  jobs: Schema.Struct({
    verify: ConditionalJob,
    "deployed-canary": ConditionalJob,
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

type WorkflowContext = {
  readonly eventName: "push" | "pull_request" | "workflow_call";
  readonly runDeployedCanary: boolean;
};

type JobResult = "success" | "skipped";

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
  results.set(
    "deployed-canary",
    evaluateWorkflowCondition(parsedCiWorkflow.jobs["deployed-canary"].if, context)
      ? "success"
      : "skipped",
  );
  return results;
};

describe("release workflow publication gate", () => {
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

  test("selects one package manifest and archive", () => {
    expect(workflow).toContain('slug="${tag%@*}"');
    expect(workflow).toContain('version="${tag#*@}"');
    expect(workflow).toContain("for candidate in packages/*/package.json");
    expect(workflow).toContain('archive="equipe-tech-${slug}-${version}.tgz"');
    expect(workflow).toContain('npm publish "dist-release/$ARCHIVE"');
    expect(workflow).not.toContain("packages/telemetry/package.json packages/cli/package.json");
    expect(workflow).not.toContain("steps.meta.outputs.slug");
    expect(workflow).not.toContain("steps.meta.outputs.version");
    expect(workflow).not.toContain("steps.meta.outputs.package_name");
    expect(workflow).not.toContain("steps.meta.outputs.directory");
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
    for (const eventName of ordinaryEvents) {
      expect(evaluateCiGraph({ eventName, runDeployedCanary: false }).get("deployed-canary")).toBe(
        "skipped",
      );
    }
    expect(
      evaluateCiGraph({ eventName: "workflow_call", runDeployedCanary: false }).get(
        "deployed-canary",
      ),
    ).toBe("skipped");
    expect(
      evaluateCiGraph({ eventName: "push", runDeployedCanary: true }).get("deployed-canary"),
    ).toBe("success");
    expect(
      evaluateCiGraph({ eventName: "workflow_call", runDeployedCanary: true }).get(
        "deployed-canary",
      ),
    ).toBe("success");
  });

  test("builds a release graph that cannot bypass the canary gate", () => {
    expect(parsedReleaseWorkflow.jobs.verify.uses).toBe("./.github/workflows/ci.yml");
    expect(parsedReleaseWorkflow.jobs.verify.with.run_deployed_canary).toBe(true);
    expect(parsedReleaseWorkflow.jobs.release.needs).toContain("canary-gate");
    expect(parsedReleaseWorkflow.jobs["publish-npm"].needs).toContain("release");
  });

  test("derives the deployed canary service version from the release tag", () => {
    expect(ciWorkflow).toContain(
      'bun scripts/release-canary.ts --tag "$RELEASE_TAG" --github-env "$GITHUB_ENV"',
    );
    expect(releaseCanaryScript).toContain("OTEL_SERVICE_VERSION");
    expect(ciWorkflow).not.toMatch(/serviceVersion: ["']\d+\.\d+\.\d+/);
  });

  test("keeps ordinary CI credential-free and reports the omitted protected gate", () => {
    for (const eventName of ordinaryEvents) {
      expect(evaluateCiGraph({ eventName, runDeployedCanary: false }).get("deployed-canary")).toBe(
        "skipped",
      );
    }
    expect(ciWorkflow).toContain(
      "Deployed canary did not run because this CI invocation did not request the protected release gate.",
    );
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
