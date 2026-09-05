import { Effect } from "effect";
import {
  parseOperationsContractIndex,
  parseOperationsManifest,
  validateOperationsManifest,
} from "@equipe-tech/observability-cli";
import type { OperationsManifest, OperationsContractIndex } from "@equipe-tech/observability-cli";
import type { ConformanceTargetBinding } from "@equipe-tech/observability/testing";
import { fixtureError } from "./FixtureError.ts";

export const parseFixtureManifest = async (
  binding: ConformanceTargetBinding,
): Promise<{
  readonly manifest: OperationsManifest;
  readonly contract: OperationsContractIndex;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const event = binding.contract.events[0];
      const metric = binding.contract.metrics[0];
      const signal = event === undefined ? metric : event;
      if (signal === undefined)
        throw fixtureError("A fixture manifest requires a contract signal.");
      const kind = event === undefined ? "metric" : "event";
      const querySignal = event === undefined ? "metrics" : "logs";
      const queryField = event === undefined ? "metric.name" : "event.name";
      const manifest = yield* parseOperationsManifest(`version: 1
contractVersion: ${binding.contract.contractVersion}
service: ${binding.identity.serviceName}
environments:
  - ${binding.identity.environment}
retention:
  - environment: ${binding.identity.environment}
    days: 30
dashboards:
  - id: operations
    title: Fixture operations
    panels:
      - id: runs
        title: Runs
        sources:
          - kind: ${kind}
            name: ${signal.name}
        query: 'signal(${querySignal}) | where ${queryField} == "${signal.name}" | summarize count()'
monitors: []
sentry:
  enabled: false
`);
      const contract = yield* parseOperationsContractIndex(JSON.stringify(binding.contract));
      yield* validateOperationsManifest(manifest, contract);
      return { manifest, contract };
    }),
  );
