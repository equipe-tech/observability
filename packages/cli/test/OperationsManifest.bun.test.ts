import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  maximumContractAliasCount,
  maximumContractAliasTargets,
  parseOperationsContractIndex,
  parseOperationsManifest,
  validateOperationsManifest,
} from "../src/OperationsManifest.ts";

const contract = JSON.stringify({
  index: 1,
  contractVersion: 1,
  service: "checkout",
  events: [
    {
      name: "payment.attempt",
      kind: "operation",
      attributes: ["payment.provider"],
      attributeClassifications: [{ name: "payment.provider", classification: "public" }],
    },
  ],
  metrics: [
    {
      name: "payment.latency",
      kind: "histogram",
      unit: "ms",
      attributes: ["payment.provider"],
    },
    {
      name: "payment.count",
      kind: "counter",
      unit: "1",
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

type TestAlias = { readonly kind: "event"; readonly from: string; readonly to: string };

const contractWithAliases = (aliases: ReadonlyArray<TestAlias>): string =>
  JSON.stringify({
    index: 1,
    contractVersion: 1,
    service: "checkout",
    events: [
      {
        name: "payment.attempt",
        kind: "operation",
        attributes: ["payment.provider"],
        attributeClassifications: [{ name: "payment.provider", classification: "public" }],
      },
    ],
    metrics: [
      {
        name: "payment.latency",
        kind: "histogram",
        unit: "ms",
        attributes: ["payment.provider"],
      },
    ],
    aliases,
  });

const chainAliases = (length: number): ReadonlyArray<TestAlias> =>
  Array.from({ length }, (_, index) => ({
    kind: "event",
    from: `graph.node_${String(index).padStart(4, "0")}`,
    to: `graph.node_${String(index + 1).padStart(4, "0")}`,
  }));

const branchingAliases = (targets: number): ReadonlyArray<TestAlias> =>
  Array.from({ length: targets }, (_, index) => ({
    kind: "event",
    from: "graph.root",
    to: `graph.target_${String(index).padStart(4, "0")}`,
  }));

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

  test("rejects duplicate YAML keys at every mapping depth", async () => {
    const duplicates = [
      validManifest.replace("service: checkout", "service: checkout\nservice: attacker"),
      validManifest.replace("  enabled: true", "  enabled: true\n  enabled: false"),
      validManifest.replace("      - id: attempts", "      - id: attempts\n        id: attacker"),
    ];
    for (const duplicate of duplicates) {
      const error = await Effect.runPromise(Effect.flip(parseOperationsManifest(duplicate)));
      expect(error.code).toBe("OBS_CLI_MANIFEST_INVALID");
      expect(error.issues).toContain("YAML contains duplicate or unsupported mapping keys");
    }
  });

  test("allows repeated keys in separate list items and block query scalar syntax", async () => {
    const content = validManifest
      .replace("environments: [staging]", "environments: [staging, prod]")
      .replace("    days: 30", "    days: 30\n  - environment: prod\n    days: 14")
      .replace(
        '        query: signal(logs) | where event.name == "payment.attempt" | summarize count()',
        '        query: |\n          signal(logs) | where event.name == "payment.attempt" and note == "colon: AND text" | summarize count()',
      );
    const manifest = await Effect.runPromise(parseOperationsManifest(content));
    expect(manifest.retention.map((entry) => entry.days)).toEqual([30, 14]);
    expect(manifest.dashboards[0]?.panels[0]?.query).toContain("colon: AND text");
  });

  test("rejects ambiguous complex YAML mapping keys", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseOperationsManifest(
          validManifest.replace("service: checkout", "? [service, checkout]\n: rejected"),
        ),
      ),
    );
    expect(error.code).toBe("OBS_CLI_MANIFEST_INVALID");
    expect(error.issues).toContain("YAML contains duplicate or unsupported mapping keys");
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

    const undeclaredEventAggregation = await Effect.runPromise(
      parseOperationsManifest(validManifest.replace("count()", "sum(payment.secret)")),
    );
    const eventAggregationError = await Effect.runPromise(
      Effect.flip(validateOperationsManifest(undeclaredEventAggregation, index)),
    );
    if (eventAggregationError._tag !== "OperationsManifestError") {
      throw new Error("Expected source error.");
    }
    expect(eventAggregationError.issues).toContain("undeclared query aggregation payment.secret");

    const declaredEventAggregation = await Effect.runPromise(
      parseOperationsManifest(validManifest.replace("count()", "sum(payment.provider)")),
    );
    await Effect.runPromise(validateOperationsManifest(declaredEventAggregation, index));
  });

  test("rejects uppercase, tab and newline AND undeclared-field smuggling", async () => {
    const index = await Effect.runPromise(parseOperationsContractIndex(contract));
    for (const separator of [" AND ", "\tAnD\t", "\nand\n"]) {
      const query = `signal(logs) | where event.name == "payment.attempt" and payment.provider == "stripe"${separator}payment.secret == "x" | summarize count()`;
      const manifest = await Effect.runPromise(
        parseOperationsManifest(
          validManifest.replace(
            'query: signal(logs) | where event.name == "payment.attempt" | summarize count()',
            `query: ${JSON.stringify(query)}`,
          ),
        ),
      );
      const error = await Effect.runPromise(
        Effect.flip(validateOperationsManifest(manifest, index)),
      );
      if (error._tag !== "OperationsManifestError") {
        throw new Error("Expected source error.");
      }
      expect(error.issues).toContain("undeclared query field payment.secret");
    }
  });

  test("rejects stale contract, source mismatch and cross-kind predicates", async () => {
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
    ).toBe("OBS_CLI_QUERY_SIGNAL_MISMATCH");

    const crossKind = await Effect.runPromise(
      parseOperationsManifest(
        validManifest.replace(
          'signal(logs) | where event.name == "payment.attempt"',
          'signal(metrics) | where metric.name == "payment.attempt"',
        ),
      ),
    );
    expect(
      (
        await Effect.runPromise(
          Effect.flip(
            validateOperationsManifest(
              crossKind,
              await Effect.runPromise(parseOperationsContractIndex(contract)),
            ),
          ),
        )
      ).code,
    ).toBe("OBS_CLI_SOURCE_INVALID");
  });

  test("inherits aliased event fields and metric aggregation semantics", async () => {
    const aliasedContract = contract.replace(
      '"aliases":[]',
      '"aliases":[{"kind":"event","from":"payment.charge","to":"payment.attempt"},{"kind":"metric","from":"payment.duration","to":"payment.latency"},{"kind":"metric","from":"payment.total","to":"payment.count"}]',
    );
    const manifest = await Effect.runPromise(
      parseOperationsManifest(
        validManifest
          .replace("name: payment.attempt", "name: payment.charge")
          .replace(
            'event.name == "payment.attempt" | summarize count()',
            'event.name in ("payment.attempt", "payment.charge") and payment.provider == "stripe" | summarize count() by payment.provider',
          )
          .replace("name: payment.latency", "name: payment.duration")
          .replace(
            'metric.name == "payment.latency"',
            'metric.name in ("payment.duration", "payment.latency") and payment.provider == "stripe"',
          ),
      ),
    );
    const index = await Effect.runPromise(parseOperationsContractIndex(aliasedContract));
    const validated = await Effect.runPromise(validateOperationsManifest(manifest, index));
    expect(validated.dashboards[0]?.panels[0]?.query.binding.identifiers).toEqual([
      "payment.attempt",
      "payment.charge",
    ]);
    expect(validated.monitors[0]?.query.stages.at(-1)?.kind).toBe("summarize");

    const counterManifest = await Effect.runPromise(
      parseOperationsManifest(
        validManifest
          .replaceAll("payment.latency", "payment.total")
          .replace("quantile(value, 0.95)", "sum(value)")
          .replace(
            'metric.name == "payment.total"',
            'metric.name in ("payment.count", "payment.total")',
          ),
      ),
    );
    await Effect.runPromise(validateOperationsManifest(counterManifest, index));
  });

  test("rejects alias names outside the telemetry signal grammar", async () => {
    const aliases: ReadonlyArray<TestAlias> = [
      { kind: "event", from: "Not Signal Grammar", to: "payment.attempt" },
      { kind: "event", from: "payment.old", to: "Not Signal Grammar" },
    ];
    for (const alias of aliases) {
      const error = await Effect.runPromise(
        Effect.flip(parseOperationsContractIndex(contractWithAliases([alias]))),
      );
      expect(error.code).toBe("OBS_CLI_CONTRACT_INDEX_INVALID");
    }
  });

  test("rejects alias counts above the decoder limit", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        parseOperationsContractIndex(
          contractWithAliases(branchingAliases(maximumContractAliasCount + 1)),
        ),
      ),
    );
    expect(error.code).toBe("OBS_CLI_CONTRACT_INDEX_INVALID");
  });

  test("rejects deep and branching alias graphs within a bounded runtime", async () => {
    const manifest = await Effect.runPromise(parseOperationsManifest(validManifest));
    const cases: ReadonlyArray<readonly [ReadonlyArray<TestAlias>, string]> = [
      [chainAliases(maximumContractAliasCount), "alias graph depth exceeds"],
      [branchingAliases(maximumContractAliasTargets), "alias expansion exceeds"],
    ];
    for (const [aliases, issue] of cases) {
      const index = await Effect.runPromise(
        parseOperationsContractIndex(contractWithAliases(aliases)),
      );
      const startedAt = performance.now();
      const error = await Effect.runPromise(
        Effect.flip(validateOperationsManifest(manifest, index)),
      );
      expect(performance.now() - startedAt).toBeLessThan(2_000);
      if (error._tag !== "OperationsManifestError") {
        throw new Error("Expected alias limit error.");
      }
      expect(error.issues.some((entry) => entry.includes(issue))).toBeTrue();
    }
  });

  test("rejects incompatible transitive aliases and alias cycles", async () => {
    const aliasedContract = contract.replace(
      '"aliases":[]',
      '"aliases":[{"kind":"event","from":"payment.charge","to":"payment.attempt"}]',
    );
    const manifest = await Effect.runPromise(
      parseOperationsManifest(
        validManifest
          .replace("name: payment.attempt", "name: payment.charge")
          .replace(
            'event.name == "payment.attempt"',
            'event.name in ("payment.attempt", "payment.charge")',
          ),
      ),
    );
    const cyclic = aliasedContract.replace(
      '"aliases":[{"kind":"event","from":"payment.charge","to":"payment.attempt"}]',
      '"aliases":[{"kind":"event","from":"payment.charge","to":"payment.attempt"},{"kind":"event","from":"payment.attempt","to":"payment.charge"}]',
    );
    const cyclicIndex = await Effect.runPromise(parseOperationsContractIndex(cyclic));
    const error = await Effect.runPromise(
      Effect.flip(validateOperationsManifest(manifest, cyclicIndex)),
    );
    expect(error.code).toBe("OBS_CLI_MANIFEST_INVALID");

    const incompatible = contract.replace(
      '"aliases":[]',
      '"aliases":[{"kind":"metric","from":"payment.old","to":"payment.latency"},{"kind":"metric","from":"payment.old","to":"payment.count"}]',
    );
    const incompatibleIndex = await Effect.runPromise(parseOperationsContractIndex(incompatible));
    const incompatibleError = await Effect.runPromise(
      Effect.flip(
        validateOperationsManifest(
          await Effect.runPromise(parseOperationsManifest(validManifest)),
          incompatibleIndex,
        ),
      ),
    );
    if (incompatibleError._tag !== "OperationsManifestError") {
      throw new Error("Expected incompatible alias error.");
    }
    expect(incompatibleError.issues).toContain(
      "incompatible metric alias targets metric payment.old",
    );

    const transitive = contract.replace(
      '"aliases":[]',
      '"aliases":[{"kind":"metric","from":"payment.old","to":"payment.latency"},{"kind":"metric","from":"payment.latency","to":"payment.count"}]',
    );
    const transitiveError = await Effect.runPromise(
      Effect.flip(
        validateOperationsManifest(
          await Effect.runPromise(parseOperationsManifest(validManifest)),
          await Effect.runPromise(parseOperationsContractIndex(transitive)),
        ),
      ),
    );
    if (transitiveError._tag !== "OperationsManifestError") {
      throw new Error("Expected transitive alias error.");
    }
    expect(transitiveError.issues).toContain(
      "incompatible metric alias targets metric payment.old",
    );

    const incompatibleEvents = contract
      .replace(
        '],"metrics"',
        ',{"name":"payment.completed","kind":"operation","attributes":["payment.region"],"attributeClassifications":[{"name":"payment.region","classification":"internal"}]}],"metrics"',
      )
      .replace(
        '"aliases":[]',
        '"aliases":[{"kind":"event","from":"payment.old","to":"payment.attempt"},{"kind":"event","from":"payment.old","to":"payment.completed"}]',
      );
    const incompatibleEventError = await Effect.runPromise(
      Effect.flip(
        validateOperationsManifest(
          await Effect.runPromise(parseOperationsManifest(validManifest)),
          await Effect.runPromise(parseOperationsContractIndex(incompatibleEvents)),
        ),
      ),
    );
    if (incompatibleEventError._tag !== "OperationsManifestError") {
      throw new Error("Expected incompatible event alias error.");
    }
    expect(incompatibleEventError.issues).toContain(
      "incompatible event alias targets event payment.old",
    );
  });
});
