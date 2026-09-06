import { defineTelemetryContract } from "@equipe-tech/observability";
import { createNodeObservability } from "@equipe-tech/observability/node";
import { unexpectedDefect } from "@equipe-tech/observability/policy";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { getGlobalScope } from "@sentry/node-core/light";
import { Effect } from "effect";
import { sentryDefectAdapter } from "../src/node/index.ts";

getGlobalScope().addEventProcessor(() => null);
const contract = await Effect.runPromise(
  defineTelemetryContract({ version: 1, events: {}, metrics: {}, auditActions: {} }),
);
const sentry = sentryDefectAdapter({
  flushDeadlineMillis: 20,
  closeDeadlineMillis: 20,
  dedupeCapacity: 1,
});
const events = evlogAdapter({ installGlobalLogger: false, stdout: { write: () => true } });
const runtime = await createNodeObservability({
  profile: "worker",
  env: {
    OTEL_SERVICE_NAME: "worker",
    OTEL_SERVICE_VERSION: "1.4.0",
    OTEL_DEPLOYMENT_ENVIRONMENT: "test",
    OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:1",
    SENTRY_DSN: "http://public@127.0.0.1:1/1",
  },
  contract,
  policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
  adapters: [events.registration, sentry.registration],
});
const envelope = unexpectedDefect({ error: new Error("drop"), code: "OBS_DROP" });
const first = await sentry.sendVerificationDefect({ envelope });
const second = await sentry.sendVerificationDefect({ envelope });
const report = sentry.reports();
await runtime.close();
if (
  !("kind" in first) ||
  first.kind !== "failed" ||
  !("kind" in second) ||
  second.kind !== "failed" ||
  report.reasons.transport !== 2 ||
  report.reasons.captured !== 0
) {
  process.exit(1);
}
