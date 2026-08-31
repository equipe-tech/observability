import { createServer, type Server } from "node:http";
import { Schema } from "effect";
import { defineConfig, type Plugin } from "vite-plus";
import { playwright } from "vite-plus/test/browser-playwright";

const bodies = () => {
  const values: Array<string> = [];
  return {
    add: (value: string) => values.push(value),
    json: () => JSON.stringify(values),
  };
};

const Address = Schema.Struct({ port: Schema.Number });
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(Schema.decodeUnknownSync(Address)(server.address()).port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
  );

const target = (port: number): string => `http://127.0.0.1:${port}`;
const eventBodies = bodies();
const sentryBodies = bodies();
const ingest = createServer((request, response) => {
  if (request.url === "/_inspect/events") {
    response.writeHead(200, { "content-type": "application/json" }).end(eventBodies.json());
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (part) => {
    body += part;
  });
  request.on("end", () => {
    eventBodies.add(body);
    response.writeHead(202).end();
  });
});
const sentry = createServer((request, response) => {
  if (request.url === "/_inspect/sentry") {
    response.writeHead(200, { "content-type": "application/json" }).end(sentryBodies.json());
    return;
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (part) => {
    body += part;
  });
  request.on("end", () => {
    sentryBodies.add(body);
    response.writeHead(200).end();
  });
});
const ingestPort = await listen(ingest);
const sentryPort = await listen(sentry);
const teardown: Plugin = {
  name: "obs-54-browser-wire-teardown",
  closeBundle: async () => {
    await Promise.all([close(ingest), close(sentry)]);
  },
};

export default defineConfig({
  plugins: [teardown],
  server: {
    proxy: {
      "/_telemetry": { target: target(ingestPort) },
      "/_inspect/events": { target: target(ingestPort) },
      "/_inspect/sentry": { target: target(sentryPort) },
      "/sentry": {
        target: target(sentryPort),
        rewrite: (path: string) => path.slice("/sentry".length),
      },
    },
  },
  test: {
    include: ["packages/react/test/**/*.browser.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright(),
      instances: [{ browser: "chromium" }],
    },
  },
});
