import "reflect-metadata";
import { Controller, Get, Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR, NestFactory } from "@nestjs/core";
import { createServer, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect, Option, Predicate, Schema } from "effect";
import { CorrelationContext, type DefectEnvelope } from "@equipe-tech/observability";
import { defineErrorCatalog, type DrainContext } from "evlog";
import { EvlogModule } from "evlog/nestjs";
import { assert, describe, it } from "vite-plus/test";
import {
  createRequestWideEventTraceCorrelation,
  InvalidNestErrorCatalog,
  InvalidTelemetryModuleOptions,
  NestErrorBoundary,
  NestErrorBoundaryModule,
  TelemetryModule,
  TelemetryShutdownError,
  TelemetryStartupError,
  type DefectEventInput,
  type TelemetryModuleOptions,
} from "../src/index.ts";
import { telemetryModuleForTesting } from "../src/TelemetryModule.ts";

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

const occurrenceCount = (content: string, value: string): number => content.split(value).length - 1;

interface OtlpRequest {
  readonly path: string;
  readonly body: string;
}

interface OtlpCapture {
  readonly endpoint: string;
  readonly requests: Array<OtlpRequest>;
  readonly close: () => Promise<void>;
}

const traceExportContent = (capture: OtlpCapture): string =>
  capture.requests
    .filter((request) => request.path === "/v1/traces")
    .map((request) => request.body)
    .join("\n");

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
  it("maps catalog errors and records each unexpected defect once across duplicate boundaries", async () => {
    const capture = await makeOtlpCapture();
    const wideEvents: Array<DrainContext> = [];
    const defectEvents: Array<DefectEventInput> = [];
    const capturedEnvelopes: Array<DefectEnvelope> = [];
    const errors = defineErrorCatalog("catalog_test", {
      ITEM_MISSING: { status: 404, message: "The requested item does not exist." },
    });
    const repeatedDefect = Object.assign(new Error("private defect detail"), {
      code: "DATABASE_FAILURE",
    });

    class BoundaryController {
      expected(): never {
        throw errors.ITEM_MISSING();
      }

      defect(): never {
        throw repeatedDefect;
      }
    }
    Controller("boundary")(BoundaryController);
    for (const method of ["expected", "defect"] as const) {
      Get(method)(
        BoundaryController.prototype,
        method,
        methodDescriptor(BoundaryController.prototype, method),
      );
    }

    const correlation = createRequestWideEventTraceCorrelation((request) =>
      request instanceof IncomingMessage ? request.log : undefined,
    );
    const boundaryOptions = {
      catalog: errors,
      recordDefect: (event: DefectEventInput) => {
        defectEvents.push(event);
      },
      sentryDefects: {
        capture: (input: { readonly envelope: DefectEnvelope }) =>
          Effect.sync(() => {
            capturedEnvelopes.push(input.envelope);
            return { kind: "queued" };
          }),
      },
      requestWideEventTraceCorrelation: correlation,
    };

    class AppModule {}
    Module({
      imports: [
        EvlogModule.forRoot({
          drain: (event) => {
            wideEvents.push(event);
          },
        }),
        TelemetryModule.forRootAsync({
          useFactory: () => ({
            ...enabledOptions(capture.endpoint),
            requestWideEventTraceCorrelation: correlation,
          }),
        }),
        NestErrorBoundaryModule.forRoot(boundaryOptions),
        NestErrorBoundaryModule.forRoot(boundaryOptions),
      ],
      controllers: [BoundaryController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    try {
      const expected = await fetch(`${baseUrl}/boundary/expected`);
      assert.strictEqual(expected.status, 404);
      const ExpectedResponse = Schema.Struct({
        code: Schema.Literal("catalog_test.ITEM_MISSING"),
        message: Schema.Literal("The requested item does not exist."),
        request_id: Schema.String,
        trace_id: Schema.String,
      });
      Schema.decodeUnknownSync(ExpectedResponse)(await expected.json());
      assert.lengthOf(capturedEnvelopes, 0);
      assert.lengthOf(defectEvents, 0);

      for (let attempt = 0; attempt < 2; attempt++) {
        const defect = await fetch(`${baseUrl}/boundary/defect`);
        assert.strictEqual(defect.status, 500);
      }
      assert.lengthOf(defectEvents, 1);
      assert.lengthOf(capturedEnvelopes, 1);
      const defectEvent = defectEvents[0];
      const envelope = capturedEnvelopes[0];
      assert.isDefined(defectEvent);
      assert.isDefined(envelope);
      assert.strictEqual(defectEvent.kind, "defect");
      assert.strictEqual(defectEvent.error.type, "DATABASE_FAILURE");
      assert.strictEqual(envelope.fingerprint[0], "DATABASE_FAILURE");
      assert.isTrue(Option.isSome(envelope.correlation.requestId));
      assert.isTrue(Option.isSome(envelope.correlation.traceId));
      assert.isTrue(Option.isSome(envelope.correlation.spanId));
      assert.lengthOf(
        wideEvents.filter((context) => context.event.path === "/boundary/expected"),
        1,
      );
      assert.include(JSON.stringify(wideEvents), "catalog_test.ITEM_MISSING");
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("deduplicates double filter handling and a downstream filter rethrow", async () => {
    const events: Array<DefectEventInput> = [];
    const captures: Array<DefectEnvelope> = [];
    const options = {
      catalog: { _prefix: "rethrow_test" },
      recordDefect: (event: DefectEventInput) => {
        events.push(event);
      },
      sentryDefects: {
        capture: (input: { readonly envelope: DefectEnvelope }) =>
          Effect.sync(() => {
            captures.push(input.envelope);
            return { kind: "queued" };
          }),
      },
    };
    const downstreamBoundary = new NestErrorBoundary(options);
    const upstreamBoundary = new NestErrorBoundary(options);
    const error = new Error("rethrow defect");
    const correlation = new CorrelationContext({});
    const downstreamFilter = async (): Promise<never> => {
      await downstreamBoundary.handle(downstreamBoundary.classify(error, correlation), {});
      throw error;
    };
    const rethrown = await downstreamFilter().catch((cause: Error) => cause);
    await upstreamBoundary.handle(upstreamBoundary.classify(rethrown, correlation), {});
    assert.lengthOf(events, 1);
    assert.lengthOf(captures, 1);
  });

  it("records defects without a capture attempt when Sentry is disabled", async () => {
    const defects: Array<DefectEventInput> = [];
    const boundary = new NestErrorBoundary({
      catalog: { _prefix: "disabled_test" },
      recordDefect: (event) => {
        defects.push(event);
      },
    });
    const error = new Error("disabled defect");
    const classified = boundary.classify(error, new CorrelationContext({}));
    await boundary.handle(classified, {});
    await boundary.handle(classified, {});
    assert.lengthOf(defects, 1);
  });

  it("registers one span interceptor and one independent exception filter", () => {
    const telemetry = TelemetryModule.forRootAsync({ useFactory: () => ({ enabled: false }) });
    const boundary = NestErrorBoundaryModule.forRoot({
      catalog: { _prefix: "provider_test" },
      recordDefect: () => undefined,
    });
    const providerTokens = [...(telemetry.providers ?? []), ...(boundary.providers ?? [])].flatMap(
      (provider) => (Predicate.hasProperty(provider, "provide") ? [provider.provide] : []),
    );
    assert.lengthOf(
      providerTokens.filter((token) => token === APP_INTERCEPTOR),
      1,
    );
    assert.lengthOf(
      providerTokens.filter((token) => token === APP_FILTER),
      1,
    );
  });

  it("rejects an application catalog without a stable prefix", () => {
    assert.throws(
      () =>
        NestErrorBoundaryModule.forRoot({
          catalog: { _prefix: "" },
          recordDefect: () => undefined,
        }),
      InvalidNestErrorCatalog,
    );
    assert.throws(
      () =>
        NestErrorBoundaryModule.forRoot({
          catalog: { _prefix: "OBS_APPLICATION" },
          recordDefect: () => undefined,
        }),
      InvalidNestErrorCatalog,
    );
  });

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
      await app.close();

      const traceContent = traceExportContent(capture);
      assert.strictEqual(occurrenceCount(traceContent, '"name":"GET /ping"'), 1);
      assert.notInclude(traceContent, "GET /health");
      assert.notInclude(traceContent, "GET /ready");
      assert.notInclude(traceContent, "GET /_telemetry/events");
      assert.include(traceContent, '"service.name","value":{"stringValue":"nestjs-module-test"}');
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("accepts explicit undefined optional configuration and applies defaults", async () => {
    const capture = await makeOtlpCapture();
    const ModuleController = makeController();

    class AppModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({
          imports: undefined,
          inject: undefined,
          useFactory: () => ({
            enabled: true,
            serviceName: "nestjs-undefined-test",
            serviceVersion: "1.0.0",
            environment: "test",
            otlpEndpoint: capture.endpoint,
            healthRouteTemplates: undefined,
            proxyPolicy: undefined,
            requestWideEventTraceCorrelation: undefined,
            shutdownTimeoutMilliseconds: undefined,
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
      await app.close();
      const traceContent = traceExportContent(capture);
      assert.strictEqual(occurrenceCount(traceContent, '"name":"GET /ping"'), 1);
      assert.include(
        traceContent,
        '"service.name","value":{"stringValue":"nestjs-undefined-test"}',
      );
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

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

  it("wraps startup failure, disposes partial runtime resources, and preserves its cause", async () => {
    const capture = await makeOtlpCapture();
    const startupCause = new Error("startup probe failed");
    const lifecycle: Array<string> = [];

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          { useFactory: () => enabledOptions(capture.endpoint) },
          {
            scopedResource: {
              acquire: () => {
                lifecycle.push("resource-acquired");
              },
              release: () => {
                lifecycle.push("resource-finalized");
              },
            },
            startupProbe: () => {
              lifecycle.push("startup-probe");
              assert.deepStrictEqual(lifecycle, ["resource-acquired", "startup-probe"]);
              throw startupCause;
            },
          },
        ),
      ],
    })(AppModule);

    const app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const failure = await app.init().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, TelemetryStartupError);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_STARTUP_FAILED");
      assert.strictEqual(failure?.cause, startupCause);
      assert.deepStrictEqual(lifecycle, [
        "resource-acquired",
        "startup-probe",
        "resource-finalized",
      ]);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
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
      const traceContent = traceExportContent(capture);
      assert.strictEqual(occurrenceCount(traceContent, '"name":"GET /ping"'), 1);
      assert.include(traceContent, '"service.name","value":{"stringValue":"nestjs-module-test"}');
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("rejects duplicate imports with different runtime configurations", async () => {
    const capture = await makeOtlpCapture();
    let resourceAcquisitions = 0;
    const acquisitionResource = {
      acquire: () => {
        resourceAcquisitions++;
      },
      release: () => undefined,
    };

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          { useFactory: () => enabledOptions(capture.endpoint) },
          { scopedResource: acquisitionResource },
        ),
        telemetryModuleForTesting(
          {
            useFactory: async () => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              return enabledOptions(`${capture.endpoint}/alternate`);
            },
          },
          { scopedResource: acquisitionResource },
        ),
      ],
    })(AppModule);

    const app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const failure = await app.init().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, InvalidTelemetryModuleOptions);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_INVALID_MODULE_OPTIONS");
      assert.strictEqual(resourceAcquisitions, 0);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

  it("rejects differing correlation adapters before runtime acquisition", async () => {
    const capture = await makeOtlpCapture();
    let resourceAcquisitions = 0;
    const acquisitionResource = {
      acquire: () => {
        resourceAcquisitions++;
      },
      release: () => undefined,
    };
    const firstCorrelation = createRequestWideEventTraceCorrelation(() => undefined);
    const secondCorrelation = createRequestWideEventTraceCorrelation(() => undefined);

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          {
            useFactory: () => ({
              ...enabledOptions(capture.endpoint),
              requestWideEventTraceCorrelation: firstCorrelation,
            }),
          },
          { scopedResource: acquisitionResource },
        ),
        telemetryModuleForTesting(
          {
            useFactory: async () => {
              await new Promise((resolve) => setTimeout(resolve, 50));
              return {
                ...enabledOptions(capture.endpoint),
                requestWideEventTraceCorrelation: secondCorrelation,
              };
            },
          },
          { scopedResource: acquisitionResource },
        ),
      ],
    })(AppModule);

    const app = await NestFactory.create(AppModule, {
      logger: false,
      abortOnError: false,
    });
    try {
      const failure = await app.init().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, InvalidTelemetryModuleOptions);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_INVALID_MODULE_OPTIONS");
      assert.strictEqual(resourceAcquisitions, 0);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

  it("fences runtime acquisition until the last release finishes", async () => {
    const capture = await makeOtlpCapture();
    let beginDisposal: (() => void) | undefined;
    const disposalStarted = new Promise<void>((resolve) => {
      beginDisposal = resolve;
    });
    let finishDisposal: (() => void) | undefined;
    const disposalGate = new Promise<void>((resolve) => {
      finishDisposal = resolve;
    });

    class FirstModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          { useFactory: () => enabledOptions(capture.endpoint) },
          {
            beforeRuntimeDispose: async () => {
              beginDisposal?.();
              await disposalGate;
            },
          },
        ),
      ],
    })(FirstModule);
    const first = await NestFactory.create(FirstModule, { logger: false });
    await first.init();
    const firstClose = first.close();
    await disposalStarted;

    class SecondModule {}
    Module({
      imports: [
        TelemetryModule.forRootAsync({ useFactory: () => enabledOptions(capture.endpoint) }),
      ],
    })(SecondModule);
    let secondStarted = false;
    const secondCreation = NestFactory.create(SecondModule, { logger: false }).then(async (app) => {
      await app.init();
      secondStarted = true;
      return app;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.isFalse(secondStarted);
    finishDisposal?.();
    await firstClose;
    const second = await secondCreation;
    assert.isTrue(secondStarted);
    await second.close();
    await capture.close();
  });

  it("disposes the runtime after a drain failure and reports a typed shutdown failure", async () => {
    const capture = await makeOtlpCapture();
    let disposals = 0;

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          { useFactory: () => enabledOptions(capture.endpoint) },
          {
            beforeRequestDrain: () => {
              throw new Error("request drain failed");
            },
            onRuntimeDisposed: () => disposals++,
          },
        ),
      ],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      const failure = await app.close().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, TelemetryShutdownError);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_SHUTDOWN_FAILED");
      assert.strictEqual(disposals, 1);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

  it("reports disposal preparation failure only after runtime disposal completes", async () => {
    const capture = await makeOtlpCapture();
    let disposals = 0;

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          { useFactory: () => enabledOptions(capture.endpoint) },
          {
            beforeRuntimeDispose: () => {
              throw new Error("disposal preparation failed");
            },
            onRuntimeDisposed: () => disposals++,
          },
        ),
      ],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
    try {
      const failure = await app.close().then(
        () => undefined,
        (cause) => cause,
      );
      assert.instanceOf(failure, TelemetryShutdownError);
      assert.strictEqual(failure?.code, "OBS_TELEMETRY_SHUTDOWN_FAILED");
      assert.strictEqual(disposals, 1);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  });

  it("bounds a stalled flush, disposes the runtime, and reports a typed shutdown failure", async () => {
    const capture = await makeOtlpCapture(1_000);
    let disposals = 0;
    const ModuleController = makeController();

    class AppModule {}
    Module({
      imports: [
        telemetryModuleForTesting(
          {
            useFactory: () => ({
              ...enabledOptions(capture.endpoint),
              shutdownTimeoutMilliseconds: 25,
            }),
          },
          { onRuntimeDisposed: () => disposals++ },
        ),
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
      assert.strictEqual(disposals, 1);
    } finally {
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);
});
