import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Context, Effect, Exit, Option, Schema, Tracer } from "effect";
import type { Clock, ManagedRuntime } from "effect";
import { Observable } from "rxjs";

const HttpRequestBoundary = Schema.Struct({
  method: Schema.NonEmptyString,
});

const decodeHttpRequestBoundary = Schema.decodeUnknownOption(HttpRequestBoundary);

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
  statusCode: Schema.Number.check(Schema.isInt()),
});

const decodeHttpResponseBoundary = Schema.decodeUnknownOption(HttpResponseBoundary);

const ClientErrorBoundary = Schema.Struct({
  status: Schema.Number.check(
    Schema.isInt(),
    Schema.makeFilter((status) => status >= 400 && status <= 499, {
      expected: "an HTTP client error status",
    }),
  ),
});

const decodeClientErrorBoundary = Schema.decodeUnknownOption(ClientErrorBoundary);

export type RequestReference = WeakKey;

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

export class TelemetryInterceptor<RuntimeError> implements NestInterceptor {
  readonly #runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>;
  #tracer: Tracer.Tracer | undefined;
  #clock: Clock.Clock | undefined;

  constructor(runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>) {
    this.#runtime = runtime;
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== "http") {
      return next.handle();
    }
    try {
      return this.#instrument(context, next);
    } catch {
      return next.handle();
    }
  }

  #instrument(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const tracer = (this.#tracer ??= this.#runtime.runSync(Effect.tracer));
    const clock = (this.#clock ??= this.#runtime.runSync(Effect.clockWith(Effect.succeed)));
    const httpContext = context.switchToHttp();
    const request = httpContext.getRequest<RequestReference>();
    const traceparentRequest = httpContext.getRequest<typeof TraceparentRequest.Encoded>();
    const method = decodeHttpRequestBoundary(request).pipe(
      Option.map((boundary) => boundary.method.toUpperCase()),
      Option.getOrElse(() => "UNKNOWN"),
    );
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
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
    const span = tracer.span({
      name: `${method} ${controller}.${handler}`,
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
    span.attribute("http.request.method", method);
    span.attribute("nestjs.controller", controller);
    span.attribute("nestjs.handler", handler);
    requestSpans.set(request, span);

    return new Observable((subscriber) => {
      let settled = false;
      const finish = (
        exit: Exit.Exit<unknown, unknown>,
        statusOverride: Option.Option<number>,
      ): void => {
        if (settled) {
          return;
        }
        settled = true;
        const status = statusOverride.pipe(
          Option.orElse(() =>
            decodeHttpResponseBoundary(httpContext.getResponse<RequestReference>()).pipe(
              Option.map((boundary) => boundary.statusCode),
            ),
          ),
        );
        if (Option.isSome(status)) {
          span.attribute("http.response.status_code", status.value);
        }
        span.end(clock.currentTimeNanosUnsafe(), exit);
      };
      const subscription = next.handle().subscribe({
        next: (value) => subscriber.next(value),
        error: (cause: unknown) => {
          const clientError = decodeClientErrorBoundary(cause);
          if (Option.isSome(clientError)) {
            finish(Exit.succeed(undefined), Option.some(clientError.value.status));
          } else {
            finish(Exit.die(cause), Option.none());
          }
          subscriber.error(cause);
        },
        complete: () => {
          finish(Exit.succeed(undefined), Option.none());
          subscriber.complete();
        },
      });
      return () => {
        if (!settled) {
          span.attribute("http.request.cancelled", true);
          finish(Exit.interrupt(), Option.none());
        }
        subscription.unsubscribe();
      };
    });
  }
}
