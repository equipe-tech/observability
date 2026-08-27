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

describe("provider HTTP boundary", () => {
  test.serial("classifies unauthorized before consuming an unreadable body", async () => {
    let responded = false;
    const listener = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(socket) {
          if (responded) {
            return;
          }
          responded = true;
          socket.end(
            "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: 100\r\nConnection: close\r\n\r\n{",
          );
        },
      },
    });
    try {
      const error = await identityError(`http://127.0.0.1:${listener.port}`);
      expect(error.code).toBe("OBS_CLI_REMOTE_UNAUTHORIZED");
      expect(error.status).toBe(401);
    } finally {
      listener.stop(true);
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
