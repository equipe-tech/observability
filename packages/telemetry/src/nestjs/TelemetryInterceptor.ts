import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { Context, Effect, Exit, Option, Schema } from "effect";
import type { Clock, ManagedRuntime, Tracer } from "effect";
import { Observable } from "rxjs";

const HttpRequestBoundary = Schema.Struct({
  method: Schema.NonEmptyString,
});

const decodeHttpRequestBoundary = Schema.decodeUnknownOption(HttpRequestBoundary);

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
    const method = decodeHttpRequestBoundary(request).pipe(
      Option.map((boundary) => boundary.method.toUpperCase()),
      Option.getOrElse(() => "UNKNOWN"),
    );
    const controller = context.getClass().name;
    const handler = context.getHandler().name;
    const span = tracer.span({
      name: `${method} ${controller}.${handler}`,
      parent: Option.none(),
      annotations: Context.empty(),
      links: [],
      startTime: clock.currentTimeNanosUnsafe(),
      kind: "server",
      root: true,
      sampled: true,
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
