import { expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findApplicationOtlpImports, scanImportSpecifiers } from "../src/SourceBoundary.ts";

test("scans CommonJS require calls for application-local exporters", async () => {
  const root = await mkdtemp(join(tmpdir(), "obs-source-boundary-"));
  try {
    await mkdir(join(root, "src"));
    const source =
      'const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http"); module.exports = new OTLPTraceExporter();';
    await writeFile(join(root, "src", "telemetry.cjs"), source);
    expect(scanImportSpecifiers(source)).toEqual(["@opentelemetry/exporter-trace-otlp-http"]);
    expect(await findApplicationOtlpImports(root, ["src"])).toEqual([
      {
        rule: "boundary/application-otlp",
        file: "src/telemetry.cjs",
        specifier: "@opentelemetry/exporter-trace-otlp-http",
      },
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scans TypeScript ESM and CommonJS application exporters", async () => {
  const root = await mkdtemp(join(tmpdir(), "obs-source-boundary-"));
  try {
    for (const extension of ["mts", "cts", "ts"]) {
      await mkdir(join(root, extension));
      await writeFile(
        join(root, extension, `index.${extension}`),
        'import { OtlpTracer } from "effect/unstable/observability"; export const exporter = OtlpTracer.layer;',
      );
      expect(await findApplicationOtlpImports(root, [extension])).toEqual([
        {
          rule: "boundary/application-otlp",
          file: `${extension}/index.${extension}`,
          specifier: "effect/unstable/observability",
        },
      ]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("allows ordinary Effect HTTP clients while rejecting OTLP imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "obs-source-boundary-"));
  try {
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src", "client.ts"),
      'import { HttpClient } from "effect/unstable/http"; import { Headers } from "effect/unstable/http/Headers"; export const client = HttpClient.HttpClient;',
    );
    expect(await findApplicationOtlpImports(root, ["src"])).toEqual([]);
    await writeFile(
      join(root, "src", "exporter.ts"),
      'import { Otlp } from "effect/unstable/observability"; export const exporter = Otlp;',
    );
    expect(await findApplicationOtlpImports(root, ["src"])).toHaveLength(1);
    await writeFile(
      join(root, "src", "near-match.ts"),
      'import value from "effect/unstable/httpx"; export { value };',
    );
    expect(await findApplicationOtlpImports(root, ["src"])).toHaveLength(2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
