import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "bun:test";

const compile = async (source: string): Promise<boolean> => {
  const directory = await mkdtemp(join(tmpdir(), "audit-handle-"));
  try {
    const file = join(directory, "mutation.ts");
    const config = join(directory, "tsconfig.json");
    await symlink(join(process.cwd(), "node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(file, source);
    await writeFile(
      config,
      JSON.stringify({
        extends: join(process.cwd(), "tsconfig.json"),
        compilerOptions: { noEmit: true, rootDir: "/", types: [] },
        files: [file],
      }),
    );
    const child = Bun.spawn(["bunx", "tsc", "-p", config], {
      cwd: process.cwd(),
      stdout: "ignore",
      stderr: "ignore",
    });
    return (await child.exited) === 0;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

const imports = `
import { Effect, Layer, Option } from "effect";
import { AuditPublisher, type ObservabilityAdapterHandle } from "@equipe-tech/observability";
const base = {
  flush: Effect.void,
  close: Effect.void,
  eventLayer: Option.none(),
  degraded: () => false,
};
`;

describe("audit adapter handle type", () => {
  it("rejects missing and empty audit layers", async () => {
    assert.equal(
      await compile(`${imports}\nconst handle: ObservabilityAdapterHandle = base;\nvoid handle;`),
      false,
    );
    assert.equal(
      await compile(
        `${imports}\nconst handle: ObservabilityAdapterHandle = { ...base, auditLayer: Option.some(Layer.empty) };\nvoid handle;`,
      ),
      false,
    );
    assert.equal(
      await compile(
        `${imports}\nconst handle: ObservabilityAdapterHandle = { ...base, auditLayer: Option.some(Layer.succeed(AuditPublisher, AuditPublisher.of({ publish: () => Effect.succeed({ kind: "published" }), report: () => ({ published: 0, deduplicated: 0, dropped: 0, firstDroppedAt: Option.none(), lastDroppedAt: Option.none(), reasons: { unbound: 0, closed: 0, queueOverflow: 0, contractRejected: 0, policyRejected: 0, transport: 0 } }) }))) };\nvoid handle;`,
      ),
      true,
    );
  });
});
