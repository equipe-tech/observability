import { describe, expect, test } from "bun:test";
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

  test("blocks release verification on the scoped deployed canary", () => {
    expect(workflow).toContain("run_deployed_canary: true");
    expect(workflow).toContain("AXIOM_INGEST_TOKEN: ${{ secrets.AXIOM_INGEST_TOKEN }}");
    expect(workflow).toContain("AXIOM_READ_TOKEN: ${{ secrets.AXIOM_READ_TOKEN }}");
    expect(ciWorkflow).toContain("AXIOM_INGEST_TOKEN:");
    expect(ciWorkflow).toContain("AXIOM_READ_TOKEN:");
    expect(ciWorkflow).toContain("environment: publication");
    expect(ciWorkflow).toContain("scripts/release-canary.ts");
    expect(ciWorkflow).not.toContain("Deployed canary skipped");
  });

  test("derives the deployed canary service version from the release tag", () => {
    expect(ciWorkflow).toContain(
      'bun scripts/release-canary.ts --tag "$RELEASE_TAG" --github-env "$GITHUB_ENV"',
    );
    expect(releaseCanaryScript).toContain("OTEL_SERVICE_VERSION");
    expect(ciWorkflow).not.toMatch(/serviceVersion: ["']\d+\.\d+\.\d+/);
  });

  test("keeps ordinary CI credential-free and reports the omitted protected gate", () => {
    expect(ciWorkflow).toContain("default: false");
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
