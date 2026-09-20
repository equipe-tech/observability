import { Effect, Layer } from "effect";
import {
  type AdapterRegistration,
  type AuditPublisher,
  type DuplicateReleaseVariable,
  type InvalidObservabilityConfig,
  type NodeObservabilityConfig,
  type TelemetryEventSink,
} from "@equipe-tech/observability";
import {
  layerNodeObservability,
  makeNodeObservability,
  NodeObservabilityService,
  type CreateNodeObservabilityInput,
  type NodeObservability,
  type NodeObservabilityEnabled,
  type ObservabilityLifecycleError,
} from "@equipe-tech/observability/node";
import { layerBuiltInTracerDisabled } from "./HttpTelemetry.ts";

export type ObservabilityServices = NodeObservabilityService | TelemetryEventSink | AuditPublisher;

export type ObservabilityError =
  | InvalidObservabilityConfig
  | DuplicateReleaseVariable
  | ObservabilityLifecycleError;

const runtimeContext = (
  handle: NodeObservabilityEnabled,
): Layer.Layer<never, InvalidObservabilityConfig> =>
  Layer.effectContext<never, InvalidObservabilityConfig, never>(handle.runtime.contextEffect);

const bridge = (
  handle: NodeObservability,
): Layer.Layer<TelemetryEventSink | AuditPublisher, InvalidObservabilityConfig> =>
  handle.enabled
    ? Layer.mergeAll(
        handle.eventLayer,
        handle.auditLayer,
        runtimeContext(handle),
        layerBuiltInTracerDisabled,
      )
    : Layer.mergeAll(handle.eventLayer, handle.auditLayer, layerBuiltInTracerDisabled);

const bridgeService: Layer.Layer<
  TelemetryEventSink | AuditPublisher,
  InvalidObservabilityConfig,
  NodeObservabilityService
> = Layer.unwrap(Effect.map(NodeObservabilityService, bridge));

export const layerObservability = (
  input: CreateNodeObservabilityInput,
): Layer.Layer<ObservabilityServices, ObservabilityError> =>
  bridgeService.pipe(Layer.provideMerge(layerNodeObservability(input)));

export const layerObservabilityFromConfig = (
  config: NodeObservabilityConfig,
  registrations: ReadonlyArray<AdapterRegistration>,
): Layer.Layer<ObservabilityServices, ObservabilityError> =>
  bridgeService.pipe(
    Layer.provideMerge(
      Layer.effect(
        NodeObservabilityService,
        Effect.acquireRelease(makeNodeObservability(config, registrations), (handle) =>
          Effect.promise(() => handle.close()).pipe(Effect.asVoid),
        ),
      ),
    ),
  );
