import { Controller, HttpCode, HttpException, Post, Req } from "@nestjs/common";
import { Cause, Exit, Option, Schema } from "effect";
import type { ManagedRuntime } from "effect";
import {
  ingestBrowserEvents,
  InvalidBrowserEventBatch,
  type BrowserEventIngestReceipt,
} from "../node/BrowserEventIngest.ts";
import type { RequestReference } from "./RequestWideEventTraceCorrelation.ts";
import { requestSpan, withRequestSpan } from "./TelemetryInterceptor.ts";

export const defaultBrowserEventsPath = "_telemetry/events";

export class BrowserEventsRejection extends Schema.Class<BrowserEventsRejection>(
  "@equipe-tech/observability/BrowserEventsRejection",
)({
  code: Schema.Literal("OBS_BROWSER_EVENTS_INVALID_BATCH"),
  message: Schema.String,
  correlationId: Schema.String,
}) {}

class BrowserEventsWiringDefect extends Schema.TaggedError<BrowserEventsWiringDefect>()(
  "BrowserEventsWiringDefect",
  {
    code: Schema.Literal("OBS_BROWSER_EVENTS_WIRING_FAILED"),
    message: Schema.String,
  },
) {}

const RequestWithBody = Schema.Struct({ body: Schema.Unknown });

const decodeRequestWithBody = Schema.decodeUnknownOption(RequestWithBody);

const correlationId = (request: RequestReference): string =>
  requestSpan(request).pipe(
    Option.map((span) => span.traceId),
    Option.getOrElse(() => crypto.randomUUID()),
  );

export type BrowserEventsControllerOptions = {
  readonly path?: string;
};

export const createBrowserEventsController = <RuntimeError>(
  runtime: ManagedRuntime.ManagedRuntime<never, RuntimeError>,
  options?: BrowserEventsControllerOptions,
) => {
  class BrowserEventsController {
    async events(request: RequestReference): Promise<BrowserEventIngestReceipt> {
      const body = decodeRequestWithBody(request).pipe(
        Option.map((parsed) => parsed.body),
        Option.getOrUndefined,
      );
      const exit = await runtime.runPromiseExit(
        ingestBrowserEvents(body).pipe(withRequestSpan(request)),
      );
      if (Exit.isSuccess(exit)) {
        return exit.value;
      }
      const error = Cause.findErrorOption(exit.cause);
      if (Option.isSome(error) && error.value instanceof InvalidBrowserEventBatch) {
        throw new HttpException(
          new BrowserEventsRejection({
            code: error.value.code,
            message: error.value.message,
            correlationId: correlationId(request),
          }),
          400,
        );
      }
      throw Cause.squash(exit.cause);
    }
  }

  const prototype = BrowserEventsController.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "events");
  if (descriptor === undefined) {
    throw new BrowserEventsWiringDefect({
      code: "OBS_BROWSER_EVENTS_WIRING_FAILED",
      message: "The events handler is missing on the controller prototype.",
    });
  }
  Controller()(BrowserEventsController);
  Post(options?.path ?? defaultBrowserEventsPath)(prototype, "events", descriptor);
  HttpCode(202)(prototype, "events", descriptor);
  Req()(prototype, "events", 0);
  return BrowserEventsController;
};
