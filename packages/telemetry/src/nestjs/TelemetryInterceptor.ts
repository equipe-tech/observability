import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Context, Effect, Exit, Option, Predicate, Schema, Tracer } from "effect";
import type { Clock, ManagedRuntime } from "effect";
import { EventEmitter } from "node:events";
import { Observable } from "rxjs";
import {
  telemetryRoutePolicy,
  type ProxyPolicy,
  type TelemetryRoutePolicy,
} from "./HttpRoutePolicy.ts";
import type {
  RequestReference,
  RequestWideEventTraceCorrelation,
} from "./RequestWideEventTraceCorrelation.ts";

const TraceparentRequest = Schema.Struct({
  headers: Schema.Struct({
    traceparent: Schema.String.check(
      Schema.isPattern(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/),
      Schema.makeFilter(
        (traceparent) =>
          traceparent.slice(3, 35) !== "00000000000000000000000000000000" &&
          traceparent.slice(36, 52) !== "0000000000000000",
      ),
    ),
  }),
});

const parseTraceparentRequest = Schema.decodeUnknownOption(TraceparentRequest);

const HttpResponseBoundary = Schema.Struct({
  statusCode: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 100, maximum: 599 })),
});

const decodeHttpResponseBoundary = Schema.decodeUnknownOption(HttpResponseBoundary);

const HttpErrorBoundary = Schema.Struct({
  status: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 100, maximum: 599 }),
  ).pipe(Schema.optionalKey),
});
const ErrorType = Schema.NonEmptyString.check(Schema.isMaxLength(128));

const decodeHttpErrorBoundary = Schema.decodeUnknownOption(HttpErrorBoundary);
const decodeErrorType = Schema.decodeUnknownOption(ErrorType);
const decodeHeadersSent = Schema.decodeUnknownOption(Schema.Boolean);
const decodeResponseEmitter = Schema.decodeUnknownOption(Schema.instanceOf(EventEmitter));

const requestSpans = new WeakMap<RequestReference, Tracer.Span>();

export const requestSpan = (request: RequestReference): Option.Option<Tracer.Span> =>
  Option.fromNullishOr(requestSpans.get(request));

export const withRequestSpan =
  (request: RequestReference) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Option.match(requestSpan(request), {
      onNone: () => effect,
      onSome: (span) => Effect.withParentSpan(effect, span),
    });

type ActiveRequest = {
  readonly interrupt: () => void;
};

export class TelemetryRequestTracker {
  #accepting = true;
  readonly #active = new Set<ActiveRequest>();
  readonly #idleWaiters = new Set<() => void>();

  get accepting(): boolean {
    return this.#accepting;
  }

  register(activeRequest: ActiveRequest): Option.Option<() => void> {
    if (!this.#accepting) {
      return Option.none();
    }
    this.#active.add(activeRequest);
    return Option.some(() => {
      if (!this.#active.delete(activeRequest) || this.#active.size !== 0) {
        return;
      }
      for (const resolve of this.#idleWaiters) {
        resolve();
      }
      this.#idleWaiters.clear();
    });
  }

  closeAdmission(): void {
    this.#accepting = false;
  }

  waitForIdle(): Promise<void> {
    if (this.#active.size === 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  interruptActive(): void {
    for (const activeRequest of this.#active) {
      activeRequest.interrupt();
    }
  }
}

export type TelemetryInterceptorOptions = {
  readonly healthRouteTemplates?: ReadonlyArray<string> | undefined;
  readonly proxyPolicy?: ProxyPolicy | undefined;
  readonly requestTracker?: TelemetryRequestTracker | undefined;
  readonly requestWideEventTraceCorrelation?: RequestWideEventTraceCorrelation | undefined;
};

export class TelemetryInterceptor<RuntimeError> implements NestInterceptor {
  readonly #runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>;
  readonly #routePolicy: TelemetryRoutePolicy;
  readonly #requestTracker: TelemetryRequestTracker;
  readonly #requestWideEventTraceCorrelation: RequestWideEventTraceCorrelation | undefined;
  #tracer: Tracer.Tracer | undefined;
  #clock: Clock.Clock | undefined;

  constructor(
    runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>,
    options: TelemetryInterceptorOptions = {},
  ) {
    this.#runtime = runtime;
    this.#routePolicy = telemetryRoutePolicy({
      healthRouteTemplates: options.healthRouteTemplates,
      proxyPolicy: options.proxyPolicy,
    });
    this.#requestTracker = options.requestTracker ?? new TelemetryRequestTracker();
    this.#requestWideEventTraceCorrelation = options.requestWideEventTraceCorrelation;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http" || !this.#requestTracker.accepting) {
      return next.handle();
    }
    try {
      return this.#instrument(context, next);
    } catch {
      return next.handle();
    }
  }

  #instrument(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<RequestReference>();
    if (requestSpans.has(request)) {
      return next.handle();
    }
    const requestDetails = this.#routePolicy.inspect(request);
    if (Option.isNone(requestDetails)) {
      return next.handle();
    }
    const tracer = (this.#tracer ??= this.#runtime.runSync(Effect.tracer));
    const clock = (this.#clock ??= this.#runtime.runSync(Effect.clockWith(Effect.succeed)));
    const traceparentRequest = httpContext.getRequest<typeof TraceparentRequest.Encoded>();
    const parent = parseTraceparentRequest({ headers: traceparentRequest.headers }).pipe(
      Option.map(({ headers }) => {
        const traceparent = headers.traceparent;
        return Tracer.externalSpan({
          traceId: traceparent.slice(3, 35),
          spanId: traceparent.slice(36, 52),
          sampled: Number.parseInt(traceparent.slice(53, 55), 16) % 2 === 1,
        });
      }),
    );
    const details = requestDetails.value;
    const span = tracer.span({
      name: details.spanName,
      parent,
      annotations: Context.empty(),
      links: [],
      startTime: clock.currentTimeNanosUnsafe(),
      kind: "server",
      root: Option.isNone(parent),
      sampled: Option.match(parent, {
        onNone: () => true,
        onSome: (remoteParent) => remoteParent.sampled,
      }),
    });
    span.attribute("http.request.method", details.method);
    if (Option.isSome(details.methodOriginal)) {
      span.attribute("http.request.method_original", details.methodOriginal.value);
    }
    if (Option.isSome(details.route)) {
      span.attribute("http.route", details.route.value);
    }
    if (Option.isSome(details.urlPath)) {
      span.attribute("url.path", details.urlPath.value);
    }
    if (Option.isSome(details.urlScheme)) {
      span.attribute("url.scheme", details.urlScheme.value);
    }
    if (Option.isSome(details.clientAddress)) {
      span.attribute("client.address", details.clientAddress.value);
    }
    if (Option.isSome(details.networkPeerAddress)) {
      span.attribute("network.peer.address", details.networkPeerAddress.value);
    }
    if (Option.isSome(details.networkPeerPort)) {
      span.attribute("network.peer.port", details.networkPeerPort.value);
    }
    if (Option.isSome(details.serverAddress)) {
      span.attribute("server.address", details.serverAddress.value);
    }
    requestSpans.set(request, span);
    this.#requestWideEventTraceCorrelation?.correlate(request, {
      traceId: span.traceId,
      spanId: span.spanId,
    });
    const response = httpContext.getResponse<RequestReference>();
    const responseEmitter = decodeResponseEmitter(response);

    return new Observable((subscriber) => {
      let ended = false;
      let responseFinished = false;
      let observableSettled = false;
      let pendingExit: Exit.Exit<unknown, unknown> = Exit.succeed(undefined);
      let pendingErrorType = Option.none<string>();
      let release = (): void => {};

      const responseStatus = (requireSent = false): Option.Option<number> => {
        if (requireSent) {
          const headersSent = Predicate.hasProperty(response, "headersSent")
            ? decodeHeadersSent(response.headersSent)
            : Option.none<boolean>();
          if (!Option.getOrElse(headersSent, () => false)) {
            return Option.none();
          }
        }
        return decodeHttpResponseBoundary(response).pipe(
          Option.map((boundary) => boundary.statusCode),
        );
      };

      const removeResponseListeners = (): void => {
        if (Option.isSome(responseEmitter)) {
          responseEmitter.value.off("finish", onResponseFinish);
          responseEmitter.value.off("close", onResponseClose);
        }
      };

      const finish = (
        exit: Exit.Exit<unknown, unknown>,
        status: Option.Option<number>,
        errorType: Option.Option<string>,
      ): void => {
        if (ended) {
          return;
        }
        ended = true;
        removeResponseListeners();
        if (Option.isSome(status)) {
          span.attribute("http.response.status_code", status.value);
        }
        const finalErrorType = Option.contains(errorType, "connection_closed")
          ? errorType
          : Option.match(status, {
              onNone: () => errorType,
              onSome: (statusCode) => {
                if (statusCode >= 500) {
                  return Option.some(String(statusCode));
                }
                if (statusCode >= 400) {
                  return Option.none<string>();
                }
                return errorType;
              },
            });
        if (Option.isSome(finalErrorType)) {
          span.attribute("error.type", finalErrorType.value);
        }
        requestSpans.delete(request);
        release();
        span.end(clock.currentTimeNanosUnsafe(), exit);
      };

      const onResponseFinish = (): void => {
        responseFinished = true;
        finish(pendingExit, responseStatus(), pendingErrorType);
      };

      const onResponseClose = (): void => {
        if (!responseFinished) {
          finish(Exit.interrupt(), responseStatus(true), Option.some("connection_closed"));
        }
      };

      const registered = this.#requestTracker.register({
        interrupt: () => finish(Exit.interrupt(), responseStatus(true), Option.none()),
      });
      if (Option.isNone(registered)) {
        requestSpans.delete(request);
        span.end(clock.currentTimeNanosUnsafe(), Exit.interrupt());
        return next.handle().subscribe(subscriber);
      }
      release = registered.value;

      if (Option.isSome(responseEmitter)) {
        responseEmitter.value.on("finish", onResponseFinish);
        responseEmitter.value.on("close", onResponseClose);
      }

      const subscription = next.handle().subscribe({
        next: (value) => subscriber.next(value),
        error: (cause: unknown) => {
          observableSettled = true;
          const errorBoundary = decodeHttpErrorBoundary(cause);
          pendingExit = Exit.die(cause);
          pendingErrorType = Predicate.hasProperty(cause, "name")
            ? decodeErrorType(cause.name).pipe(Option.orElse(() => Option.some("exception")))
            : Option.some("exception");
          if (Option.isNone(responseEmitter)) {
            const status = errorBoundary.pipe(
              Option.flatMap((boundary) => Option.fromNullishOr(boundary.status)),
            );
            finish(pendingExit, status, pendingErrorType);
          }
          subscriber.error(cause);
        },
        complete: () => {
          observableSettled = true;
          if (Option.isNone(responseEmitter)) {
            finish(Exit.succeed(undefined), responseStatus(), Option.none());
          }
          subscriber.complete();
        },
      });
      return () => {
        if (!observableSettled && Option.isNone(responseEmitter)) {
          finish(Exit.interrupt(), responseStatus(), Option.none());
        }
        subscription.unsubscribe();
      };
    });
  }
}
