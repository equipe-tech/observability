import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import telemetryManifest from "../packages/telemetry/package.json" with { type: "json" };
import tsconfig from "../tsconfig.json" with { type: "json" };
import viteConfig from "../vite.config.ts";

const expected = new Map([
  [".", "packages/telemetry/src/index.ts"],
  ["./browser", "packages/telemetry/src/browser/index.ts"],
  ["./browser/client", "packages/telemetry/src/browser/client.ts"],
  ["./effect", "packages/telemetry/src/effect/index.ts"],
  ["./metrics", "packages/telemetry/src/Metrics.ts"],
  ["./node", "packages/telemetry/src/node/index.ts"],
  ["./testing", "packages/telemetry/src/testing/index.ts"],
]);
const TypeScriptConfig = Schema.Struct({
  compilerOptions: Schema.Struct({
    paths: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  }),
});
const decodeTypeScriptConfig = Schema.decodeUnknownSync(TypeScriptConfig);
const paths = decodeTypeScriptConfig(tsconfig).compilerOptions.paths;
const AliasConfig = Schema.Struct({
  resolve: Schema.Struct({
    alias: Schema.Array(Schema.Struct({ find: Schema.String, replacement: Schema.String })),
  }),
});
const decodeAliasConfig = Schema.decodeUnknownSync(AliasConfig);
const aliases = decodeAliasConfig(viteConfig).resolve.alias;

describe("development entrypoint mappings", () => {
  test("maps every telemetry export to its exact TypeScript source", () => {
    expect(Object.keys(telemetryManifest.exports).toSorted()).toEqual(
      [...expected.keys()].toSorted(),
    );
    for (const [entrypoint, source] of expected) {
      const specifier =
        entrypoint === "."
          ? "@equipe-tech/observability"
          : `@equipe-tech/observability/${entrypoint.slice(2)}`;
      expect(paths[specifier]).toEqual([`./${source}`]);
    }
  });

  test("maps every telemetry export to the same exact Vite source", () => {
    for (const [entrypoint, source] of expected) {
      const specifier =
        entrypoint === "."
          ? "@equipe-tech/observability"
          : `@equipe-tech/observability/${entrypoint.slice(2)}`;
      const alias = aliases.find((candidate) => candidate.find === specifier);
      expect(alias?.replacement.endsWith(source)).toBe(true);
    }
  });
});
