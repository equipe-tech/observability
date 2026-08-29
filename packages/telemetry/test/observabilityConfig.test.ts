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

  it("classifies IPv4 and IPv6 loopback endpoints as local", async () => {
    for (const endpoint of ["http://127.0.0.1:4318", "http://[::1]:4318"]) {
      const config = await Effect.runPromise(
        fromEnv("worker", {
          OTEL_SERVICE_NAME: "jobs",
          OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        }),
      );
      expect(config.enabled && config.deployment).toBe("local");
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
    expect(version.field).toBe("OTEL_SERVICE_VERSION");
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

  it("validates policy patterns and preserves base declarations", async () => {
    const parsed = await Effect.runPromise(parseDataPolicy(policy));
    expect(parsed.blockedKeys).toContain("authorization");
    const error = await Effect.runPromise(
      Effect.flip(parseDataPolicy({ ...policy, blockedValuePatterns: ["["] })),
    );
    expect(error.field).toBe("policy.blockedValuePatterns");
  });
});
