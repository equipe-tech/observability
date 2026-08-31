import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { fileURLToPath } from "node:url";
import { ManagedQueryError } from "../src/ManagedQuery.ts";
import { OperationsManifestError } from "../src/OperationsManifest.ts";
import { OperationsError } from "../src/OperationsPlan.ts";
import { OperationsStateError } from "../src/OperationsState.ts";
import { RemoteApiError } from "../src/ProviderApis.ts";

const manifestCodes = [
  "OBS_CLI_MANIFEST_NOT_FOUND",
  "OBS_CLI_MANIFEST_UNREADABLE",
  "OBS_CLI_MANIFEST_VERSION_UNSUPPORTED",
  "OBS_CLI_MANIFEST_INVALID",
  "OBS_CLI_CONTRACT_INDEX_NOT_FOUND",
  "OBS_CLI_CONTRACT_INDEX_INVALID",
  "OBS_CLI_CONTRACT_INDEX_STALE",
  "OBS_CLI_SOURCE_INVALID",
];
const queryCodes = [
  "OBS_CLI_QUERY_INVALID",
  "OBS_CLI_QUERY_SIGNAL_UNBOUND",
  "OBS_CLI_QUERY_SIGNAL_AMBIGUOUS",
  "OBS_CLI_QUERY_SIGNAL_MISMATCH",
];
const operationCodes = [
  "OBS_CLI_PLAN_REQUIRED",
  "OBS_CLI_PLAN_INVALID",
  "OBS_CLI_PLAN_STALE",
  "OBS_CLI_PLAN_DESTRUCTIVE",
  "OBS_CLI_PROVIDER_CAPABILITY_UNAVAILABLE",
  "OBS_CLI_READ_BACK_TIMEOUT",
  "OBS_CLI_MANUAL_ACTION_PENDING",
  "OBS_CLI_DRIFT_DETECTED",
  "OBS_CLI_APPLY_OUTCOME_UNKNOWN",
  "OBS_CLI_MUTATION_UNRESOLVED",
];
const stateCodes = [
  "OBS_CLI_OPERATIONS_STATE_INVALID",
  "OBS_CLI_OPERATIONS_STATE_FAILED",
  "OBS_CLI_OPERATIONS_STATE_BUSY",
];
const providerCodes = [
  "OBS_CLI_REMOTE_UNAUTHORIZED",
  "OBS_CLI_REMOTE_FAILED",
  "OBS_CLI_REMOTE_INVALID_RESPONSE",
  "OBS_CLI_AXIOM_DATASET_CONFLICT",
  "OBS_CLI_AXIOM_DATASET_OUTCOME_UNKNOWN",
];

const publicCodes = [
  ...manifestCodes,
  ...queryCodes,
  ...operationCodes,
  ...stateCodes,
  ...providerCodes,
];

describe("operations public error codes", () => {
  test("decodes every declared file, contract, query, plan, state and provider code", () => {
    for (const code of manifestCodes) {
      expect(code).toBe(
        Schema.decodeUnknownSync(OperationsManifestError)({
          _tag: "OperationsManifestError",
          code,
          message: code,
          issues: [],
          cause: code,
        }).code,
      );
    }
    for (const code of queryCodes) {
      expect(code).toBe(
        Schema.decodeUnknownSync(ManagedQueryError)({
          _tag: "ManagedQueryError",
          code,
          message: code,
          cause: code,
        }).code,
      );
    }
    for (const code of operationCodes) {
      expect(code).toBe(
        Schema.decodeUnknownSync(OperationsError)({
          _tag: "OperationsError",
          code,
          message: code,
          cause: code,
        }).code,
      );
    }
    for (const code of stateCodes) {
      expect(code).toBe(
        Schema.decodeUnknownSync(OperationsStateError)({
          _tag: "OperationsStateError",
          code,
          message: code,
          cause: code,
        }).code,
      );
    }
    for (const code of providerCodes) {
      expect(code).toBe(
        Schema.decodeUnknownSync(RemoteApiError)({
          _tag: "RemoteApiError",
          code,
          message: code,
          provider: "Axiom",
          status: 0,
          cause: code,
        }).code,
      );
    }
  });

  test("documents every public operations error code", async () => {
    const reference = await Bun.file(
      fileURLToPath(new URL("../../../docs/cli-reference.md", import.meta.url)),
    ).text();
    for (const code of publicCodes) {
      expect(reference).toContain(`\`${code}\``);
    }
  });
});
