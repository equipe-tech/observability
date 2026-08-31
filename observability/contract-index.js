import { Contract, defineTelemetryContract } from "../packages/telemetry/src/index.ts";
import { Effect } from "effect";

const contract = await Effect.runPromise(
  defineTelemetryContract({ version: 1, events: {}, metrics: {}, auditActions: {} }),
);
await Bun.write(
  new URL("contract.json", import.meta.url),
  Contract.encodeContractIndex(Contract.contractIndex(contract, "observability")),
);
