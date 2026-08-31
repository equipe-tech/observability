import { defineTelemetryContract } from "@equipe-tech/observability";
import { createNodeObservability } from "@equipe-tech/observability/node";
import { unexpectedDefect } from "@equipe-tech/observability/policy";
import { evlogAdapter } from "@equipe-tech/observability-evlog";
import { getCurrentScope, getGlobalScope, getIsolationScope } from "@sentry/node-core/light";
import { Effect, Schema } from "effect";
import { createServer } from "node:http";
import { sentryDefectAdapter } from "../src/node/index.ts";

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
getGlobalScope().addAttachment({ filename: "global-secret.txt", data: "GLOBAL_ATTACHMENT_SECRET" });
getIsolationScope().addAttachment({
  filename: "isolation-secret.txt",
  data: "ISOLATION_ATTACHMENT_SECRET",
});
getCurrentScope().addAttachment({
  filename: "current-secret.txt",
  data: "CURRENT_ATTACHMENT_SECRET",
});
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
const receipt = await sentry.sendVerificationDefect({
  envelope: unexpectedDefect({ error: new Error("attachment"), code: "OBS_ATTACHMENT" }),
});
await runtime.close();
await new Promise<void>((resolve, reject) =>
  server.close((error) => (error === undefined ? resolve() : reject(error))),
);
const wire =
  "eventId" in receipt ? (bodies.find((body) => body.includes(receipt.eventId)) ?? "") : "";
if (
  !("flushed" in receipt) ||
  wire.trim().split("\n").length !== 3 ||
  wire.includes("ATTACHMENT_SECRET") ||
  wire.includes("secret.txt") ||
  wire.includes('"type":"attachment"')
) {
  process.exit(1);
}
