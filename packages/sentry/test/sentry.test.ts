import {
  CorrelationContext,
  baseDataPolicy,
  type DefectEnvelope,
} from "@equipe-tech/observability/policy";
import { defineTelemetryContract } from "@equipe-tech/observability";
import { createNodeObservability } from "@equipe-tech/observability/node";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { Effect, Option, Schema } from "effect";
import { createServer } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { parseSentryDsn, sentrySourceMapUpload } from "../src/index.ts";
import { createBrowserSentryDefectReporter } from "../src/browser/index.ts";
import { sentryDefectAdapter } from "../src/node/index.ts";
import { defectDeduplicator } from "../src/policy/Deduplication.ts";

const envelope = (fingerprint = "stable"): DefectEnvelope => ({
  errorType: "UnexpectedDefect",
  errorMessage: "safe failure",
  stack: Option.some("at run (/srv/app.js:10:2)"),
  fingerprint: ["OBS_TEST_UNEXPECTED", fingerprint],
  tags: new Map([["error.code", "OBS_TEST_UNEXPECTED"]]),
  context: new Map([["operation.name", "verification"]]),
  correlation: new CorrelationContext({}),
});

describe("Sentry adapter policy", () => {
  it("validates DSNs without exposing credentials", async () => {
    const valid = await Effect.runPromise(parseSentryDsn(new URL("https://public@sentry.io/42")));
    expect(valid.projectId).toBe("42");
    await expect(
      Effect.runPromise(parseSentryDsn(new URL("https://sentry.io"))),
    ).rejects.toMatchObject({ code: "OBS_SENTRY_DSN_INVALID" });
    await expect(
      Effect.runPromise(parseSentryDsn(new URL("https://public:secret@sentry.io/42"))),
    ).rejects.toMatchObject({ code: "OBS_SENTRY_DSN_INVALID" });
  });

  it("builds exact credential-free source map arguments", () => {
    const plan = sentrySourceMapUpload({
      organization: "equipe-tech",
      project: "web",
      release: "1.4.0",
      includePaths: ["dist/assets"],
      urlPrefix: "~/assets",
      deleteAfterUpload: true,
    });
    expect(plan).toEqual({
      command: "sentry-cli",
      args: [
        "sourcemaps",
        "upload",
        "--org",
        "equipe-tech",
        "--project",
        "web",
        "--release",
        "1.4.0",
        "--url-prefix",
        "~/assets",
        "--delete-after-upload",
        "dist/assets",
      ],
      environment: { authTokenVariable: "SENTRY_AUTH_TOKEN" },
    });
    expect(JSON.stringify(plan)).not.toContain("AUTH_TOKEN=");
  });

  it("deduplicates identity, fingerprint, window, and bounded capacity", () => {
    const dedupe = defectDeduplicator(100, 2);
    const first = envelope("first");
    expect(dedupe.admit(first, 0).kind).toBe("admitted");
    expect(dedupe.admit(first, 1)).toEqual({ kind: "deduplicated", reason: "identity" });
    expect(dedupe.admit(envelope("first"), 2)).toEqual({
      kind: "deduplicated",
      reason: "fingerprint",
    });
    expect(dedupe.admit(envelope("first"), 101).kind).toBe("admitted");
    expect(dedupe.admit(envelope("second"), 102).kind).toBe("admitted");
    expect(dedupe.admit(envelope("third"), 103).kind).toBe("admitted");
    expect(dedupe.admit(envelope("second"), 104)).toEqual({
      kind: "deduplicated",
      reason: "fingerprint",
    });
  });

  it("sends one allowlisted browser error envelope through the wire transport", async () => {
    const bodies: Array<string> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy: baseDataPolicy,
    });
    const outcome = reporter.capture({ envelope: envelope() });
    expect(outcome.kind).toBe("captured");
    expect(await reporter.flush()).toBe(true);
    expect(await reporter.dispose()).toBe(true);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    expect(bodies).toHaveLength(1);
    const wire = bodies[0] ?? "";
    expect(wire).toContain('"release":"1.4.0"');
    expect(wire).toContain('"environment":"test"');
    expect(wire).toContain('"service.name":"web"');
    expect(wire).toContain('"error.code":"OBS_TEST_UNEXPECTED"');
    expect(wire).not.toContain('"request"');
    expect(wire).not.toContain('"user"');
    expect(wire).not.toContain('"breadcrumbs"');
    expect(wire).not.toContain('"transaction"');
  });

  it("registers the Node adapter and flushes one defect through lifecycle", async () => {
    const bodies: Array<string> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(200);
        response.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const contract = await Effect.runPromise(
      defineTelemetryContract({ version: 1, events: {}, metrics: {}, auditActions: {} }),
    );
    const sentry = sentryDefectAdapter();
    const events = evlogAdapter({ installGlobalLogger: false, stdout: { write: () => true } });
    const runtime = await createNodeObservability({
      profile: "worker",
      env: {
        OTEL_SERVICE_NAME: "worker",
        OTEL_SERVICE_VERSION: "1.4.0",
        OTEL_DEPLOYMENT_ENVIRONMENT: "test",
        OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${address.port}`,
        SENTRY_DSN: `http://public@127.0.0.1:${address.port}/1`,
      },
      contract,
      policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
      adapters: [events.registration, sentry.registration],
    });
    expect((await sentry.captureAsync({ envelope: envelope("node") })).kind).toBe("captured");
    expect(
      await sentry.sendVerificationDefect({ envelope: envelope("verification") }),
    ).toMatchObject({
      flushed: true,
    });
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    expect(bodies.some((body) => body.includes('"service.name":"worker"'))).toBe(true);
    expect(sentry.reports().reasons.captured).toBe(2);
  });

  it("keeps disabled and closed outcomes explicit", async () => {
    const reporter = createBrowserSentryDefectReporter({
      disabled: true,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy: baseDataPolicy,
    });
    expect(reporter.capture({ envelope: envelope() })).toEqual({
      kind: "suppressed",
      reason: "disabled",
    });
    expect(await reporter.dispose()).toBe(true);
    expect(reporter.capture({ envelope: envelope("closed") })).toEqual({
      kind: "suppressed",
      reason: "closed",
    });
    expect(reporter.reports().reasons).toMatchObject({ disabled: 1, closed: 1 });
  });
});
