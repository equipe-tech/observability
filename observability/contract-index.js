import { Contract, defineTelemetryContract } from "../packages/telemetry/src/index.ts";
import { Effect } from "effect";

const contract = await Effect.runPromise(
  defineTelemetryContract({
    version: 1,
    events: {
      CliOperation: {
        name: "cli.operation",
        kind: "operation",
        defaultSeverity: "info",
        mandatory: true,
        sampling: { kind: "always" },
        attributes: {},
      },
    },
    metrics: {},
    auditActions: {},
  }),
);
const output = process.argv[2] ?? new URL("contract.json", import.meta.url);
await Bun.write(
  output,
  Contract.encodeContractIndex(
    Contract.contractIndex(contract, "observability", {
      version: 1,
      aliases: [
        {
          source: { kind: "event", name: "cli.command" },
          target: { kind: "event", name: "cli.operation" },
        },
      ],
    }),
  ),
);
