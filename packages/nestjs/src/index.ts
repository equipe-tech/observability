export {
  CurrentCorrelation,
  ObservabilityLifecycleError,
  TelemetryEventSink,
} from "@equipe-tech/observability";
export {
  InvalidNestErrorCatalog,
  InvalidNestErrorCatalogDeclaration,
  NestErrorBoundary,
  NestErrorBoundaryModule,
  NestErrorFilter,
  type ClassifiedError,
  type DefectEventInput,
  type ErrorCatalogDeclaration,
  type ErrorCatalogReference,
  type ExpectedError,
  type HttpOutcome,
  type NestErrorBoundaryOptions,
  type PublicErrorResponse,
  type SentryDefectsService,
  type UnexpectedDefect,
} from "./ErrorBoundary.ts";
export {
  BrowserEventsRejection,
  createBrowserEventsController,
  defaultBrowserEventsPath,
  type BrowserEventsControllerOptions,
} from "./BrowserEventsController.ts";
export {
  requestCorrelation,
  requestSpan,
  TelemetryInterceptor,
  TelemetryRequestTracker,
  withRequestCorrelation,
  withRequestSpan,
  type TelemetryInterceptorOptions,
} from "./TelemetryInterceptor.ts";
export {
  createRequestWideEventTraceCorrelation,
  RequestWideEventTraceCorrelation,
  type RequestReference,
  type RequestWideEventLogger,
  type RequestWideEventLoggerResolver,
  type ServerSpanCorrelation,
} from "./RequestWideEventTraceCorrelation.ts";
export type { ProxyPolicy, TelemetryRoutePolicyOptions } from "./HttpRoutePolicy.ts";
export {
  InvalidTelemetryModuleOptions,
  TelemetryModule,
  TelemetryShutdownError,
  TelemetryStartupError,
  type TelemetryModuleAsyncOptions,
  type TelemetryModuleOptions,
} from "./TelemetryModule.ts";
