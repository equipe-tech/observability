import { Effect } from "effect";
import {
  defineConformanceEvidenceProvider,
  type ConformanceCheckId,
  ConformanceViolation,
  type ConformanceEvidenceProvider,
} from "@equipe-tech/observability/testing";
import {
  validateOperationsManifest,
  type OperationsContractIndex,
  type OperationsManifest,
} from "../OperationsManifest.ts";
import {
  findApplicationOtlpImports,
  type ApplicationBoundaryViolation,
} from "../SourceBoundary.ts";

export type ConformanceProvider<Id extends ConformanceCheckId> = ConformanceEvidenceProvider<Id>;

const violation = (
  message: string,
  offendingValue: string,
  cause?: unknown,
): ConformanceViolation =>
  new ConformanceViolation({ message, offendingValue, cause: cause ?? offendingValue });

export const operationsManifestConformance = (input: {
  readonly manifest: OperationsManifest;
  readonly contract: OperationsContractIndex;
}): readonly [
  ConformanceProvider<"manifest.valid">,
  ConformanceProvider<"queries.contract-derived">,
] => {
  const manifestProvider: ConformanceProvider<"manifest.valid"> = defineConformanceEvidenceProvider(
    {
      id: "manifest.valid",
      owner: "cli",
      verify: (target) =>
        Effect.gen(function* () {
          const validated = yield* validateOperationsManifest(input.manifest, input.contract).pipe(
            Effect.mapError((cause): ConformanceViolation =>
              cause._tag === "OperationsManifestError"
                ? violation(
                    `The operations manifest is invalid for profile ${target.profile.name}: ${cause.message}`,
                    cause.code,
                    cause,
                  )
                : violation(
                    `A managed query in the operations manifest is invalid: ${cause.message}`,
                    cause.code,
                    cause,
                  ),
            ),
          );
          return {
            owner: "cli",
            receiptType: "operations-manifest",
            receiptId: `${validated.manifest.service}@v${validated.manifest.contractVersion}`,
            summary: `manifest validated for environments ${validated.manifest.environments.join(", ")}`,
          } as const;
        }),
    },
  );
  const queriesProvider: ConformanceProvider<"queries.contract-derived"> =
    defineConformanceEvidenceProvider({
      id: "queries.contract-derived",
      owner: "cli",
      verify: (target) =>
        Effect.gen(function* () {
          const validated = yield* validateOperationsManifest(input.manifest, input.contract).pipe(
            Effect.mapError((cause): ConformanceViolation =>
              violation(
                `The managed queries do not derive from the contract for profile ${target.profile.name}: ${cause.message}`,
                cause.code,
                cause,
              ),
            ),
          );
          const queryCount =
            validated.dashboards.reduce((total, dashboard) => total + dashboard.panels.length, 0) +
            validated.monitors.length;
          return {
            owner: "cli",
            receiptType: "managed-queries",
            receiptId: `${validated.manifest.service}@v${validated.manifest.contractVersion}`,
            summary: `${queryCount} managed queries compiled against the contract index`,
          } as const;
        }),
    });
  return [manifestProvider, queriesProvider] as const;
};

export const packageBoundaryConformance = (input: {
  readonly projectRoot: string;
  readonly sourceRoots: ReadonlyArray<string>;
}): ConformanceProvider<"pipeline.no-application-otlp"> =>
  defineConformanceEvidenceProvider({
    id: "pipeline.no-application-otlp",
    owner: "cli",
    verify: () =>
      Effect.gen(function* () {
        const violations: ReadonlyArray<ApplicationBoundaryViolation> = yield* Effect.tryPromise(
          () => findApplicationOtlpImports(input.projectRoot, input.sourceRoots),
        ).pipe(
          Effect.mapError((cause) =>
            violation(
              "The application source boundary could not be scanned.",
              "source boundary scan",
              cause,
            ),
          ),
        );
        const first = violations[0];
        if (first !== undefined) {
          return yield* Effect.fail(
            violation(
              `The application owns a local OTLP pipeline: ${first.file} imports ${first.specifier}. Export through the Collector instead.`,
              `${first.file} imports ${first.specifier}`,
            ),
          );
        }
        return {
          owner: "cli",
          receiptType: "source-boundary",
          receiptId: input.projectRoot,
          summary: `no application-local OTLP pipeline in ${input.sourceRoots.join(", ")}`,
        } as const;
      }),
  });
