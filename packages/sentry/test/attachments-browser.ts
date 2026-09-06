import { unexpectedDefect } from "@equipe-tech/observability/policy";
import { getCurrentScope, getGlobalScope, getIsolationScope } from "@sentry/browser";
import { Schema } from "effect";
import { createServer } from "node:http";
import { createBrowserSentryDefectReporter } from "../src/browser/index.ts";

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
const reporter = createBrowserSentryDefectReporter({
  dsn: `http://public@127.0.0.1:${address.port}/1`,
  service: { name: "web", version: "1.4.0", environment: "test" },
  policy: { attributes: {}, blockedKeys: [], blockedValuePatterns: [] },
});
const receipt = await reporter.sendVerificationDefect({
  envelope: unexpectedDefect({ error: new Error("attachment"), code: "OBS_ATTACHMENT" }),
});
await reporter.dispose();
await new Promise<void>((resolve, reject) =>
  server.close((error) => (error === undefined ? resolve() : reject(error))),
);
const wire = bodies.join("\n");
if (
  !("flushed" in receipt) ||
  bodies.length !== 1 ||
  wire.trim().split("\n").length !== 3 ||
  wire.includes("ATTACHMENT_SECRET") ||
  wire.includes("secret.txt") ||
  wire.includes('"type":"attachment"')
) {
  process.exit(1);
}
