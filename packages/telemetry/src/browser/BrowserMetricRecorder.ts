import { Context, Effect, Layer } from "effect";
import type { BrowserMetricPoint } from "../BrowserEvents.ts";
import { InvalidMetricMeasurement } from "../contract/MetricContractError.ts";
import { prepareContractCounterBatchByName } from "../contract/MetricProducer.ts";
import { LayerMetricsRuntime, releaseMetricsLease } from "../MetricsRuntime.ts";
import type { ContractRegistry } from "../profile/ObservabilityAdapter.ts";

export type BrowserMetricBatchAdmission = { readonly commit: () => void };

export class BrowserMetricRecorder extends Context.Service<
  BrowserMetricRecorder,
  {
    readonly admit: (metrics: ReadonlyArray<BrowserMetricPoint>) => BrowserMetricBatchAdmission;
  }
>()("@equipe-tech/observability/node/BrowserMetricRecorder") {}

export const unavailableBrowserMetricRecorder = BrowserMetricRecorder.of({
  admit: () => {
    throw new InvalidMetricMeasurement({
      code: "OBS_METRIC_UNKNOWN_ALIAS",
      operation: "counter",
      message:
        "Browser metric admission requires a compiled telemetry contract. Configure the owning contract before sending metrics.",
      metricAlias: "browser",
    });
  },
});

export const layerBrowserMetricRecorder = (contract: ContractRegistry | undefined) => {
  if (contract === undefined)
    return Layer.succeed(BrowserMetricRecorder, unavailableBrowserMetricRecorder);
  return Layer.effect(
    BrowserMetricRecorder,
    Effect.acquireRelease(
      Effect.map(LayerMetricsRuntime, (runtime) => {
        const metrics = runtime.acquireMetrics();
        return {
          service: BrowserMetricRecorder.of({
            admit: (points) => ({
              commit: prepareContractCounterBatchByName(
                contract,
                metrics,
                points.map((point) => ({
                  name: point.name,
                  value: point.value,
                  attributes: point.fields,
                })),
              ),
            }),
          }),
          metrics,
        };
      }),
      ({ metrics }) => Effect.promise(() => releaseMetricsLease(metrics)).pipe(Effect.asVoid),
    ).pipe(Effect.map(({ service }) => service)),
  );
};
