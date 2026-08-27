import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Schema } from "effect";
import { assert, describe, it } from "vite-plus/test";
import {
  InvalidTelemetryModuleOptions,
  TelemetryModule,
  TelemetryShutdownError,
  type TelemetryModuleOptions,
} from "../src/nestjs/index.ts";

const AddressBoundary = Schema.Struct({ port: Schema.Number });
const decodeAddress = Schema.decodeUnknownSync(AddressBoundary);

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

const applicationBaseUrl = (address: string | AddressInfo | null): string =>
  `http://127.0.0.1:${decodeAddress(address).port}`;

interface OtlpRequest {
  readonly path: string;
  readonly body: string;
}

interface OtlpCapture {
  readonly endpoint: string;
  readonly requests: Array<OtlpRequest>;
  readonly close: () => Promise<void>;
}

const makeOtlpCapture = async (delayMilliseconds = 0): Promise<OtlpCapture> => {
  const requests: Array<OtlpRequest> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }, delayMilliseconds);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = decodeAddress(server.address());
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve, reject) =>
        server.close((cause) => (cause === undefined ? resolve() : reject(cause))),
      ),
  };
};

const makeController = () => {
  class ModuleController {
    ping(): { readonly ok: boolean } {
      return { ok: true };
    }

    health(): { readonly ok: boolean } {
      return { ok: true };
    }

    ready(): { readonly ok: boolean } {
      return { ok: true };
    }

    telemetry(): { readonly accepted: boolean } {
      return { accepted: true };
    }
  }
  Controller()(ModuleController);
  for (const method of ["ping", "health", "ready"] as const) {
    Get(method)(
      ModuleController.prototype,
      method,
      methodDescriptor(ModuleController.prototype, method),
    );
  }
  Get("_telemetry/events")(
    ModuleController.prototype,
    "telemetry",
    methodDescriptor(ModuleController.prototype, "telemetry"),
  );
  return ModuleController;
};

const enabledOptions = (endpoint: string): TelemetryModuleOptions => ({
  enabled: true,
  serviceName: "nestjs-module-test",
  serviceVersion: "1.0.0",
  environment: "test",
  otlpEndpoint: endpoint,
  healthRouteTemplates: ["/ready/"],
  shutdownTimeoutMilliseconds: 2_000,
});

describe("TelemetryModule", () => {
  it("uses async dependency injection, registers globally, excludes health traffic, and flushes on close", async () => {
    const capture = await makeOtlpCapture();
    const CONFIG = Symbol("TelemetryConfig");
    const ModuleController = makeController();

    class ConfigModule {}
    Module({
      providers: [{ provide: CONFIG, useValue: enabledOptions(capture.endpoint) }],
      exports: [CONFIG],
    })(ConfigModule);

    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          imports: [ConfigModule],
          inject: [CONFIG],
          useFactory: async (options: TelemetryModuleOptions) => options,
        }),
      ],
      controllers: [ModuleController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      for (const path of ["/ping", "/health", "/ready", "/_telemetry/events"]) {
        const response = await fetch(`${baseUrl}${path}`);
        assert.strictEqual(response.status, 200);
      }
      assert.lengthOf(
        capture.requests.filter((request) => request.path === "/v1/traces"),
        0,
      );
      await app.close();

      const traceRequests = capture.requests.filter((request) => request.path === "/v1/traces");
      assert.lengthOf(traceRequests, 1);
      assert.include(traceRequests[0]?.body, '"name":"GET /ping"');
      assert.notInclude(traceRequests[0]?.body, "GET /health");
      assert.notInclude(traceRequests[0]?.body, "GET /ready");
      assert.notInclude(traceRequests[0]?.body, "GET /_telemetry/events");
      assert.include(
        traceRequests[0]?.body,
        '"service.name","value":{"stringValue":"nestjs-module-test"}',
      );
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("keeps disabled mode inert without identity, timers, or network requests", async () => {
    const capture = await makeOtlpCapture();
    const ModuleController = makeController();

    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          useFactory: () => ({ enabled: false }),
        }),
      ],
      controllers: [ModuleController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    try {
      const response = await fetch(`${applicationBaseUrl(app.getHttpServer().address())}/ping`);
      assert.strictEqual(response.status, 200);
      await app.close();
      assert.lengthOf(capture.requests, 0);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

  it("rejects invalid configuration during bootstrap with the public typed error", async () => {
    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          useFactory: () => ({
            enabled: true,
            serviceName: "",
            serviceVersion: "1.0.0",
            environment: "test",
            otlpEndpoint: "https://user:secret@example.test",
            healthRouteTemplates: ["health?token=secret"],
            shutdownTimeoutMilliseconds: 0,
          }),
        }),
      ],
    })(AppModule);

    const failure = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    }).then(
      () => undefined,
      (cause) => cause,
    );
    assert.instanceOf(failure, InvalidTelemetryModuleOptions);
    assert.strictEqual(failure?.code, "OBS_TELEMETRY_INVALID_MODULE_OPTIONS");
  });

  it("propagates an async configuration factory rejection unchanged", async () => {
    const factoryFailure = new Error("configuration service unavailable");

    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          useFactory: async () => Promise.reject(factoryFailure),
        }),
      ],
    })(AppModule);

    const failure = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    }).then(
      () => undefined,
      (cause) => cause,
    );
    assert.strictEqual(failure, factoryFailure);
  });

  it("deduplicates repeated module imports and tolerates concurrent shutdown", async () => {
    const capture = await makeOtlpCapture();
    const ModuleController = makeController();
    const firstTelemetryModule = TelemetryModule.forRootAsync({
      useFactory: () => enabledOptions(capture.endpoint),
    });
    const secondTelemetryModule = TelemetryModule.forRootAsync({
      useFactory: async () => enabledOptions(capture.endpoint),
    });

    class AppModule {}
    Module({
      imports: [firstTelemetryModule, secondTelemetryModule],
      controllers: [ModuleController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    try {
      const response = await fetch(`${applicationBaseUrl(app.getHttpServer().address())}/ping`);
      assert.strictEqual(response.status, 200);
      await Promise.all([app.close(), app.close()]);
      const traceRequests = capture.requests.filter((request) => request.path === "/v1/traces");
      assert.lengthOf(traceRequests, 1);
      assert.strictEqual(traceRequests[0]?.body.split('"name":"GET /ping"').length, 2);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("bounds a stalled flush, disposes the runtime, and reports a typed shutdown failure", async () => {
    const capture = await makeOtlpCapture(1_000);
    const ModuleController = makeController();

    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          useFactory: () => ({
            ...enabledOptions(capture.endpoint),
            shutdownTimeoutMilliseconds: 25,
          }),
        }),
      ],
      controllers: [ModuleController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    try {
      const response = await fetch(`${applicationBaseUrl(app.getHttpServer().address())}/ping`);
      assert.strictEqual(response.status, 200);
      const failure = await app.close().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, TelemetryShutdownError);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_SHUTDOWN_FAILED");
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);
});
