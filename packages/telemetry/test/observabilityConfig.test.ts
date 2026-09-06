import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";
import type { EventName } from "../src/contract/EventName.ts";
import type {
  CompiledAuditActionDefinition,
  CompiledEventDefinition,
} from "../src/contract/TelemetryContract.ts";
import type { ContractRegistry } from "../src/profile/ObservabilityAdapter.ts";
import {
  nodeObservabilityConfigFromEnv,
  parseNodeObservabilityConfig,
} from "../src/profile/ObservabilityConfig.ts";
import { parseDataPolicy } from "../src/profile/DataPolicy.ts";

const contract: ContractRegistry = {
  version: 1,
  eventNames: [],
  eventByAlias: new Map<string, CompiledEventDefinition>(),
  eventByName: new Map<EventName, CompiledEventDefinition>(),
  auditActionByAlias: new Map<string, CompiledAuditActionDefinition>(),
  auditActionByName: new Map<string, CompiledAuditActionDefinition>(),
};

const policy = { attributes: {}, blockedKeys: [], blockedValuePatterns: [] };

const fromEnv = (
  profile: "nestjs-api" | "worker" | "react-web" | "cli" | "library",
  env: {
    readonly [name: string]: string | undefined;
  },
) => nodeObservabilityConfigFromEnv({ profile, env, contract, policy });

describe("node observability configuration", () => {
  it("keeps local defaults only for loopback endpoints", async () => {
    const config = await Effect.runPromise(fromEnv("worker", { OTEL_SERVICE_NAME: "jobs" }));
    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.deployment).toBe("local");
      expect(config.identity.serviceVersion).toBe("0.0.0");
      expect(config.identity.environment).toBe("development");
    }
  });

  it("treats explicitly undefined optional variables like absent local values", async () => {
    const config = await Effect.runPromise(
      fromEnv("worker", {
        OTEL_SERVICE_NAME: "jobs",
        OTEL_SERVICE_VERSION: undefined,
        OTEL_DEPLOYMENT_ENVIRONMENT: undefined,
        OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
        OTEL_SERVICE_INSTANCE_ID: undefined,
      }),
    );
    expect(config.enabled).toBe(true);
    if (config.enabled) {
      expect(config.identity.serviceVersion).toBe("0.0.0");
      expect(config.identity.environment).toBe("development");
      expect(config.telemetry.otlpEndpoint.toString()).toBe("http://localhost:4318/");
    }
  });

  it("reports typed fields for explicitly undefined remote identity", async () => {
    const fixtures: ReadonlyArray<{
      readonly field: "OTEL_SERVICE_VERSION" | "OTEL_DEPLOYMENT_ENVIRONMENT";
      readonly value: { readonly [name: string]: string | undefined };
    }> = [
      { field: "OTEL_SERVICE_VERSION", value: { OTEL_SERVICE_VERSION: undefined } },
      {
        field: "OTEL_DEPLOYMENT_ENVIRONMENT",
        value: { OTEL_DEPLOYMENT_ENVIRONMENT: undefined },
      },
    ];
    for (const fixture of fixtures) {
      const error = await Effect.runPromise(
        Effect.flip(
          fromEnv("worker", {
            OTEL_SERVICE_NAME: "jobs",
            OTEL_SERVICE_VERSION: "1.4.0",
            OTEL_DEPLOYMENT_ENVIRONMENT: "production",
            OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
            ...fixture.value,
          }),
        ),
      );
      expect(error).toMatchObject({
        _tag: "InvalidObservabilityConfig",
        code: "OBS_OBSERVABILITY_CONFIG_INVALID",
        field: fixture.field,
      });
    }
  });

  it("reports the exact field and code for each invalid environment value", async () => {
    const fixtures: ReadonlyArray<{
      readonly field:
        | "OTEL_SERVICE_NAME"
        | "OTEL_SERVICE_VERSION"
        | "OTEL_SERVICE_INSTANCE_ID"
        | "OTEL_DEPLOYMENT_ENVIRONMENT"
        | "OTEL_EXPORTER_OTLP_ENDPOINT"
        | "SENTRY_DSN";
      readonly env: { readonly [name: string]: string | undefined };
    }> = [
      { field: "OTEL_SERVICE_NAME", env: {} },
      { field: "OTEL_SERVICE_NAME", env: { OTEL_SERVICE_NAME: "Invalid" } },
      {
        field: "OTEL_SERVICE_VERSION",
        env: { OTEL_SERVICE_NAME: "jobs", OTEL_SERVICE_VERSION: "latest" },
      },
      {
        field: "OTEL_SERVICE_INSTANCE_ID",
        env: { OTEL_SERVICE_NAME: "jobs", OTEL_SERVICE_INSTANCE_ID: "x".repeat(129) },
      },
      {
        field: "OTEL_DEPLOYMENT_ENVIRONMENT",
        env: { OTEL_SERVICE_NAME: "jobs", OTEL_DEPLOYMENT_ENVIRONMENT: "Production" },
      },
      {
        field: "OTEL_EXPORTER_OTLP_ENDPOINT",
        env: { OTEL_SERVICE_NAME: "jobs", OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" },
      },
      {
        field: "OTEL_EXPORTER_OTLP_ENDPOINT",
        env: {
          OTEL_SERVICE_NAME: "jobs",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://user:secret@collector.example.com",
        },
      },
      { field: "SENTRY_DSN", env: { OTEL_SERVICE_NAME: "jobs", SENTRY_DSN: "not-a-url" } },
    ];
    for (const fixture of fixtures) {
      const error = await Effect.runPromise(Effect.flip(fromEnv("worker", fixture.env)));
      expect(error).toMatchObject({
        _tag: "InvalidObservabilityConfig",
        code: "OBS_OBSERVABILITY_CONFIG_INVALID",
        field: fixture.field,
      });
    }
  });

  it("returns a typed endpoint error for explicit credential-bearing configuration", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseNodeObservabilityConfig({
          enabled: true,
          profile: "worker",
          service: { name: "jobs", version: "1.4.0", environment: "test" },
          telemetry: { endpoint: new URL("https://user:secret@collector.example.com") },
          evlog: { contract, policy },
          sentry: { enabled: false },
        }),
      ),
    );
    expect(error).toMatchObject({
      _tag: "InvalidObservabilityConfig",
      code: "OBS_OBSERVABILITY_CONFIG_INVALID",
      field: "OTEL_EXPORTER_OTLP_ENDPOINT",
    });
  });

  it("classifies exact loopback spellings as local", async () => {
    for (const endpoint of [
      "http://localhost:4318",
      "http://localhost.:4318",
      "http://127.0.0.0:4318",
      "http://127.0.0.1:4318",
      "http://127.255.255.255:4318",
      "http://127.1:4318",
      "http://[::1]:4318",
      "http://[::ffff:127.0.0.1]:4318",
    ]) {
      const config = await Effect.runPromise(
        fromEnv("worker", {
          OTEL_SERVICE_NAME: "jobs",
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        }),
      );
      expect(config.enabled && config.deployment).toBe("local");
    }
  });

  it("requires explicit identity for DNS names that resemble loopback", async () => {
    for (const endpoint of [
      "http://127.example.com:4318",
      "http://127.0.0.1.example.com:4318",
      "http://localhost.example.com:4318",
      "http://localhost..:4318",
    ]) {
      const error = await Effect.runPromise(
        Effect.flip(
          fromEnv("worker", {
            OTEL_SERVICE_NAME: "jobs",
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          }),
        ),
      );
      expect(error._tag).toBe("InvalidObservabilityConfig");
      expect(error.code).toBe("OBS_OBSERVABILITY_CONFIG_INVALID");
      if (error._tag !== "InvalidObservabilityConfig") throw new Error("Expected config error.");
      expect(error.field).toBe("OTEL_SERVICE_VERSION");
    }
  });

  it("requires both remote identity values", async () => {
    const version = await Effect.runPromise(
      Effect.flip(
        fromEnv("worker", {
          OTEL_SERVICE_NAME: "jobs",
          OTEL_DEPLOYMENT_ENVIRONMENT: "production",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
        }),
      ),
    );
    const environment = await Effect.runPromise(
      Effect.flip(
        fromEnv("worker", {
          OTEL_SERVICE_NAME: "jobs",
          OTEL_SERVICE_VERSION: "1.4.0",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
        }),
      ),
    );
    if (version._tag !== "InvalidObservabilityConfig") throw new Error("Expected config error.");
    if (environment._tag !== "InvalidObservabilityConfig") {
      throw new Error("Expected config error.");
    }
    expect(version.code).toBe("OBS_OBSERVABILITY_CONFIG_INVALID");
    expect(version.field).toBe("OTEL_SERVICE_VERSION");
    expect(environment.code).toBe("OBS_OBSERVABILITY_CONFIG_INVALID");
    expect(environment.field).toBe("OTEL_DEPLOYMENT_ENVIRONMENT");
  });

  it("rejects a second release identity but ignores an empty value", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        fromEnv("worker", {
          OTEL_SERVICE_NAME: "jobs",
          SENTRY_RELEASE: "1.4.0",
        }),
      ),
    );
    expect(error.code).toBe("OBS_TELEMETRY_DUPLICATE_RELEASE_VARIABLE");
    expect(error.message).toContain("OTEL_SERVICE_VERSION");
    await Effect.runPromise(fromEnv("worker", { OTEL_SERVICE_NAME: "jobs", SENTRY_RELEASE: "" }));
  });

  it("requires defects only for production node profiles", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        fromEnv("nestjs-api", {
          OTEL_SERVICE_NAME: "api",
          OTEL_SERVICE_VERSION: "1.4.0",
          OTEL_DEPLOYMENT_ENVIRONMENT: "production",
          OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
        }),
      ),
    );
    if (error._tag !== "InvalidObservabilityConfig") throw new Error("Expected config error.");
    expect(error.code).toBe("OBS_OBSERVABILITY_CONFIG_INVALID");
    expect(error.field).toBe("SENTRY_DSN");
    const staging = await Effect.runPromise(
      fromEnv("nestjs-api", {
        OTEL_SERVICE_NAME: "api",
        OTEL_SERVICE_VERSION: "1.4.0",
        OTEL_DEPLOYMENT_ENVIRONMENT: "staging",
        OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example.com",
      }),
    );
    expect(staging.enabled && staging.sentry.enabled).toBe(false);
  });

  it("rejects browser and library profiles at the Node boundary", async () => {
    const unsupportedProfiles: ReadonlyArray<"react-web" | "library"> = ["react-web", "library"];
    for (const profile of unsupportedProfiles) {
      const error = await Effect.runPromise(
        Effect.flip(fromEnv(profile, { OTEL_SERVICE_NAME: "package" })),
      );
      expect(error.code).toBe("OBS_OBSERVABILITY_PROFILE_UNSUPPORTED_RUNTIME");
      if (error._tag !== "InvalidObservabilityConfig") throw new Error("Expected config error.");
      expect(error.field).toBe("profile");
    }
  });

  it("parses the closed disabled union without reading partial fields", async () => {
    expect(await Effect.runPromise(parseNodeObservabilityConfig({ enabled: false }))).toEqual({
      enabled: false,
    });
  });

  it("wraps invalid policy patterns in a safe observability config error", async () => {
    const secret = crypto.randomUUID().replaceAll("-", "");
    const failure = await Effect.runPromise(
      Effect.flip(
        nodeObservabilityConfigFromEnv({
          profile: "worker",
          env: { OTEL_SERVICE_NAME: "jobs" },
          contract,
          policy: {
            attributes: {},
            blockedKeys: [],
            blockedValuePatterns: [`[${secret}`],
          },
        }),
      ),
    );
    expect(failure._tag).toBe("InvalidObservabilityConfig");
    if (failure._tag !== "InvalidObservabilityConfig") {
      throw new Error("Expected a policy configuration error.");
    }
    expect(failure.field).toBe("policy");
    expect(JSON.stringify(failure)).not.toContain(secret);
    expect(JSON.stringify(failure.cause)).not.toContain(secret);
  });

  it("validates policy patterns and clones base regular expressions", async () => {
    const parsed = await Effect.runPromise(parseDataPolicy(policy));
    const second = await Effect.runPromise(parseDataPolicy(policy));
    expect(parsed.blockedKeys.some((pattern) => pattern.test("authorization"))).toBe(true);
    expect(parsed.blockedValuePatterns[0]).not.toBe(second.blockedValuePatterns[0]);
    const firstPattern = parsed.blockedValuePatterns[0];
    const secondPattern = second.blockedValuePatterns[0];
    if (firstPattern === undefined || secondPattern === undefined) {
      throw new Error("Expected base blocked value patterns.");
    }
    firstPattern.test("Bearer secret");
    expect(secondPattern.lastIndex).toBe(0);
    const invalidPattern = await Effect.runPromise(
      Effect.flip(parseDataPolicy({ ...policy, blockedValuePatterns: ["["] })),
    );
    expect(invalidPattern.code).toBe("OBS_POLICY_INVALID");
    expect(invalidPattern.issues[0]?.code).toBe("OBS_POLICY_INVALID_BLOCKED_VALUE_PATTERN");
    const invalidPolicy = await Effect.runPromise(
      Effect.flip(parseDataPolicy({ ...policy, blockedKeys: ["x".repeat(129)] })),
    );
    expect(invalidPolicy.code).toBe("OBS_POLICY_INVALID");
    expect(invalidPolicy.issues[0]?.code).toBe("OBS_POLICY_INVALID_DOCUMENT");
  });
});
