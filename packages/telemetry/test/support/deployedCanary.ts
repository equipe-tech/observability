import { deployedCanarySuiteTimeoutMilliseconds } from "../../src/testing/deployedCanary.ts";

export type DeployedCanaryQuery = "root" | "child" | "logs" | "metric";

export const deployedCanaryQueries: ReadonlyArray<DeployedCanaryQuery> = [
  "root",
  "child",
  "logs",
  "metric",
];

export type DeployedCanaryPollingBudget = {
  readonly attempts: number;
  readonly queriesPerAttempt: number;
  readonly sleepMilliseconds: number;
  readonly queryTimeoutMilliseconds: number;
  readonly suiteTimeoutMilliseconds: number;
  readonly ingestion: {
    readonly collectorFlushMilliseconds: number;
    readonly axiomQueryVisibilityMilliseconds: number;
  };
};

export const deployedCanaryPollingBudgetFor = (
  queries: ReadonlyArray<DeployedCanaryQuery>,
): DeployedCanaryPollingBudget => ({
  attempts: 13,
  queriesPerAttempt: queries.length,
  sleepMilliseconds: 16_000,
  queryTimeoutMilliseconds: 5_000,
  suiteTimeoutMilliseconds: deployedCanarySuiteTimeoutMilliseconds,
  ingestion: {
    collectorFlushMilliseconds: 200,
    axiomQueryVisibilityMilliseconds: 180_000,
  },
});

export const deployedCanaryPollingBudget = deployedCanaryPollingBudgetFor(deployedCanaryQueries);
