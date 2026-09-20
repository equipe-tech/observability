export {
  CurrentCorrelation,
  ObservabilityLifecycleError,
  TelemetryEventSink,
  withBackgroundCorrelation,
  withCorrelation,
} from "@equipe-tech/observability";
export {
  effectEventsAdapter,
  effectEventsAdapterName,
  layerWideEvent,
  WideEvent,
  type EffectEventsAdapter,
} from "@equipe-tech/observability/effect";
export { NodeObservabilityService } from "@equipe-tech/observability/node";
export {
  browserEventsHandler,
  BrowserEventsRejection,
  defaultBrowserEventsPath,
  InvalidBrowserEventsPath,
  layerBrowserEventsRoute,
  type BrowserEventsRouteOptions,
} from "./BrowserEventsRoute.ts";
export {
  classifyError,
  errorBoundary,
  publicErrorResponse,
  unexpectedDefectCode,
  type ClassifiedError,
  type DefectCaptureInput,
  type DefectEventInput,
  type ErrorBoundaryMiddleware,
  type ErrorBoundaryOptions,
  type ExpectedError,
  type HttpOutcome,
  type PublicErrorResponse,
  type UnexpectedDefect,
} from "./ErrorBoundary.ts";
export {
  defineErrorCatalog,
  ErrorCatalog,
  InvalidErrorCatalog,
  type ErrorCatalogEntries,
  type ErrorCatalogEntry,
  type ErrorCatalogEntryInput,
  type ErrorCatalogInput,
} from "./ErrorCatalog.ts";
export {
  inspectHttpServerRequest,
  InvalidTelemetryRoutePolicy,
  telemetryRoutePolicy,
  type HttpServerRequestDetails,
  type ProxyPolicy,
  type TelemetryRoutePolicy,
  type TelemetryRoutePolicyOptions,
} from "./HttpRoutePolicy.ts";
export {
  httpTelemetry,
  layerBuiltInTracerDisabled,
  type HttpTelemetryMiddleware,
  type HttpTelemetryOptions,
} from "./HttpTelemetry.ts";
export {
  layerObservability,
  layerObservabilityFromConfig,
  type ObservabilityError,
  type ObservabilityServices,
} from "./Observability.ts";
