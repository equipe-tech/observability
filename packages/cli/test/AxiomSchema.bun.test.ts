import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { fileURLToPath } from "node:url";
import { inspectAxiomSchema } from "../../../scripts/axiom-schema.ts";

const script = fileURLToPath(new URL("../../../scripts/axiom-schema.ts", import.meta.url));
const QueryRequest = Schema.Struct({ apl: Schema.String });
const decodeQueryRequest = Schema.decodeUnknownSync(QueryRequest);
const environment = (url: string): NodeJS.ProcessEnv => ({
  AXIOM_URL: url,
  AXIOM_READ_TOKEN: "read-only-secret",
  AXIOM_ORGANIZATION_ID: "test-organization",
  AXIOM_DATASET_TRACES: "test-traces",
  AXIOM_DATASET_LOGS: "test-logs",
  AXIOM_DATASET_METRICS: "test-metrics",
});
const fieldResponse = () =>
  Response.json({
    matches: [
      { data: { ColumnName: "_time", ColumnType: "datetime", event: "private-event-value" } },
    ],
    private: "private-response-value",
  });

const runScript = async (env: NodeJS.ProcessEnv) => {
  const child = Bun.spawn([process.execPath, script], { env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("protected Axiom schema diagnostics", () => {
  test("queries only trace and log schemas and prints only parsed metadata", async () => {
    const queries: Array<string> = [];
    const credentials: Array<string | null> = [];
    const paths: Array<string> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        queries.push(decodeQueryRequest(await request.json()).apl);
        credentials.push(request.headers.get("authorization"));
        expect(request.headers.get("x-axiom-org-id")).toBe("test-organization");
        const url = new URL(request.url);
        paths.push(`${url.pathname}${url.search}`);
        return fieldResponse();
      },
    });
    try {
      const result = await runScript(environment(server.url.toString()));
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        `${JSON.stringify([
          { signal: "traces", fields: [{ name: "_time", type: "datetime" }] },
          { signal: "logs", fields: [{ name: "_time", type: "datetime" }] },
        ])}\n`,
      );
      expect(queries).toEqual(['["test-traces"] | getschema', '["test-logs"] | getschema']);
      expect(credentials).toEqual(["Bearer read-only-secret", "Bearer read-only-secret"]);
      expect(paths).toEqual(["/v1/datasets/_apl?format=legacy", "/v1/datasets/_apl?format=legacy"]);
    } finally {
      await server.stop(true);
    }
  });

  test("escapes dataset names rather than interpolating APL syntax", async () => {
    const queries: Array<string> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        queries.push(decodeQueryRequest(await request.json()).apl);
        return Response.json({ matches: [] });
      },
    });
    try {
      const env = environment(server.url.toString());
      env.AXIOM_DATASET_LOGS = 'logs"] | take 1 | ["other';
      const result = await Effect.runPromise(inspectAxiomSchema(env));
      expect(queries[1]).toBe(`[${JSON.stringify(env.AXIOM_DATASET_LOGS)}] | getschema`);
      expect(result).toEqual([
        { signal: "traces", fields: [] },
        { signal: "logs", fields: [] },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test("rejects absent credentials and malformed URLs without exposing environment values", async () => {
    for (const env of [
      { ...environment("http://127.0.0.1:1"), AXIOM_READ_TOKEN: undefined },
      environment("private-invalid-url"),
    ]) {
      const result = await runScript(env);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OBS_AXIOM_SCHEMA_INPUT_INVALID");
      expect(result.stderr).toContain("Correlation ID:");
      expect(result.stderr).not.toContain("read-only-secret");
      expect(result.stderr).not.toContain("private-invalid-url");
    }
  });

  test("fails closed on HTTP errors without printing response bodies", async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const server = Bun.serve({
        port: 0,
        fetch: () => new Response("private-provider-error", { status }),
      });
      try {
        const result = await runScript(environment(server.url.toString()));
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("OBS_AXIOM_SCHEMA_REQUEST_FAILED");
        expect(result.stderr).toContain(`HTTP ${status}`);
        expect(result.stderr).not.toContain("private-provider-error");
        expect(result.stderr).not.toContain("read-only-secret");
      } finally {
        await server.stop(true);
      }
    }
  });

  test("rejects invalid JSON, missing schema columns and oversized schema responses", async () => {
    const responses = [
      "private-invalid-json",
      JSON.stringify({ matches: [{ data: { ColumnName: "private-missing-type" } }] }),
      JSON.stringify({ matches: null }),
      JSON.stringify({
        matches: Array.from({ length: 513 }, () => ({
          data: { ColumnName: "field", ColumnType: "string" },
        })),
      }),
    ];
    for (const response of responses) {
      const server = Bun.serve({ port: 0, fetch: () => new Response(response) });
      try {
        const result = await runScript(environment(server.url.toString()));
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain("OBS_AXIOM_SCHEMA_RESPONSE_INVALID");
        expect(result.stderr).not.toContain("private-");
      } finally {
        await server.stop(true);
      }
    }
  });

  test("bounds schema requests that never return", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      const result = await runScript(environment(server.url.toString()));
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("OBS_AXIOM_SCHEMA_REQUEST_FAILED");
    } finally {
      await server.stop(true);
    }
  }, 15_000);

  test("reports transport failures without disclosing the configured URL", async () => {
    const server = Bun.serve({ port: 0, fetch: fieldResponse });
    const url = server.url.toString();
    await server.stop(true);
    const result = await runScript(environment(url));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("OBS_AXIOM_SCHEMA_REQUEST_FAILED");
    expect(result.stderr).not.toContain(url);
  });
});
