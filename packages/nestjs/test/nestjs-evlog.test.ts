import "reflect-metadata";
import { Controller, Get, Module, NotFoundException, Param } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Schema } from "effect";
import { createOTLPDrain } from "evlog/otlp";
import { EvlogModule, useLogger } from "evlog/nestjs";
import { createServer, IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { Observable } from "rxjs";
import { assert, describe, it } from "vite-plus/test";
import {
  createRequestWideEventTraceCorrelation,
  TelemetryModule,
  type RequestWideEventLoggerResolver,
  type TelemetryModuleOptions,
} from "../src/index.ts";

const AddressBoundary = Schema.Struct({ port: Schema.Number });
const decodeAddress = Schema.decodeUnknownSync(AddressBoundary);

const OtlpAttribute = Schema.Struct({
  key: Schema.String,
  value: Schema.Struct({
    stringValue: Schema.String.pipe(Schema.optionalKey),
    intValue: Schema.Union([Schema.String, Schema.Number]).pipe(Schema.optionalKey),
    boolValue: Schema.Boolean.pipe(Schema.optionalKey),
  }),
});

const OtlpLogRecord = Schema.Struct({
  traceId: Schema.String.pipe(Schema.optionalKey),
  spanId: Schema.String.pipe(Schema.optionalKey),
  body: Schema.Struct({ stringValue: Schema.String }),
  attributes: Schema.Array(OtlpAttribute),
});

const OtlpLogsPayload = Schema.Struct({
  resourceLogs: Schema.Array(
    Schema.Struct({
      scopeLogs: Schema.Array(Schema.Struct({ logRecords: Schema.Array(OtlpLogRecord) })),
    }),
  ),
});

const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.String.pipe(Schema.optionalKey),
  name: Schema.String,
  attributes: Schema.Array(OtlpAttribute),
});

const OtlpTracesPayload = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      scopeSpans: Schema.Array(Schema.Struct({ spans: Schema.Array(OtlpSpan) })),
    }),
  ),
});

const ResolverResponse = Schema.Struct({ ok: Schema.Boolean });

const decodeLogsPayload = Schema.decodeUnknownSync(OtlpLogsPayload);
const decodeTracesPayload = Schema.decodeUnknownSync(OtlpTracesPayload);
const decodeResolverResponse = Schema.decodeUnknownSync(ResolverResponse);

interface OtlpRequest {
  readonly path: string;
  readonly body: string;
}

interface OtlpCapture {
  readonly endpoint: string;
  readonly requests: Array<OtlpRequest>;
  readonly close: () => Promise<void>;
}

const makeOtlpCapture = async (): Promise<OtlpCapture> => {
  const requests: Array<OtlpRequest> = [];
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ path: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
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

type DecodedLogRecord = typeof OtlpLogRecord.Type;
type DecodedSpan = typeof OtlpSpan.Type;
interface EvlogEventFields {
  readonly path: string;
  readonly overlapId: string | undefined;
  readonly connectionClosed: boolean | undefined;
}

interface CorrelatedLog {
  readonly record: DecodedLogRecord;
  readonly event: EvlogEventFields;
}

const logRecords = (capture: OtlpCapture): Array<DecodedLogRecord> =>
  capture.requests
    .filter((request) => request.path === "/v1/logs")
    .flatMap((request) =>
      decodeLogsPayload(JSON.parse(request.body)).resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) => scope.logRecords),
      ),
    );

const spans = (capture: OtlpCapture): Array<DecodedSpan> =>
  capture.requests
    .filter((request) => request.path === "/v1/traces")
    .flatMap((request) =>
      decodeTracesPayload(JSON.parse(request.body)).resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      ),
    );

const stringAttribute = (record: DecodedLogRecord, key: string): string | undefined =>
  record.attributes.find((attribute) => attribute.key === key)?.value.stringValue;

const booleanAttribute = (record: DecodedLogRecord, key: string): boolean | undefined =>
  record.attributes.find((attribute) => attribute.key === key)?.value.boolValue;

const correlatedLogs = (capture: OtlpCapture): Array<CorrelatedLog> =>
  logRecords(capture).map((record) => {
    const path = stringAttribute(record, "path");
    if (path === undefined) {
      throw new Error("The evlog OTLP record does not contain its request path.");
    }
    return {
      record,
      event: {
        path,
        overlapId: stringAttribute(record, "overlapId"),
        connectionClosed: booleanAttribute(record, "connectionClosed"),
      },
    };
  });

const findLog = (logs: ReadonlyArray<CorrelatedLog>, path: string): CorrelatedLog => {
  const log = logs.find((candidate) => candidate.event.path === path);
  assert.isDefined(log);
  return log;
};

const findSpan = (capturedSpans: ReadonlyArray<DecodedSpan>, traceId: string): DecodedSpan => {
  const span = capturedSpans.find((candidate) => candidate.traceId === traceId);
  assert.isDefined(span);
  return span;
};

const waitForLogRecords = async (capture: OtlpCapture, count: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (logRecords(capture).length < count) {
    if (Date.now() >= deadline) {
      throw new Error(`Expected ${count} OTLP log records before the deadline.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

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

const verifyResolverIsolation = async (
  resolveLogger: RequestWideEventLoggerResolver,
): Promise<void> => {
  const capture = await makeOtlpCapture();
  let resolverInvocations = 0;

  class ResolverController {
    resolve(): { readonly ok: boolean } {
      return { ok: true };
    }
  }
  Controller()(ResolverController);
  Get("resolver")(
    ResolverController.prototype,
    "resolve",
    methodDescriptor(ResolverController.prototype, "resolve"),
  );

  const traceCorrelation = createRequestWideEventTraceCorrelation((request) => {
    resolverInvocations++;
    return resolveLogger(request);
  });

  class AppModule {}
  Module({
    imports: [
      TelemetryModule.forRootAsync({
        useFactory: () => ({
          enabled: true,
          serviceName: "resolver-isolation-test",
          serviceVersion: "1.0.0",
          environment: "test",
          otlpEndpoint: capture.endpoint,
          requestWideEventTraceCorrelation: traceCorrelation,
          shutdownTimeoutMilliseconds: 2_000,
        }),
      }),
    ],
    controllers: [ResolverController],
  })(AppModule);

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0, "127.0.0.1");
  try {
    const response = await fetch(`${applicationBaseUrl(app.getHttpServer().address())}/resolver`);
    assert.strictEqual(response.status, 200);
    assert.isTrue(decodeResolverResponse(await response.json()).ok);
    assert.strictEqual(resolverInvocations, 1);
    await app.close();
    assert.lengthOf(
      spans(capture).filter((span) => span.name === "GET /resolver"),
      1,
    );
  } finally {
    await app.close().catch(() => undefined);
    await capture.close();
  }
};

describe("NestJS evlog trace correlation", () => {
  it("correlates real evlog wide events with native OTLP log fields across the HTTP lifecycle", async () => {
    const capture = await makeOtlpCapture();
    let signalCancellation = (): void => {};
    const cancellationStarted = new Promise<void>((resolve) => {
      signalCancellation = resolve;
    });
    let signalOverlap = (): void => {};
    const overlapStarted = new Promise<void>((resolve) => {
      signalOverlap = resolve;
    });
    let releaseOverlap = (): void => {};
    const overlapRelease = new Promise<void>((resolve) => {
      releaseOverlap = resolve;
    });
    const activeOverlaps = new Set<string>();

    class BridgeController {
      success(): { readonly ok: boolean } {
        return { ok: true };
      }

      clientError(): never {
        throw new NotFoundException("missing bridge fixture");
      }

      defect(): never {
        throw new Error("private bridge defect");
      }

      remote(): { readonly ok: boolean } {
        return { ok: true };
      }

      malformed(): { readonly ok: boolean } {
        return { ok: true };
      }

      cancellation(): Observable<never> {
        return new Observable(() => {
          signalCancellation();
          return () => {};
        });
      }

      async overlap(id: string): Promise<{ readonly id: string }> {
        useLogger<{ readonly overlapId: string }>().set({ overlapId: id });
        activeOverlaps.add(id);
        if (activeOverlaps.size === 2) {
          signalOverlap();
        }
        await overlapRelease;
        return { id };
      }
    }

    Controller("bridge")(BridgeController);
    for (const method of ["success", "clientError", "defect", "remote", "malformed"] as const) {
      Get(method)(
        BridgeController.prototype,
        method,
        methodDescriptor(BridgeController.prototype, method),
      );
    }
    Get("cancel")(
      BridgeController.prototype,
      "cancellation",
      methodDescriptor(BridgeController.prototype, "cancellation"),
    );
    Get("overlap/:id")(
      BridgeController.prototype,
      "overlap",
      methodDescriptor(BridgeController.prototype, "overlap"),
    );
    Param("id")(BridgeController.prototype, "overlap", 0);

    class HealthController {
      health(): { readonly ok: boolean } {
        return { ok: true };
      }
    }
    Controller()(HealthController);
    Get("health")(
      HealthController.prototype,
      "health",
      methodDescriptor(HealthController.prototype, "health"),
    );

    const traceCorrelation = createRequestWideEventTraceCorrelation((request) =>
      request instanceof IncomingMessage ? request.log : undefined,
    );
    const drain = createOTLPDrain({
      endpoint: capture.endpoint,
      serviceName: "nestjs-evlog-test",
      retries: 0,
    });
    const telemetryOptions: TelemetryModuleOptions = {
      enabled: true,
      serviceName: "nestjs-evlog-test",
      serviceVersion: "1.0.0",
      environment: "test",
      otlpEndpoint: capture.endpoint,
      requestWideEventTraceCorrelation: traceCorrelation,
      shutdownTimeoutMilliseconds: 2_000,
    };

    class AppModule {}
    Module({
      imports: [
        EvlogModule.forRoot({ drain }),
        TelemetryModule.forRootAsync({ useFactory: () => telemetryOptions }),
      ],
      controllers: [BridgeController, HealthController],
    })(AppModule);

    const app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(0, "127.0.0.1");
    const baseUrl = applicationBaseUrl(app.getHttpServer().address());
    const sampledTraceId = "11111111111111111111111111111111";
    const sampledParentSpanId = "1111111111111111";
    const unsampledTraceId = "22222222222222222222222222222222";
    const firstOverlapTraceId = "33333333333333333333333333333333";
    const secondOverlapTraceId = "44444444444444444444444444444444";

    try {
      assert.strictEqual((await fetch(`${baseUrl}/bridge/success`)).status, 200);
      assert.strictEqual((await fetch(`${baseUrl}/bridge/clientError`)).status, 404);
      assert.strictEqual((await fetch(`${baseUrl}/bridge/defect`)).status, 500);
      assert.strictEqual(
        (
          await fetch(`${baseUrl}/bridge/remote`, {
            headers: {
              traceparent: `00-${sampledTraceId}-${sampledParentSpanId}-01`,
            },
          })
        ).status,
        200,
      );
      assert.strictEqual(
        (
          await fetch(`${baseUrl}/bridge/remote`, {
            headers: {
              traceparent: `00-${unsampledTraceId}-2222222222222222-00`,
            },
          })
        ).status,
        200,
      );
      assert.strictEqual(
        (
          await fetch(`${baseUrl}/bridge/malformed`, {
            headers: {
              traceparent: "00-not-a-trace-not-a-span-01",
            },
          })
        ).status,
        200,
      );
      assert.strictEqual(
        (
          await fetch(`${baseUrl}/health`, {
            headers: {
              traceparent: "00-55555555555555555555555555555555-5555555555555555-01",
            },
          })
        ).status,
        200,
      );

      const abortController = new AbortController();
      const canceledResponse = fetch(`${baseUrl}/bridge/cancel`, {
        signal: abortController.signal,
      }).catch(() => undefined);
      await cancellationStarted;
      abortController.abort();
      await canceledResponse;

      const firstOverlap = fetch(`${baseUrl}/bridge/overlap/first`, {
        headers: {
          traceparent: `00-${firstOverlapTraceId}-3333333333333333-01`,
        },
      });
      const secondOverlap = fetch(`${baseUrl}/bridge/overlap/second`, {
        headers: {
          traceparent: `00-${secondOverlapTraceId}-4444444444444444-01`,
        },
      });
      await overlapStarted;
      releaseOverlap();
      assert.strictEqual((await firstOverlap).status, 200);
      assert.strictEqual((await secondOverlap).status, 200);

      await waitForLogRecords(capture, 10);
      await app.close();

      const logs = correlatedLogs(capture);
      assert.lengthOf(logs, 10);
      for (const correlated of logs) {
        const attributeKeys = correlated.record.attributes.map((attribute) => attribute.key);
        assert.notInclude(attributeKeys, "traceId");
        assert.notInclude(attributeKeys, "spanId");
      }

      const capturedSpans = spans(capture);
      const successLog = findLog(logs, "/bridge/success");
      const clientErrorLog = findLog(logs, "/bridge/clientError");
      const defectLog = findLog(logs, "/bridge/defect");
      const cancellationLog = findLog(logs, "/bridge/cancel");
      for (const correlated of [successLog, clientErrorLog, defectLog, cancellationLog]) {
        assert.isDefined(correlated.record.traceId);
        assert.isDefined(correlated.record.spanId);
        const span = findSpan(capturedSpans, correlated.record.traceId);
        assert.strictEqual(span.spanId, correlated.record.spanId);
      }
      assert.strictEqual(cancellationLog.event.connectionClosed, true);

      const sampledLog = logs.find((candidate) => candidate.record.traceId === sampledTraceId);
      assert.isDefined(sampledLog);
      const sampledSpan = findSpan(capturedSpans, sampledTraceId);
      assert.strictEqual(sampledSpan.parentSpanId, sampledParentSpanId);
      assert.strictEqual(sampledSpan.spanId, sampledLog.record.spanId);

      const unsampledLog = logs.find((candidate) => candidate.record.traceId === unsampledTraceId);
      assert.isDefined(unsampledLog);
      assert.isDefined(unsampledLog.record.spanId);
      assert.isUndefined(capturedSpans.find((candidate) => candidate.traceId === unsampledTraceId));

      const malformedLog = findLog(logs, "/bridge/malformed");
      assert.isDefined(malformedLog.record.traceId);
      assert.notStrictEqual(malformedLog.record.traceId, "not-a-trace");
      const malformedSpan = findSpan(capturedSpans, malformedLog.record.traceId);
      assert.isUndefined(malformedSpan.parentSpanId);
      assert.strictEqual(malformedSpan.spanId, malformedLog.record.spanId);

      const healthLog = findLog(logs, "/health");
      assert.isUndefined(healthLog.record.traceId);
      assert.isUndefined(healthLog.record.spanId);
      assert.isUndefined(capturedSpans.find((candidate) => candidate.name === "GET /health"));

      const firstOverlapLog = findLog(logs, "/bridge/overlap/first");
      const secondOverlapLog = findLog(logs, "/bridge/overlap/second");
      assert.strictEqual(firstOverlapLog.event.overlapId, "first");
      assert.strictEqual(secondOverlapLog.event.overlapId, "second");
      assert.strictEqual(firstOverlapLog.record.traceId, firstOverlapTraceId);
      assert.strictEqual(secondOverlapLog.record.traceId, secondOverlapTraceId);
      assert.notStrictEqual(firstOverlapLog.record.spanId, secondOverlapLog.record.spanId);
      assert.strictEqual(
        findSpan(capturedSpans, firstOverlapTraceId).spanId,
        firstOverlapLog.record.spanId,
      );
      assert.strictEqual(
        findSpan(capturedSpans, secondOverlapTraceId).spanId,
        secondOverlapLog.record.spanId,
      );
    } finally {
      releaseOverlap();
      await app.close().catch(() => undefined);
      await capture.close();
    }
  }, 30_000);

  it("preserves request behavior when the correlation resolver returns no logger", async () => {
    await verifyResolverIsolation(() => undefined);
  });

  it("preserves request behavior when the correlation resolver throws", async () => {
    await verifyResolverIsolation(() => {
      throw new Error("correlation resolver failed");
    });
  });
});
