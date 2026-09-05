export type RequestReference = WeakKey;

export type ServerSpanCorrelation = {
  readonly traceId: string;
  readonly spanId: string;
};

export type RequestWideEventLogger = {
  readonly set: (correlation: ServerSpanCorrelation) => void;
  readonly error?: ((error: Error) => void) | undefined;
};

export type RequestWideEventLoggerResolver = (
  request: RequestReference,
) => RequestWideEventLogger | undefined;

export class RequestWideEventTraceCorrelation {
  readonly #resolveLogger: RequestWideEventLoggerResolver;

  constructor(resolveLogger: RequestWideEventLoggerResolver) {
    this.#resolveLogger = resolveLogger;
  }

  correlate(request: RequestReference, correlation: ServerSpanCorrelation): void {
    try {
      this.#resolveLogger(request)?.set(correlation);
    } catch {}
  }

  recordError(request: RequestReference, error: Error): void {
    try {
      this.#resolveLogger(request)?.error?.(error);
    } catch {}
  }
}

export const createRequestWideEventTraceCorrelation = (
  resolveLogger: RequestWideEventLoggerResolver,
): RequestWideEventTraceCorrelation => new RequestWideEventTraceCorrelation(resolveLogger);
