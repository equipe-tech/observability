import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { AxiomCredentials } from "../src/CredentialsStore.ts";
import { AxiomApi } from "../src/ProviderApis.ts";

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
