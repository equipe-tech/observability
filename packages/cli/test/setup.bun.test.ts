import { afterEach, describe, expect, it } from "bun:test";
import { Effect } from "effect";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SetupGenerator,
  type SetupInputEncoded,
  type SetupPlan,
} from "../src/setup/SetupGenerator.ts";

const directories: Array<string> = [];
const directory = async (): Promise<string> => {
  const created = await mkdtemp(join(tmpdir(), "observability-setup-test-"));
  directories.push(created);
  return created;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

const inputs = (profile: string): SetupInputEncoded => ({
  profile,
  serviceName: profile === "library" ? undefined : `fixture-${profile}`,
  environments: profile === "library" ? [] : ["staging"],
  otlpEndpoint:
    profile === "worker" || profile === "nestjs-api" || profile === "cli"
      ? "http://127.0.0.1:4318"
      : undefined,
  publicOrigin: profile === "react-web" ? "https://telemetry.example.com" : undefined,
  ingestPath: "_telemetry/events",
  proxyPolicy: "direct",
  sentryDsnVariable: "SENTRY_DSN",
  releaseVariable: "OTEL_SERVICE_VERSION",
  sentryOrganization: undefined,
  sentryProject: undefined,
  pipeline: "github-actions",
  browserIngest: profile === "react-web",
  defects: false,
  metrics: profile === "nestjs-api" || profile === "worker" || profile === "react-web",
});

const run = <Value>(effect: Effect.Effect<Value, unknown, SetupGenerator>): Promise<Value> =>
  Effect.runPromise(effect.pipe(Effect.provide(SetupGenerator.layer)));

const write = (target: string, input: SetupInputEncoded, force = false): Promise<SetupPlan> =>
  run(Effect.flatMap(SetupGenerator, (generator) => generator.write(target, input, force)));

const plan = (target: string, input: SetupInputEncoded): Promise<SetupPlan> =>
  run(Effect.flatMap(SetupGenerator, (generator) => generator.plan(target, input)));

const allFiles = async (root: string): Promise<ReadonlyArray<string>> => {
  const files: Array<string> = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await visit(join(directory, entry.name), relative);
      else files.push(relative);
    }
  };
  await visit(root, "");
  return files.toSorted();
};

describe("setup generator", () => {
  for (const profile of ["nestjs-api", "worker", "react-web", "cli", "library"]) {
    it(`plans and writes the ${profile} profile idempotently`, async () => {
      const target = await directory();
      const proposed = await plan(target, inputs(profile));
      expect(proposed.files.every((file) => file.action === "create")).toBe(true);
      expect(await readdir(target)).toEqual([]);
      await write(target, inputs(profile));
      const firstFiles = await allFiles(target);
      const record = await readFile(join(target, "observability/setup.json"), "utf8");
      const repeated = await write(target, inputs(profile));
      expect(repeated.files.every((file) => file.action === "unchanged")).toBe(true);
      expect(await allFiles(target)).toEqual(firstFiles);
      expect(await readFile(join(target, "observability/setup.json"), "utf8")).toBe(record);
      expect(proposed.files.some((file) => file.path === "observability/contract.json")).toBe(true);
    });
  }

  it("preserves user-owned edits even with force", async () => {
    const target = await directory();
    await write(target, inputs("worker"));
    const policy = join(target, "observability/policy.ts");
    await writeFile(policy, "export const applicationPolicy = true;\n");
    const repeated = await write(target, inputs("worker"), true);
    expect(repeated.files.find((file) => file.path === "observability/policy.ts")?.action).toBe(
      "preserved",
    );
    expect(await readFile(policy, "utf8")).toBe("export const applicationPolicy = true;\n");
  });

  it("detects all conflicts before writing and force replaces only skill-owned files", async () => {
    const target = await directory();
    await write(target, inputs("worker"));
    const canary = join(target, "observability/canary.ts");
    const workflow = join(target, ".github/workflows/observability.yml");
    await writeFile(canary, "changed\n");
    await writeFile(workflow, "changed\n");
    expect(write(target, inputs("worker"))).rejects.toMatchObject({
      code: "OBS_SETUP_CONFLICT",
    });
    expect(await readFile(canary, "utf8")).toBe("changed\n");
    expect(await readFile(workflow, "utf8")).toBe("changed\n");
    const forced = await write(target, inputs("worker"), true);
    expect(forced.files.filter((file) => file.action === "updated")).toHaveLength(2);
    expect(await readFile(canary, "utf8")).not.toBe("changed\n");
  });

  it("rejects invalid profile combinations and credential-bearing endpoints", async () => {
    const target = await directory();
    expect(plan(target, { ...inputs("worker"), profile: "custom" })).rejects.toMatchObject({
      code: "OBS_SETUP_PROFILE_INVALID",
    });
    expect(plan(target, { ...inputs("worker"), browserIngest: true })).rejects.toMatchObject({
      code: "OBS_SETUP_PROFILE_INVALID",
    });
    expect(
      plan(target, { ...inputs("worker"), otlpEndpoint: "https://secret@example.com" }),
    ).rejects.toMatchObject({ code: "OBS_SETUP_INPUT_INVALID" });
    expect(
      plan(target, { ...inputs("worker"), environments: ["production"] }),
    ).rejects.toMatchObject({ code: "OBS_SETUP_PROFILE_INVALID" });
  });

  it("emits only public composition without secret values or copied implementations", async () => {
    const target = await directory();
    const generated = await write(target, inputs("react-web"));
    const output = generated.files.map((file) => file.content).join("\n");
    expect(output).not.toMatch(/@opentelemetry\//);
    expect(output).not.toMatch(/effect\/unstable\//);
    expect(output).not.toMatch(/sntrys_/);
    expect(output).not.toMatch(/receivers:|exporters:|processors:/);
    expect(output).toContain("runConformance");
    expect(output).toContain("runBrowserDeliveryCanary");
  });
});
