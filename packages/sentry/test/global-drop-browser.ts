import { getGlobalScope } from "@sentry/browser";
import { createBrowserSentryDefectReporter } from "../src/browser/index.ts";
import { unexpectedDefect } from "@equipe-tech/observability/policy";

getGlobalScope().addEventProcessor(() => null);
const reporter = createBrowserSentryDefectReporter({
  dsn: "http://public@127.0.0.1:1/1",
  service: { name: "web", version: "1.4.0", environment: "test" },
  policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
  flushDeadlineMillis: 20,
  closeDeadlineMillis: 20,
  dedupeCapacity: 1,
});
const envelope = unexpectedDefect({ error: new Error("drop"), code: "OBS_DROP" });
const first = await reporter.sendVerificationDefect({ envelope });
const second = await reporter.sendVerificationDefect({ envelope });
const report = reporter.reports();
await reporter.dispose();
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
