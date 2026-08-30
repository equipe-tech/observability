import {
  CorrelationContext,
  definePolicy,
  parseRequestId,
  parseRunId,
  parseSpanId,
  parseTraceId,
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
import { SentryDefects, sentryDefectAdapter } from "../src/node/index.ts";
import { defectDeduplicator } from "../src/policy/Deduplication.ts";
import { eventSettlements } from "../src/policy/EventSettlement.ts";

const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };
const sensitivePolicy = definePolicy({
  attributes: {
    "request.body": { classification: "sensitive", required: false, metricLabel: false },
    "auth.token": { classification: "sensitive", required: false, metricLabel: false },
    "http.cookie": { classification: "sensitive", required: false, metricLabel: false },
    "ai.prompt": { classification: "sensitive", required: false, metricLabel: false },
    "llm.response": { classification: "sensitive", required: false, metricLabel: false },
    "payment.card": { classification: "sensitive", required: false, metricLabel: false },
    "user.email": { classification: "sensitive", required: false, metricLabel: false },
    "sentry.contexts": { classification: "sensitive", required: false, metricLabel: false },
    "sentry.attachments": { classification: "sensitive", required: false, metricLabel: false },
    "sentry.breadcrumbs": { classification: "sensitive", required: false, metricLabel: false },
    "unknown.extra": { classification: "sensitive", required: false, metricLabel: false },
    "provider.hint": { classification: "sensitive", required: false, metricLabel: false },
    "assignment.secret": { classification: "sensitive", required: false, metricLabel: false },
    "safe.value": { classification: "public", required: false, metricLabel: false },
  },
  blockedKeys: ["password"],
  blockedValuePatterns: ["sk-[a-z]+"],
});

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
    expect(dedupe.admit("a", first, 0).kind).toBe("admitted");
    expect(dedupe.admit("b", first, 1)).toEqual({ kind: "deduplicated", reason: "identity" });
    expect(dedupe.admit("c", envelope("first"), 2)).toEqual({
      kind: "deduplicated",
      reason: "fingerprint",
    });
    expect(dedupe.admit("d", envelope("first"), 101).kind).toBe("admitted");
    expect(dedupe.admit("e", envelope("second"), 102).kind).toBe("admitted");
    expect(dedupe.admit("f", envelope("third"), 103).kind).toBe("admitted");
    expect(dedupe.admit("g", envelope("second"), 104)).toEqual({
      kind: "deduplicated",
      reason: "fingerprint",
    });
  });

  it("bounds pending settlement state and removes every terminal entry", async () => {
    const dedupe = defectDeduplicator(100, 4);
    const settlements = eventSettlements(1, dedupe);
    const first = envelope("settlement-first");
    expect(dedupe.admit("first", first, 0).kind).toBe("admitted");
    const accepted = settlements.reserve("first", { envelope: first });
    expect(accepted).toBeDefined();
    const pressured = envelope("settlement-pressure");
    expect(dedupe.admit("pressured", pressured, 0).kind).toBe("admitted");
    expect(settlements.reserve("pressured", { envelope: pressured })).toBeUndefined();
    dedupe.rollback("pressured");
    settlements.settle("first", true);
    expect(await accepted).toBe(true);
    expect(settlements.size()).toBe(0);
    const rejected = envelope("settlement-rejected");
    expect(dedupe.admit("rejected", rejected, 1).kind).toBe("admitted");
    const rejection = settlements.reserve("rejected", { envelope: rejected });
    settlements.reject("rejected");
    expect(await rejection).toBe(false);
    expect(settlements.size()).toBe(0);
    const closed = envelope("settlement-closed");
    expect(dedupe.admit("closed", closed, 2).kind).toBe("admitted");
    const closure = settlements.reserve("closed", { envelope: closed });
    settlements.clear();
    expect(await closure).toBe(false);
    expect(settlements.size()).toBe(0);
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
      policy,
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
    let status = 200;
    const server = createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        bodies.push(body);
        response.writeHead(status);
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
      policy: sensitivePolicy,
      adapters: [events.registration, sentry.registration],
    });
    const capture = await sentry.captureAsync({ envelope: envelope("node") });
    expect(capture.kind).toBe("captured");
    const receipt = await sentry.sendVerificationDefect({ envelope: envelope("verification") });
    expect(receipt).toMatchObject({ flushed: true });
    const serviceOutcome = await Effect.runPromise(
      Effect.gen(function* () {
        const defects = yield* SentryDefects;
        return yield* defects.capture({ envelope: envelope("service") });
      }).pipe(Effect.provide(sentry.layer)),
    );
    expect(serviceOutcome.kind).toBe("captured");
    const nodeSensitive = {
      ...envelope("node-sensitive"),
      context: new Map([
        ["request.body", '{"nested":{"password":"node-body-secret"}}'],
        ["auth.token", "node-auth-secret"],
        ["http.cookie", "node-cookie-secret"],
        ["ai.prompt", "node-prompt-secret"],
        ["llm.response", "node-response-secret"],
        ["payment.card", "5555555555554444"],
        ["user.email", "node@example.com"],
        ["sentry.contexts", "node-context-secret"],
        ["sentry.attachments", "node-attachment-secret"],
        ["sentry.breadcrumbs", "node-breadcrumb-secret"],
        ["unknown.extra", "node-extra-secret"],
        ["provider.hint", "node-hint-secret"],
        ["assignment.secret", "node-assignment-secret"],
      ]),
    } satisfies DefectEnvelope;
    expect(await sentry.sendVerificationDefect({ envelope: nodeSensitive })).toMatchObject({
      flushed: true,
    });
    const retry = envelope("node-retry");
    status = 500;
    expect(await sentry.sendVerificationDefect({ envelope: retry })).toEqual({
      kind: "failed",
      reason: "transport",
    });
    status = 200;
    expect(await sentry.sendVerificationDefect({ envelope: retry })).toMatchObject({
      flushed: true,
    });
    await runtime.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    expect(bodies.some((body) => body.includes('"service.name":"worker"'))).toBe(true);
    if (capture.kind === "captured") {
      expect(bodies.some((body) => body.includes(capture.eventId))).toBe(true);
    }
    if ("eventId" in receipt) {
      expect(bodies.some((body) => body.includes(receipt.eventId))).toBe(true);
    }
    for (const secret of [
      "node-body-secret",
      "node-auth-secret",
      "node-cookie-secret",
      "node-prompt-secret",
      "node-response-secret",
      "5555555555554444",
      "node@example.com",
      "node-context-secret",
      "node-attachment-secret",
      "node-breadcrumb-secret",
      "node-extra-secret",
      "node-hint-secret",
      "node-assignment-secret",
    ]) {
      expect(bodies.join("\n")).not.toContain(secret);
    }
    expect(sentry.reports().reasons).toMatchObject({ captured: 6, transport: 1 });
  });

  it.each([
    { options: { flushDeadlineMillis: 0 }, code: "OBS_SENTRY_CONFIG_INVALID", dsn: true },
    { options: {}, code: "OBS_SENTRY_DISABLED", dsn: false },
  ])("reports Node adapter error $code", async ({ options, code, dsn }) => {
    const contract = await Effect.runPromise(
      defineTelemetryContract({ version: 1, events: {}, metrics: {}, auditActions: {} }),
    );
    const sentry = sentryDefectAdapter(options);
    const events = evlogAdapter({ installGlobalLogger: false, stdout: { write: () => true } });
    const env = {
      OTEL_SERVICE_NAME: "worker",
      OTEL_SERVICE_VERSION: "1.4.0",
      OTEL_DEPLOYMENT_ENVIRONMENT: "test",
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    };
    if (dsn) Object.assign(env, { SENTRY_DSN: "http://public@127.0.0.1:1/1" });
    await expect(
      createNodeObservability({
        profile: "worker",
        env,
        contract,
        policy,
        adapters: [events.registration, sentry.registration],
      }),
    ).rejects.toMatchObject({ cause: { cause: { code } } });
  });

  it("redacts every sensitive category and preserves valid correlation tags", async () => {
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
    const [traceId, spanId, requestId, runId] = await Effect.runPromise(
      Effect.all([
        parseTraceId("1".repeat(32)),
        parseSpanId("2".repeat(16)),
        parseRequestId("request-1"),
        parseRunId("run-1"),
      ]),
    );
    const sensitive = {
      ...envelope("sensitive"),
      errorMessage: "failure sk-providersecret",
      tags: new Map([
        ["safe.value", "visible"],
        ["bad key", "hidden"],
      ]),
      context: new Map([
        ["request.body", '{"nested":{"password":"body-secret"}}'],
        ["auth.token", "Bearer auth-secret"],
        ["http.cookie", "session=cookie-secret"],
        ["ai.prompt", "prompt-secret"],
        ["llm.response", "response-secret"],
        ["payment.card", "4111111111111111"],
        ["user.email", "person@example.com"],
        ["sentry.contexts", '{"secret":"context-secret"}'],
        ["sentry.attachments", "attachment-secret"],
        ["sentry.breadcrumbs", "breadcrumb-secret"],
        ["unknown.extra", "extra-secret"],
        ["provider.hint", "hint-secret"],
        ["assignment.secret", "API_KEY=assignment-secret"],
        ["safe.value", "visible"],
      ]),
      correlation: new CorrelationContext({
        trace: { _tag: "Traced", traceId, spanId },
        requestId: Option.some(requestId),
        runId: Option.some(runId),
      }),
    } satisfies DefectEnvelope;
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy: sensitivePolicy,
    });
    expect(await reporter.sendVerificationDefect({ envelope: sensitive })).toMatchObject({
      flushed: true,
    });
    const wire = bodies.join("\n");
    for (const secret of [
      "body-secret",
      "auth-secret",
      "cookie-secret",
      "prompt-secret",
      "response-secret",
      "4111111111111111",
      "person@example.com",
      "context-secret",
      "attachment-secret",
      "breadcrumb-secret",
      "extra-secret",
      "hint-secret",
      "assignment-secret",
      "providersecret",
      "hidden",
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(wire).toContain('"safe.value":"visible"');
    expect(wire).toContain('"trace.id":"11111111111111111111111111111111"');
    expect(wire).toContain('"span.id":"2222222222222222"');
    expect(wire).toContain('"request.id":"request-1"');
    expect(wire).toContain('"run.id":"run-1"');
    await reporter.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it("rejects malformed correlation identifiers", async () => {
    for (const invalid of [
      parseTraceId("0".repeat(32)).pipe(Effect.asVoid),
      parseTraceId("ABC").pipe(Effect.asVoid),
      parseSpanId("0".repeat(16)).pipe(Effect.asVoid),
      parseSpanId("xyz").pipe(Effect.asVoid),
      parseRequestId("bad\nrequest").pipe(Effect.asVoid),
      parseRunId("").pipe(Effect.asVoid),
    ]) {
      await expect(Effect.runPromise(invalid)).rejects.toMatchObject({
        code: "OBS_CORRELATION_INVALID",
      });
    }
  });

  it.each([200, 400, 429, 500])(
    "requires HTTP acceptance for verification status %i",
    async (status) => {
      const bodies: Array<string> = [];
      const server = createServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          bodies.push(body);
          response.writeHead(status);
          response.end();
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(
        server.address(),
      );
      const reporter = createBrowserSentryDefectReporter({
        dsn: `http://public@127.0.0.1:${address.port}/1`,
        service: { name: "web", version: "1.4.0", environment: "test" },
        policy,
      });
      const receipt = await reporter.sendVerificationDefect({
        envelope: envelope(`status-${status}`),
      });
      if (status === 200) {
        expect(receipt).toMatchObject({ flushed: true });
        if ("eventId" in receipt) expect(bodies[0]).toContain(receipt.eventId);
      } else {
        expect(receipt).toEqual({ kind: "failed", reason: "transport" });
      }
      await reporter.dispose();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
    },
  );

  it("rolls back dedupe after transport rejection", async () => {
    let status = 500;
    const server = createServer((_request, response) => {
      response.writeHead(status);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy,
    });
    const defect = envelope("retry");
    expect(await reporter.sendVerificationDefect({ envelope: defect })).toEqual({
      kind: "failed",
      reason: "transport",
    });
    status = 200;
    expect(await reporter.sendVerificationDefect({ envelope: defect })).toMatchObject({
      flushed: true,
    });
    await reporter.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it("rejects network failure and rolls back its reservation", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy,
      flushDeadlineMillis: 100,
    });
    const defect = envelope("network");
    expect(await reporter.sendVerificationDefect({ envelope: defect })).toEqual({
      kind: "failed",
      reason: "transport",
    });
    expect(reporter.capture({ envelope: defect }).kind).toBe("captured");
    await reporter.dispose();
  });

  it("counts one incomplete flush per operation and closes truthfully after timeout", async () => {
    const server = createServer(() => {});
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy,
      flushDeadlineMillis: 20,
      closeDeadlineMillis: 20,
    });
    expect(reporter.capture({ envelope: envelope("hang") }).kind).toBe("captured");
    expect(await Promise.all([reporter.flush(), reporter.flush()])).toEqual([false, false]);
    expect(reporter.reports().reasons.flushIncomplete).toBe(1);
    expect(await reporter.dispose()).toBe(false);
    expect(await reporter.dispose()).toBe(false);
    expect(reporter.capture({ envelope: envelope("after-close") })).toEqual({
      kind: "suppressed",
      reason: "closed",
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it("rejects invalid browser options, unknown keys, and invalid policies", () => {
    expect(() =>
      createBrowserSentryDefectReporter({
        disabled: true,
        service: { name: "web", version: "1.4.0", environment: "test" },
        policy,
        flushDeadlineMillis: 0,
      }),
    ).toThrowError(expect.objectContaining({ code: "OBS_SENTRY_CONFIG_INVALID" }));
    const unknown = {
      disabled: true,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy,
      flushDeadlineMs: 10,
    };
    expect(() => createBrowserSentryDefectReporter(unknown)).toThrowError(
      expect.objectContaining({ code: "OBS_SENTRY_CONFIG_INVALID" }),
    );
    expect(() =>
      createBrowserSentryDefectReporter({
        disabled: true,
        service: { name: "web", version: "1.4.0", environment: "test" },
        policy: { attributes: {}, blockedKeys: ["("], blockedValuePatterns: [] },
      }),
    ).toThrowError(expect.objectContaining({ code: "OBS_SENTRY_CONFIG_INVALID" }));
  });

  it("suppresses policy defects and permits an immediate corrected retry", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200);
      response.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = Schema.decodeUnknownSync(Schema.Struct({ port: Schema.Int }))(server.address());
    const reporter = createBrowserSentryDefectReporter({
      dsn: `http://public@127.0.0.1:${address.port}/1`,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy: {
        attributes: {
          "secret.value": { classification: "forbidden", required: false, metricLabel: false },
        },
        blockedKeys: [],
        blockedValuePatterns: [],
      },
    });
    const defect = { ...envelope("policy"), context: new Map([["secret.value", "value"]]) };
    expect(reporter.capture({ envelope: defect })).toEqual({
      kind: "suppressed",
      reason: "policy",
    });
    const corrected = { ...defect, context: new Map<string, string>() };
    expect(await reporter.sendVerificationDefect({ envelope: corrected })).toMatchObject({
      flushed: true,
    });
    await reporter.dispose();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  });

  it("covers source-map invalid configuration", () => {
    expect(() =>
      sentrySourceMapUpload({
        organization: "",
        project: "web",
        release: "1.4.0",
        includePaths: [],
      }),
    ).toThrowError(expect.objectContaining({ code: "OBS_SENTRY_SOURCE_MAP_INVALID" }));
  });

  it("keeps disabled and closed outcomes explicit", async () => {
    const reporter = createBrowserSentryDefectReporter({
      disabled: true,
      service: { name: "web", version: "1.4.0", environment: "test" },
      policy,
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
