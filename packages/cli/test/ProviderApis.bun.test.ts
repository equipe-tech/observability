import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AxiomCredentials } from "../src/CredentialsStore.ts";
import { AxiomApi, AxiomToken } from "../src/ProviderApis.ts";

const credentials = new AxiomCredentials({ token: "test-token", organizationId: "test-org" });

const withAxiomEndpoint = async <A>(url: string, use: () => Promise<A>): Promise<A> => {
  const previousNodeEnvironment = process.env.NODE_ENV;
  const previousEndpoint = process.env.OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL;
  process.env.NODE_ENV = "test";
  process.env.OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL = url;
  try {
    return await use();
  } finally {
    if (previousNodeEnvironment === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnvironment;
    }
    if (previousEndpoint === undefined) {
      delete process.env.OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL;
    } else {
      process.env.OBSERVABILITY_CLI_TEST_AXIOM_BASE_URL = previousEndpoint;
    }
  }
};

const identityError = (url: string) =>
  withAxiomEndpoint(url, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* AxiomApi;
        return yield* Effect.flip(api.identity(credentials));
      }).pipe(Effect.provide(AxiomApi.layer)),
    ),
  );

const tokenError = (url: string) =>
  withAxiomEndpoint(url, () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const api = yield* AxiomApi;
        return yield* Effect.flip(api.createToken(credentials, "test-token", ["test-dataset"]));
      }).pipe(Effect.provide(AxiomApi.layer)),
    ),
  );

const startTruncatedResponseServer = (status: number, statusText: string) => {
  const responded = new WeakSet<object>();
  let responses = 0;
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        if (responded.has(socket)) {
          return;
        }
        responded.add(socket);
        responses += 1;
        socket.end(
          `HTTP/1.1 ${status} ${statusText}\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{`,
        );
      },
    },
  });
  return { listener, responses: () => responses };
};

describe("provider HTTP boundary", () => {
  test.serial("creates signal datasets with exact kinds and optional configuration", async () => {
    const requests: Array<{ readonly path: string; readonly body: string }> = [];
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        const body = await request.text();
        requests.push({ path: url.pathname, body });
        const value = JSON.parse(body);
        return Response.json(
          {
            id: `id-${requests.length}`,
            name: value.name,
            description: value.description,
            kind: value.kind,
            edgeDeployment: value.edgeDeployment,
            retentionDays: value.retentionDays,
            useRetentionPeriod: value.useRetentionPeriod ?? false,
          },
          { status: 201 },
        );
      },
    });
    try {
      await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            yield* api.createDataset(credentials, "project-traces");
            yield* api.createDataset(credentials, "project-logs", {
              kind: "axiom:events:v1",
            });
            yield* api.createDataset(credentials, "project-metrics", {
              kind: "otel:metrics:v1",
              edgeDeployment: "edge-main",
              retentionDays: 30,
            });
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(requests.map((request) => JSON.parse(request.body))).toEqual([
        {
          name: "project-traces",
          description: "OpenTelemetry data for project-traces",
          kind: "axiom:events:v1",
        },
        {
          name: "project-logs",
          description: "OpenTelemetry data for project-logs",
          kind: "axiom:events:v1",
        },
        {
          name: "project-metrics",
          description: "OpenTelemetry data for project-metrics",
          kind: "otel:metrics:v1",
          edgeDeployment: "edge-main",
          retentionDays: 30,
          useRetentionPeriod: true,
        },
      ]);
    } finally {
      await server.stop(true);
    }
  });

  test.serial("rereads and reconciles an exact dataset after HTTP 409", async () => {
    let reads = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (request.method === "POST") {
          return Response.json({ error: "exists" }, { status: 409 });
        }
        reads += 1;
        return Response.json([
          {
            id: "metrics-id",
            name: "project-metrics",
            description: "metrics",
            kind: "otel:metrics:v1",
            edgeDeployment: "edge-main",
            retentionDays: 30,
            useRetentionPeriod: true,
          },
        ]);
      },
    });
    try {
      const dataset = await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            return yield* api.createDataset(credentials, "project-metrics", {
              kind: "otel:metrics:v1",
              edgeDeployment: "edge-main",
              retentionDays: 30,
            });
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(dataset.kind).toBe("otel:metrics:v1");
      expect(reads).toBe(1);
    } finally {
      await server.stop(true);
    }
  });

  test.serial("rejects an incompatible dataset after HTTP 409", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        request.method === "POST"
          ? Response.json({ error: "exists" }, { status: 409 })
          : Response.json([
              {
                id: "metrics-id",
                name: "project-metrics",
                description: "generic create defect",
                kind: "axiom:events:v1",
                useRetentionPeriod: false,
              },
            ]),
    });
    try {
      const error = await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            return yield* Effect.flip(
              api.createDataset(credentials, "project-metrics", {
                kind: "otel:metrics:v1",
              }),
            );
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(error.code).toBe("OBS_CLI_AXIOM_DATASET_CONFLICT");
    } finally {
      await server.stop(true);
    }
  });

  test.serial("rejects malformed dataset kinds and token capabilities", async () => {
    let tokenResponse = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) => {
        if (new URL(request.url).pathname === "/v2/datasets") {
          return Response.json([
            {
              id: "bad-id",
              name: "bad-dataset",
              description: "bad",
              kind: "generic",
              useRetentionPeriod: false,
            },
          ]);
        }
        tokenResponse = true;
        return Response.json([
          {
            id: "bad-token",
            name: "bad-token",
            description: "bad",
            datasetCapabilities: { dataset: { ingest: "create" } },
            orgCapabilities: {},
          },
        ]);
      },
    });
    try {
      const result = await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            const datasetError = yield* Effect.flip(api.datasets(credentials));
            const tokenError = yield* Effect.flip(api.tokens(credentials));
            return { datasetError, tokenError };
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(result.datasetError.code).toBe("OBS_CLI_REMOTE_INVALID_RESPONSE");
      expect(result.tokenError.code).toBe("OBS_CLI_REMOTE_INVALID_RESPONSE");
      expect(tokenResponse).toBeTrue();
    } finally {
      await server.stop(true);
    }
  });

  test.serial("parses complete organization, dataset and view token capabilities", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.json([
          {
            id: "token-id",
            name: "collector",
            description: "collector token",
            expiresAt: "2030-01-01T00:00:00Z",
            datasetCapabilities: {
              traces: { ingest: ["create"], query: ["read"] },
            },
            orgCapabilities: { datasets: ["read"] },
            viewCapabilities: { dashboard: ["read"] },
          },
        ]),
    });
    try {
      const tokens = await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            return yield* api.tokens(credentials);
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(tokens[0]?.datasetCapabilities.traces?.query).toEqual(["read"]);
      expect(tokens[0]?.orgCapabilities.datasets).toEqual(["read"]);
      expect(tokens[0]?.viewCapabilities.dashboard).toEqual(["read"]);
    } finally {
      await server.stop(true);
    }
  });

  test.serial("regenerates tokens with the documented exact newToken body", async () => {
    let body = "";
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        body = await request.text();
        return Response.json({ id: "token-id", token: "new-secret" });
      },
    });
    const token = new AxiomToken({
      id: "token-id",
      name: "project-collector",
      description: "collector",
      datasetCapabilities: {},
      orgCapabilities: {},
      viewCapabilities: {},
    });
    try {
      await withAxiomEndpoint(`http://127.0.0.1:${server.port}`, () =>
        Effect.runPromise(
          Effect.gen(function* () {
            const api = yield* AxiomApi;
            yield* api.regenerateToken(credentials, token, ["traces", "logs", "metrics"]);
          }).pipe(Effect.provide(AxiomApi.layer)),
        ),
      );
      expect(JSON.parse(body)).toEqual({
        newToken: {
          name: "project-collector",
          description: "collector",
          datasetCapabilities: {
            traces: { ingest: ["create"] },
            logs: { ingest: ["create"] },
            metrics: { ingest: ["create"] },
          },
          orgCapabilities: {},
          viewCapabilities: {},
        },
      });
    } finally {
      await server.stop(true);
    }
  });
  test.serial("classifies unauthorized before consuming a body proven unreadable", async () => {
    const server = startTruncatedResponseServer(401, "Unauthorized");
    const url = `http://127.0.0.1:${server.listener.port}`;
    try {
      const response = await fetch(`${url}/v2/user`);
      expect(response.status).toBe(401);
      const bodyOutcome = await Promise.race([
        response.text().then(
          () => "read",
          () => "failed",
        ),
        Bun.sleep(500).then(() => "blocked"),
      ]);
      expect(["failed", "blocked"]).toContain(bodyOutcome);

      const error = await identityError(url);
      expect(error.code).toBe("OBS_CLI_REMOTE_UNAUTHORIZED");
      expect(error.status).toBe(401);
      expect(server.responses()).toBe(2);
    } finally {
      server.listener.stop(true);
    }
  });

  test.serial("preserves successful status on unreadable token response bodies", async () => {
    for (const status of [200, 201]) {
      const server = startTruncatedResponseServer(status, "Success");
      try {
        const error = await tokenError(`http://127.0.0.1:${server.listener.port}`);
        expect(error.code).toBe("OBS_CLI_REMOTE_FAILED");
        expect(error.status).toBe(status);
      } finally {
        server.listener.stop(true);
      }
    }
  });

  test.serial("reports unexpected successful token statuses", async () => {
    for (const status of [202, 204]) {
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () =>
          status === 204
            ? new Response(undefined, { status })
            : Response.json({ id: "token", token: "secret" }, { status }),
      });
      try {
        const error = await tokenError(`http://127.0.0.1:${server.port}`);
        expect(error.code).toBe("OBS_CLI_REMOTE_FAILED");
        expect(error.status).toBe(status);
      } finally {
        await server.stop(true);
      }
    }
  });

  test.serial("rejects redirects from the loopback-only Axiom test endpoint", async () => {
    let redirectedRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        redirectedRequests += 1;
        return Response.json({ id: "owner", email: "owner@example.com" });
      },
    });
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(undefined, {
          status: 302,
          headers: { location: `http://127.0.0.1:${destination.port}/v2/user` },
        }),
    });
    try {
      const error = await identityError(`http://127.0.0.1:${origin.port}`);
      expect(error.code).toBe("OBS_CLI_REMOTE_FAILED");
      expect(error.status).toBe(0);
      expect(redirectedRequests).toBe(0);
    } finally {
      await origin.stop(true);
      await destination.stop(true);
    }
  });
});
