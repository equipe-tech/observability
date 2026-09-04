import { Effect } from "effect";
import {
  parseOperationsContractIndex,
  parseOperationsManifest,
  validateOperationsManifest,
} from "@equipe-tech/observability-cli";
import type { OperationsManifest, OperationsContractIndex } from "@equipe-tech/observability-cli";

export const operationsManifestYaml = `version: 1
contractVersion: 1
service: fixture-app
environments:
  - test
retention:
  - environment: test
    days: 30
dashboards:
  - id: operations
    title: Fixture operations
    panels:
      - id: runs
        title: Runs
        sources:
          - kind: event
            name: fixture.operation
        query: 'signal(logs) | where event.name == "fixture.operation" | summarize count()'
monitors: []
sentry:
  enabled: false
`;

export const contractIndexJson = `{
  "index": 1,
  "contractVersion": 1,
  "service": "fixture-app",
  "events": [
    {
      "name": "fixture.operation",
      "kind": "operation",
      "attributes": [],
      "attributeClassifications": []
    }
  ],
  "metrics": [],
  "aliases": []
}
`;

export const parseFixtureManifest = async (): Promise<{
  readonly manifest: OperationsManifest;
  readonly contract: OperationsContractIndex;
}> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const manifest = yield* parseOperationsManifest(operationsManifestYaml);
      const contract = yield* parseOperationsContractIndex(contractIndexJson);
      yield* validateOperationsManifest(manifest, contract);
      return { manifest, contract };
    }),
  );
