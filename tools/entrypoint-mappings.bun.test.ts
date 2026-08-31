import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import evlogManifest from "../packages/evlog/package.json" with { type: "json" };
import nestjsManifest from "../packages/nestjs/package.json" with { type: "json" };
import reactManifest from "../packages/react/package.json" with { type: "json" };
import sentryManifest from "../packages/sentry/package.json" with { type: "json" };
import telemetryManifest from "../packages/telemetry/package.json" with { type: "json" };
import tsconfig from "../tsconfig.json" with { type: "json" };
import viteConfig from "../vite.config.ts";

const expected = new Map([
  ["@equipe-tech/observability-react", "packages/react/src/index.ts"],
  ["@equipe-tech/observability-sentry/browser", "packages/sentry/src/browser/index.ts"],
  ["@equipe-tech/observability-sentry/node", "packages/sentry/src/node/index.ts"],
  ["@equipe-tech/observability-sentry", "packages/sentry/src/index.ts"],
  ["@equipe-tech/observability/browser/client", "packages/telemetry/src/browser/client.ts"],
  ["@equipe-tech/observability/browser", "packages/telemetry/src/browser/index.ts"],
  ["@equipe-tech/observability/effect", "packages/telemetry/src/effect/index.ts"],
  ["@equipe-tech/observability/metrics", "packages/telemetry/src/Metrics.ts"],
  ["@equipe-tech/observability/policy", "packages/telemetry/src/policy/entrypoint.ts"],
  ["@equipe-tech/observability/testing", "packages/telemetry/src/testing/index.ts"],
  ["@equipe-tech/observability/node", "packages/telemetry/src/node/index.ts"],
  ["@equipe-tech/observability-nestjs", "packages/nestjs/src/index.ts"],
  ["@equipe-tech/observability-evlog", "packages/evlog/src/index.ts"],
  ["@equipe-tech/observability", "packages/telemetry/src/index.ts"],
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

const packageEntrypoints = (
  packageName: string,
  exports: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  exports.map((entrypoint) =>
    entrypoint === "." ? packageName : `${packageName}/${entrypoint.slice(2)}`,
  );

describe("development entrypoint mappings", () => {
  test("maps every package export to its exact TypeScript source", () => {
    const entrypoints = [
      ...packageEntrypoints("@equipe-tech/observability", Object.keys(telemetryManifest.exports)),
      ...packageEntrypoints(
        "@equipe-tech/observability-nestjs",
        Object.keys(nestjsManifest.exports),
      ),
      ...packageEntrypoints("@equipe-tech/observability-evlog", Object.keys(evlogManifest.exports)),
      ...packageEntrypoints(
        "@equipe-tech/observability-sentry",
        Object.keys(sentryManifest.exports),
      ),
      ...packageEntrypoints("@equipe-tech/observability-react", Object.keys(reactManifest.exports)),
    ];
    expect(entrypoints.toSorted()).toEqual([...expected.keys()].toSorted());
    for (const [specifier, source] of expected) {
      expect(paths[specifier]).toEqual([`./${source}`]);
    }
  });

  test("maps every export to the same exact Vite source", () => {
    for (const [specifier, source] of expected) {
      const alias = aliases.find((candidate) => candidate.find === specifier);
      expect(alias?.replacement.endsWith(source)).toBe(true);
    }
  });

  test("orders every longer Vite alias before the bare telemetry alias", () => {
    expect(aliases.map((alias) => alias.find)).toEqual([...expected.keys()]);
    const bareIndex = aliases.findIndex((alias) => alias.find === "@equipe-tech/observability");
    for (const alias of aliases) {
      if (alias.find !== "@equipe-tech/observability") {
        expect(aliases.indexOf(alias)).toBeLessThan(bareIndex);
      }
    }
  });
});
