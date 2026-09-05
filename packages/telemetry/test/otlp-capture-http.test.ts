import { describe, expect, it } from "vite-plus/test";
import { startOtlpCaptureServer } from "../src/testing/index.ts";

describe("OTLP capture HTTP boundary", () => {
  it("rejects malformed JSON and signal documents without poisoning later capture", async () => {
    const receiver = await startOtlpCaptureServer();
    try {
      for (const signal of ["logs", "traces", "metrics"]) {
        for (const body of ["{", "null", "[]", "{}", '{"resourceLogs":false}']) {
          const response = await fetch(new URL(`/v1/${signal}`, receiver.endpoint), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
            signal: AbortSignal.timeout(1_000),
          });
          expect(response.status).toBe(400);
          expect(await response.json()).toEqual({ code: 3, message: "Invalid OTLP JSON payload." });
        }
      }
      const response = await fetch(new URL("/v1/logs", receiver.endpoint), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resourceLogs: [
            {
              resource: { attributes: [] },
              scopeLogs: [
                { logRecords: [{ body: { stringValue: "after rejection" }, attributes: [] }] },
              ],
            },
          ],
        }),
        signal: AbortSignal.timeout(1_000),
      });
      expect(response.status).toBe(200);
      expect(receiver.telemetry().logs).toHaveLength(1);
      expect(receiver.telemetry().logs[0]?.body).toMatchObject({ value: "after rejection" });
    } finally {
      await receiver.stop();
      await receiver.stop();
    }
    await expect(fetch(new URL("/v1/logs", receiver.endpoint))).rejects.toThrow(TypeError);
  });
});
