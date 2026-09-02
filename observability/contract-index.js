import { Contract, defineTelemetryContract } from "../packages/telemetry/src/index.ts";
import { Effect } from "effect";
import { encodeCompatibilityJson } from "../scripts/compatibility-json.ts";

const definition = Contract.telemetryContractDefinition({
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
});

const aliases = {
  version: 1,
  aliases: [
    {
      source: { kind: "event", name: "cli.command" },
      target: { kind: "event", name: "cli.operation" },
      since: "2026-08-31",
    },
  ],
};

export const observabilityContract = await Effect.runPromise(defineTelemetryContract(definition));

export const observabilityContractSurface = (retentionWindowDays) =>
  Contract.contractSurface({
    contract: observabilityContract,
    service: "observability",
    aliases,
    retentionWindowDays,
  });

if (import.meta.main) {
  if (process.argv[2] === "--surface") {
    const retentionWindowDays = Number(process.argv[3]);
    process.stdout.write(
      await encodeCompatibilityJson(observabilityContractSurface(retentionWindowDays)),
    );
  } else {
    const output = process.argv[2] ?? new URL("contract.json", import.meta.url);
    await Bun.write(
      output,
      await encodeCompatibilityJson(
        Contract.contractIndex(observabilityContract, "observability", aliases),
      ),
    );
  }
}
