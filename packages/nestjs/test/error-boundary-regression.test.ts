import "reflect-metadata";
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  Module,
  NotFoundException,
  Param,
  ParseIntPipe,
  Res,
  ServiceUnavailableException,
  UseGuards,
} from "@nestjs/common";
import type { CanActivate } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Schema } from "effect";
import { Contract, CorrelationContext, type DefectEnvelope } from "@equipe-tech/observability";
import { defineErrorCatalog, type DrainContext } from "evlog";
import { EvlogModule } from "evlog/nestjs";
import { assert, describe, it } from "vite-plus/test";
import {
  createRequestWideEventTraceCorrelation,
  InvalidNestErrorCatalogDeclaration,
  NestErrorBoundary,
  NestErrorBoundaryModule,
  type DefectEventInput,
  type ErrorCatalogReference,
} from "../src/index.ts";

const AddressBoundary = Schema.Struct({ port: Schema.Number });
const decodeAddress = Schema.decodeUnknownSync(AddressBoundary);
const applicationBaseUrl = (address: string | AddressInfo | null): string =>
  `http://127.0.0.1:${decodeAddress(address).port}`;

const methodDescriptor = <Prototype extends WeakKey>(
  prototype: Prototype,
  method: string,
): PropertyDescriptor => {
  const descriptor = Object.getOwnPropertyDescriptor(prototype, method);
  if (descriptor === undefined) {
    throw new Error(`The method ${method} does not exist on the controller.`);
  }
  return descriptor;
};

const waitFor = async (predicate: () => boolean): Promise<void> => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("The expected sink calls did not settle.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

interface StreamingResponse {
  write(chunk: string): boolean;
}

describe("Nest error boundary regressions", () => {
  it("probe A and L preserve Nest HttpException responses without defect capture", async () => {
    const defects: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];

    class ProbeController {
      missing(): never {
        throw new NotFoundException("no such widget");
      }

      unavailable(): never {
        throw new ServiceUnavailableException("planned maintenance");
      }

      caused(): never {
        throw new HttpException("wrapped failure", 502, { cause: new Error("database offline") });
      }
    }
    Controller("http-outcomes")(ProbeController);
    for (const method of ["missing", "unavailable", "caused"] as const) {
      Get(method)(
        ProbeController.prototype,
        method,
        methodDescriptor(ProbeController.prototype, method),
      );
    }

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("http_outcomes", {
            MISSING: { status: 404, message: "Missing." },
          }),
          recordDefect: (event) => {
            defects.push(event);
          },
          sentryDefects: {
            capture: (input) =>
              Effect.sync(() => {
                captures.push(input.envelope);
                return { kind: "queued" };
              }),
          },
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      const missing = await fetch(`${baseUrl}/http-outcomes/missing`);
      assert.strictEqual(missing.status, 404);
      assert.deepStrictEqual(await missing.json(), {
        message: "no such widget",
        error: "Not Found",
        statusCode: 404,
      });

      const unavailable = await fetch(`${baseUrl}/http-outcomes/unavailable`);
      assert.strictEqual(unavailable.status, 503);
      assert.deepStrictEqual(await unavailable.json(), {
        message: "planned maintenance",
        error: "Service Unavailable",
        statusCode: 503,
      });

      const unmatched = await fetch(`${baseUrl}/no/such/route`);
      assert.strictEqual(unmatched.status, 404);
      assert.deepStrictEqual(await unmatched.json(), {
        message: "Cannot GET /no/such/route",
        error: "Not Found",
        statusCode: 404,
      });

      const caused = await fetch(`${baseUrl}/http-outcomes/caused`);
      assert.strictEqual(caused.status, 500);
      assert.strictEqual(defects.length, 1);
      assert.strictEqual(captures.length, 1);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe B preserves non-Error throwable causes", async () => {
    const causes: Array<unknown> = [];
    const correlation = createRequestWideEventTraceCorrelation(() => ({
      set: () => undefined,
      error: (error) => {
        causes.push(error.cause);
      },
    }));

    class ProbeController {
      stringThrow(): never {
        throw "a plain string failure";
      }

      objectThrow(): never {
        throw { code: "OBJECT_FAILURE", message: "object literal failure" };
      }
    }
    Controller("non-errors")(ProbeController);
    for (const method of ["stringThrow", "objectThrow"] as const) {
      Get(method)(
        ProbeController.prototype,
        method,
        methodDescriptor(ProbeController.prototype, method),
      );
    }

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("non_errors", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: () => undefined,
          requestWideEventTraceCorrelation: correlation,
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      assert.strictEqual((await fetch(`${baseUrl}/non-errors/stringThrow`)).status, 500);
      assert.strictEqual((await fetch(`${baseUrl}/non-errors/objectThrow`)).status, 500);
      assert.strictEqual(causes[0], "a plain string failure");
      assert.deepStrictEqual(causes[1], {
        code: "OBJECT_FAILURE",
        message: "object literal failure",
      });
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe C records a shared Error once for every request", async () => {
    const defects: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];
    const shared = new Error("connection pool exhausted");

    class ProbeController {
      fail(): never {
        throw shared;
      }
    }
    Controller("shared-error")(ProbeController);
    Get("fail")(
      ProbeController.prototype,
      "fail",
      methodDescriptor(ProbeController.prototype, "fail"),
    );

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("shared_error", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: (event) => {
            defects.push(event);
          },
          sentryDefects: {
            capture: (input) =>
              Effect.sync(() => {
                captures.push(input.envelope);
                return { kind: "queued" };
              }),
          },
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        assert.strictEqual((await fetch(`${baseUrl}/shared-error/fail`)).status, 500);
      }
      await waitFor(() => defects.length === 5 && captures.length === 5);
      assert.lengthOf(defects, 5);
      assert.lengthOf(captures, 5);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe E writes the response before slow sinks settle", async () => {
    let settled = false;

    class ProbeController {
      fail(): never {
        throw new Error("slow sink failure");
      }
    }
    Controller("slow-sink")(ProbeController);
    Get("fail")(
      ProbeController.prototype,
      "fail",
      methodDescriptor(ProbeController.prototype, "fail"),
    );

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("slow_sink", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: () =>
            new Promise<void>((resolve) =>
              setTimeout(() => {
                settled = true;
                resolve();
              }, 1_000),
            ),
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      const startedAt = Date.now();
      const response = await fetch(`${baseUrl}/slow-sink/fail`);
      assert.strictEqual(response.status, 500);
      assert.isBelow(Date.now() - startedAt, 500);
      assert.isFalse(settled);
      await waitFor(() => settled);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe J contains synchronously throwing and rejecting sinks", async () => {
    const captures: Array<DefectEnvelope> = [];

    class ProbeController {
      throwing(): never {
        throw new Error("throwing sink request");
      }

      rejecting(): never {
        throw new Error("rejecting sink request");
      }
    }
    Controller("broken-sinks")(ProbeController);
    for (const method of ["throwing", "rejecting"] as const) {
      Get(method)(
        ProbeController.prototype,
        method,
        methodDescriptor(ProbeController.prototype, method),
      );
    }

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("broken_sinks", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: (event) => {
            if (event.error.message === "throwing sink request") {
              throw new Error("the defect sink threw");
            }
            return Promise.reject(new Error("the defect sink rejected"));
          },
          sentryDefects: {
            capture: (input) =>
              Effect.sync(() => {
                captures.push(input.envelope);
                return { kind: "queued" };
              }),
          },
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      assert.strictEqual((await fetch(`${baseUrl}/broken-sinks/throwing`)).status, 500);
      assert.strictEqual((await fetch(`${baseUrl}/broken-sinks/rejecting`)).status, 500);
      await waitFor(() => captures.length === 2);
      assert.lengthOf(captures, 2);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("contains synchronously throwing and rejecting capture sinks", async () => {
    class ProbeController {
      throwing(): never {
        throw new Error("throwing capture request");
      }

      rejecting(): never {
        throw new Error("rejecting capture request");
      }
    }
    Controller("broken-captures")(ProbeController);
    for (const method of ["throwing", "rejecting"] as const) {
      Get(method)(
        ProbeController.prototype,
        method,
        methodDescriptor(ProbeController.prototype, method),
      );
    }

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("broken_captures", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: () => undefined,
          sentryDefects: {
            capture: ({ envelope }) => {
              if (envelope.errorMessage === "throwing capture request") {
                throw new Error("the capture sink threw");
              }
              return Effect.promise(() => Promise.reject(new Error("the capture sink rejected")));
            },
          },
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      assert.strictEqual((await fetch(`${baseUrl}/broken-captures/throwing`)).status, 500);
      assert.strictEqual((await fetch(`${baseUrl}/broken-captures/rejecting`)).status, 500);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe M and N end a response after headers were sent", async () => {
    class ProbeController {
      stream(response: StreamingResponse): never {
        response.write('{"partial":true}');
        throw new Error("stream failure");
      }
    }
    Controller("streaming")(ProbeController);
    Get("failure")(
      ProbeController.prototype,
      "stream",
      methodDescriptor(ProbeController.prototype, "stream"),
    );
    Res()(ProbeController.prototype, "stream", 0);

    class BaselineModule {}
    Module({ controllers: [ProbeController] })(BaselineModule);
    const baseline = await NestFactory.create(BaselineModule, { logger: false });
    await baseline.listen(0, "127.0.0.1");

    class BoundaryModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("streaming_failure", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: () => undefined,
        }),
      ],
      controllers: [ProbeController],
    })(BoundaryModule);
    const boundary = await NestFactory.create(BoundaryModule, { logger: false });
    await boundary.listen(0, "127.0.0.1");

    try {
      for (const app of [baseline, boundary]) {
        const baseUrl = applicationBaseUrl(app.getHttpServer().address());
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 2_000);
        const response = await fetch(`${baseUrl}/streaming/failure`, {
          signal: controller.signal,
        });
        assert.strictEqual(response.status, 200);
        assert.strictEqual(await response.text(), '{"partial":true}');
        clearTimeout(timer);
      }
    } finally {
      await baseline.close().catch(() => undefined);
      await boundary.close().catch(() => undefined);
    }
  }, 30_000);

  it("rejects templated catalog messages during construction", () => {
    const errors = defineErrorCatalog("catalog_templates", {
      INSUFFICIENT_FUNDS: {
        status: 402,
        message: ({ required }: { required: number }) =>
          `Insufficient funds, need ${String(required)}.`,
      },
    });

    try {
      NestErrorBoundaryModule.forRoot<ErrorCatalogReference>({
        catalog: errors,
        recordDefect: () => undefined,
      });
      assert.fail("Expected catalog construction to fail.");
    } catch (cause) {
      assert.instanceOf(cause, InvalidNestErrorCatalogDeclaration);
      assert.strictEqual(cause.code, "OBS_NESTJS_ERROR_CATALOG_INVALID");
      assert.include(cause.message, "catalog_templates.INSUFFICIENT_FUNDS");
      assert.include(
        cause.message,
        "Templated messages are unsupported because the public message must come from the declaration.",
      );
    }
  });

  it("preserves 4xx HttpExceptions with non-HTTP causes", async () => {
    const defects: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];

    class ProbeController {
      notFound(): never {
        throw new NotFoundException("widget not found", { cause: new Error("database detail") });
      }

      badRequest(): never {
        throw new BadRequestException("invalid payload", { cause: new TypeError("parse detail") });
      }
    }
    Controller("caused-client-outcomes")(ProbeController);
    for (const method of ["notFound", "badRequest"] as const) {
      Get(method)(
        ProbeController.prototype,
        method,
        methodDescriptor(ProbeController.prototype, method),
      );
    }

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("caused_client_outcomes", {}),
          recordDefect: (event) => {
            defects.push(event);
          },
          sentryDefects: {
            capture: (input) =>
              Effect.sync(() => {
                captures.push(input.envelope);
                return { kind: "queued" };
              }),
          },
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      assert.strictEqual((await fetch(`${baseUrl}/caused-client-outcomes/notFound`)).status, 404);
      assert.strictEqual((await fetch(`${baseUrl}/caused-client-outcomes/badRequest`)).status, 400);
      assert.lengthOf(defects, 0);
      assert.lengthOf(captures, 0);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("probe O uses the catalog declaration for the public message", async () => {
    const secret = "shard 7 user 42 token sk-abcdef";
    const errors = defineErrorCatalog("catalog_public", {
      ITEM_MISSING: { status: 404, message: "The requested item does not exist." },
    });

    class ProbeController {
      missing(): never {
        throw errors.ITEM_MISSING({ message: secret, status: 451 });
      }
    }
    Controller("catalog-message")(ProbeController);
    Get("missing")(
      ProbeController.prototype,
      "missing",
      methodDescriptor(ProbeController.prototype, "missing"),
    );

    class AppModule {}
    Module({
      imports: [
        NestErrorBoundaryModule.forRoot({ catalog: errors, recordDefect: () => undefined }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      const response = await fetch(`${baseUrl}/catalog-message/missing`);
      const body = await response.text();
      assert.strictEqual(response.status, 404);
      assert.include(body, "The requested item does not exist.");
      assert.notInclude(body, secret);
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);

  it("rejects catalog code mismatches during construction", () => {
    const errors = defineErrorCatalog("invalid_catalog", {
      MISSING: { status: 404, message: "Missing." },
    });
    Reflect.deleteProperty(errors, "MISSING");

    try {
      NestErrorBoundaryModule.forRoot({
        catalog: errors,
        recordDefect: () => undefined,
      });
      assert.fail("Expected catalog construction to fail.");
    } catch (cause) {
      assert.instanceOf(cause, InvalidNestErrorCatalogDeclaration);
      assert.strictEqual(cause.code, "OBS_NESTJS_ERROR_CATALOG_INVALID");
      assert.include(cause.message, "invalid_catalog.MISSING");
    }
  });

  it("rejects invalid catalog status declarations during construction", () => {
    const statuses: ReadonlyArray<readonly [string, number]> = [
      ["NAN", Number.NaN],
      ["ZERO", 0],
      ["SIX_HUNDRED", 600],
      ["NINE_HUNDRED_NINETY_NINE", 999],
      ["FRACTION", 404.5],
      ["NINETY_NINE", 99],
      ["NEGATIVE", -1],
      ["HUGE", 1_000_000_000],
    ];

    for (const [name, status] of statuses) {
      const errors = defineErrorCatalog(`invalid_status_${name.toLowerCase()}`, {
        INVALID: { status, message: "Invalid status." },
      });
      try {
        NestErrorBoundaryModule.forRoot({ catalog: errors, recordDefect: () => undefined });
        assert.fail(`Expected status ${String(status)} to fail construction.`);
      } catch (cause) {
        assert.instanceOf(cause, InvalidNestErrorCatalogDeclaration);
        assert.strictEqual(cause.code, "OBS_NESTJS_ERROR_CATALOG_INVALID");
        assert.include(cause.message, `${errors._prefix}.INVALID`);
      }
    }

    for (const status of [400, 599]) {
      const errors = defineErrorCatalog(`valid_status_${String(status)}`, {
        VALID: { status, message: "Valid status." },
      });
      assert.isDefined(
        NestErrorBoundaryModule.forRoot({ catalog: errors, recordDefect: () => undefined }),
      );
    }
  });

  it("identifies a non-catalog object without reporting _prefix as a declaration", () => {
    const literalCatalog = {
      _prefix: "literal_catalog",
      _codes: ["literal_catalog.ITEM"],
      ITEM: Object.assign(() => new Error("item"), {
        code: "literal_catalog.ITEM",
        status: 404,
        message: "Item missing.",
      }),
    };

    try {
      NestErrorBoundaryModule.forRoot<ErrorCatalogReference>({
        catalog: literalCatalog,
        recordDefect: () => undefined,
      });
      assert.fail("Expected a non-catalog object to fail construction.");
    } catch (cause) {
      assert.instanceOf(cause, InvalidNestErrorCatalogDeclaration);
      assert.include(cause.message, "not a catalog created by defineErrorCatalog");
      assert.notInclude(cause.message, "literal_catalog._prefix");
    }
  });

  it("recognizes structurally compatible HttpExceptions", () => {
    class ForeignHttpException extends Error {
      readonly status = 409;

      getStatus(): number {
        return this.status;
      }

      getResponse(): string {
        return this.message;
      }
    }

    const boundary = new NestErrorBoundary({
      catalog: defineErrorCatalog("structural_http", {}),
      recordDefect: () => undefined,
    });
    const classified = boundary.classify(
      new ForeignHttpException("foreign conflict"),
      new CorrelationContext({}),
    );
    assert.strictEqual(classified.kind, "http-outcome");
  });

  it("classifies throwing structural HTTP accessors as unexpected defects", () => {
    class ThrowingStatus extends Error {
      readonly status = 500;

      getStatus(): number {
        throw new Error("status accessor failed");
      }

      getResponse(): string {
        return this.message;
      }
    }

    class ThrowingResponse extends Error {
      readonly status = 500;

      getStatus(): number {
        return this.status;
      }

      getResponse(): string {
        throw new Error("response accessor failed");
      }
    }

    const boundary = new NestErrorBoundary({
      catalog: defineErrorCatalog("throwing_http", {}),
      recordDefect: () => undefined,
    });
    const correlation = new CorrelationContext({});
    assert.strictEqual(boundary.classify(new ThrowingStatus(), correlation).kind, "unexpected");
    assert.strictEqual(boundary.classify(new ThrowingResponse(), correlation).kind, "unexpected");
  });

  it("preserves own retryability and defaults all other defects to false", async () => {
    const events: Array<DefectEventInput> = [];
    const boundary = new NestErrorBoundary({
      catalog: defineErrorCatalog("retryability", {}),
      recordDefect: (event) => {
        events.push(event);
      },
    });
    const correlation = new CorrelationContext({});
    const retryable = new Error("transient dependency failure");
    Object.defineProperty(retryable, "retryable", { value: true, enumerable: true });
    const inheritedRetryable = new Error("inherited retryability");
    Object.setPrototypeOf(inheritedRetryable, { retryable: true });

    await boundary.handle(boundary.classify(retryable, correlation), {});
    await boundary.handle(boundary.classify(new Error("unknown retryability"), correlation), {});
    await boundary.handle(boundary.classify(inheritedRetryable, correlation), {});

    assert.strictEqual(events[0]?.error.retryable, true);
    assert.strictEqual(events[1]?.error.retryable, false);
    assert.strictEqual(events[2]?.error.retryable, false);
    assert.isDefined(Schema.decodeUnknownSync(Contract.ErrorContext)(events[0]?.error));
    assert.isDefined(Schema.decodeUnknownSync(Contract.ErrorContext)(events[1]?.error));
    assert.isDefined(Schema.decodeUnknownSync(Contract.ErrorContext)(events[2]?.error));
  });

  it("probe P preserves guard and pipe HTTP outcomes", async () => {
    const defects: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];
    const wideEvents: Array<DrainContext> = [];
    const correlation = createRequestWideEventTraceCorrelation((request) =>
      request instanceof IncomingMessage ? request.log : undefined,
    );

    class DenyGuard implements CanActivate {
      canActivate(): boolean {
        throw new ForbiddenException("token scope missing");
      }
    }

    class ProbeController {
      guarded(): string {
        return "ok";
      }

      parsed(_id: number): string {
        return "ok";
      }
    }
    Controller("framework-outcomes")(ProbeController);
    Get("guarded")(
      ProbeController.prototype,
      "guarded",
      methodDescriptor(ProbeController.prototype, "guarded"),
    );
    UseGuards(DenyGuard)(
      ProbeController.prototype,
      "guarded",
      methodDescriptor(ProbeController.prototype, "guarded"),
    );
    Get("parsed/:id")(
      ProbeController.prototype,
      "parsed",
      methodDescriptor(ProbeController.prototype, "parsed"),
    );
    Param("id", ParseIntPipe)(ProbeController.prototype, "parsed", 0);
    Reflect.defineMetadata("design:paramtypes", [Number], ProbeController.prototype, "parsed");

    class AppModule {}
    Module({
      imports: [
        EvlogModule.forRoot({
          drain: (event) => {
            wideEvents.push(event);
          },
        }),
        NestErrorBoundaryModule.forRoot({
          catalog: defineErrorCatalog("framework_outcomes", {
            FAILURE: { status: 500, message: "Failure." },
          }),
          recordDefect: (event) => {
            defects.push(event);
          },
          sentryDefects: {
            capture: (input) =>
              Effect.sync(() => {
                captures.push(input.envelope);
                return { kind: "queued" };
              }),
          },
          requestWideEventTraceCorrelation: correlation,
        }),
      ],
      controllers: [ProbeController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      const guarded = await fetch(`${baseUrl}/framework-outcomes/guarded`);
      assert.strictEqual(guarded.status, 403);
      const parsed = await fetch(`${baseUrl}/framework-outcomes/parsed/not-a-number`);
      assert.strictEqual(parsed.status, 400);
      assert.lengthOf(defects, 0);
      assert.lengthOf(captures, 0);
      assert.lengthOf(
        wideEvents.filter((event) => event.event.path === "/framework-outcomes/guarded"),
        1,
      );
      assert.lengthOf(
        wideEvents.filter(
          (event) => event.event.path === "/framework-outcomes/parsed/not-a-number",
        ),
        1,
      );
      assert.include(JSON.stringify(wideEvents), "token scope missing");
      assert.include(JSON.stringify(wideEvents), "Validation failed");
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);
});
