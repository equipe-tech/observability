import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  parseOperationsContractIndex,
  parseOperationsManifest,
  validateOperationsManifest,
} from "../src/OperationsManifest.ts";

const contract = JSON.stringify({
  index: 1,
  contractVersion: 1,
  service: "checkout",
  events: [{ name: "payment.attempt", kind: "operation", attributes: ["payment.provider"] }],
  metrics: [
    {
      name: "payment.latency",
      kind: "histogram",
      unit: "ms",
      attributes: ["payment.provider"],
    },
  ],
  aliases: [],
});

const validManifest = `
version: 1
contractVersion: 1
service: checkout
environments: [staging]
retention:
  - environment: staging
    days: 30
sentry:
  enabled: true
dashboards:
  - id: payments
    title: Payments
    panels:
      - id: attempts
        title: Attempts
        sources:
          - kind: event
            name: payment.attempt
        query: signal(logs) | where event.name == "payment.attempt" | summarize count()
monitors:
  - id: latency
    title: Latency
    source:
      kind: metric
      name: payment.latency
    query: signal(metrics) | where metric.name == "payment.latency" | summarize quantile(value, 0.95)
    threshold: 25
`;

const validate = Effect.gen(function* () {
  const manifest = yield* parseOperationsManifest(validManifest);
  const index = yield* parseOperationsContractIndex(contract);
  return yield* validateOperationsManifest(manifest, index);
});

describe("operations manifest", () => {
  test("parses YAML, contract index and exact query sources", async () => {
    const validated = await Effect.runPromise(validate);
    expect(validated.manifest.service).toBe("checkout");
    expect(validated.dashboards[0]?.panels[0]?.query.binding.identifiers).toEqual([
      "payment.attempt",
    ]);
  });

  test("rejects unknown fields under the strict version schema", async () => {
    const error = await Effect.runPromise(
      Effect.flip(parseOperationsManifest(`${validManifest}\nproviderText: forbidden`)),
    );
    expect(error.code).toBe("OBS_CLI_MANIFEST_INVALID");
  });

  test("rejects unsupported version before semantic validation", async () => {
    const error = await Effect.runPromise(
      Effect.flip(parseOperationsManifest(validManifest.replace("version: 1", "version: 2"))),
    );
    expect(error.code).toBe("OBS_CLI_MANIFEST_VERSION_UNSUPPORTED");
  });

  test("aggregates duplicates, orphan signals and retention errors", async () => {
    const malformed = validManifest
      .replace("environments: [staging]", "environments: [staging, staging]")
      .replace("name: payment.attempt", "name: payment.unknown")
      .replace("environment: staging", "environment: production");
    const manifest = await Effect.runPromise(parseOperationsManifest(malformed));
    const index = await Effect.runPromise(parseOperationsContractIndex(contract));
    const error = await Effect.runPromise(Effect.flip(validateOperationsManifest(manifest, index)));
    expect(error.code).toBe("OBS_CLI_MANIFEST_INVALID");
    if (error._tag !== "OperationsManifestError") throw new Error("Expected manifest error.");
    expect(error.issues).toContain("duplicate environment staging");
    expect(error.issues).toContain("unknown event payment.unknown");
    expect(error.issues).toContain("unknown retention environment production");
  });

  test("rejects undeclared fields and metric aggregations that conflict with metric kind", async () => {
    const index = await Effect.runPromise(parseOperationsContractIndex(contract));
    const undeclared = await Effect.runPromise(
      parseOperationsManifest(
        validManifest.replace(
          'event.name == "payment.attempt"',
          'event.name == "payment.attempt" and payment.secret == "x"',
        ),
      ),
    );
    const undeclaredError = await Effect.runPromise(
      Effect.flip(validateOperationsManifest(undeclared, index)),
    );
    if (undeclaredError._tag !== "OperationsManifestError") {
      throw new Error("Expected source error.");
    }
    expect(undeclaredError.issues).toContain("undeclared query field payment.secret");
    const illegalAggregation = await Effect.runPromise(
      parseOperationsManifest(validManifest.replace("quantile(value, 0.95)", "sum(value)")),
    );
    const aggregationError = await Effect.runPromise(
      Effect.flip(validateOperationsManifest(illegalAggregation, index)),
    );
    if (aggregationError._tag !== "OperationsManifestError") {
      throw new Error("Expected source error.");
    }
    expect(aggregationError.issues).toContain("illegal metric aggregation");
  });

  test("rejects stale contract and source mismatch", async () => {
    const manifest = await Effect.runPromise(parseOperationsManifest(validManifest));
    const stale = await Effect.runPromise(
      parseOperationsContractIndex(contract.replace('"contractVersion":1', '"contractVersion":2')),
    );
    expect(
      (await Effect.runPromise(Effect.flip(validateOperationsManifest(manifest, stale)))).code,
    ).toBe("OBS_CLI_CONTRACT_INDEX_STALE");

    const mismatch = await Effect.runPromise(
      parseOperationsManifest(
        validManifest.replace('event.name == "payment.attempt"', 'event.name == "other.event"'),
      ),
    );
    expect(
      (
        await Effect.runPromise(
          Effect.flip(
            validateOperationsManifest(
              mismatch,
              await Effect.runPromise(parseOperationsContractIndex(contract)),
            ),
          ),
        )
      ).code,
    ).toBe("OBS_CLI_SOURCE_INVALID");
  });
});
