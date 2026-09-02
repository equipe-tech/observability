import "reflect-metadata";
import {
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
import type { AddressInfo } from "node:net";
import { Effect, Schema } from "effect";
import { type DefectEnvelope } from "@equipe-tech/observability";
import { defineErrorCatalog } from "evlog";
import { assert, describe, it } from "vite-plus/test";
import {
  createRequestWideEventTraceCorrelation,
  NestErrorBoundaryModule,
  type DefectEventInput,
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

  it("probe P preserves guard and pipe HTTP outcomes", async () => {
    const defects: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];

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
    } finally {
      await app.close().catch(() => undefined);
    }
  }, 30_000);
});
