import { assert, describe, it } from "vite-plus/test";
import { readFile } from "node:fs/promises";

const exportPath = process.env["OBSERVABILITY_EXPORT_PATH"];
const collectorEnabled = process.env["OBSERVABILITY_E2E"] === "1" && exportPath !== undefined;

const waitForExport = async (runId: string): Promise<string> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const content = await readFile(exportPath ?? "", "utf8").catch(() => "");
    const runContent = content
      .split("\n")
      .filter((line) => line.includes(runId))
      .join("\n");
    if (
      runContent.includes('"resourceMetrics"') &&
      runContent.includes('"resourceLogs"') &&
      runContent.includes('"resourceSpans"')
    ) {
      return runContent;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Collector redaction fixtures were not exported within 10 seconds.");
};

const send = async <Payload>(
  signal: "metrics" | "logs" | "traces",
  payload: Payload,
): Promise<void> => {
  const response = await fetch(`http://127.0.0.1:4318/v1/${signal}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.strictEqual(response.status, 200);
};

describe.runIf(collectorEnabled)("Collector redaction", () => {
  it("redacts nested assignments on every raw OTLP signal", async () => {
    const runId = `collector-${crypto.randomUUID()}`;
    const marker = `COLLECTORSECRET${crypto.randomUUID().replaceAll("-", "")}`;
    const fixtures = [
      `https://api.x/login?password=${marker}`,
      `url=https://api.x/cb?token=${marker}`,
      `a=1&password=${marker}&b=2`,
      `note="token=${marker}" safe=1`,
      `data[password]=${marker}`,
      `authorization: Basic ${marker} ${marker}`,
      `authorization: Digest username=${marker}, response=${marker}`,
      `cookie: sid=${marker}; csrf=${marker}; theme=dark`,
      `password: my ${marker} pass phrase`,
      `token =${marker}`,
      `'password': '${marker}'`,
      `"password" = '${marker}'`,
      "`password`: `" + marker + "`",
      `error sending 'token': "${marker}"`,
      `{'password': '${marker}'}`,
      `password=${marker}&more`,
      `password=${marker}#fragment`,
      `password=${marker}&safe=1`,
      `password=${marker}#safe:1`,
      `password=${marker}&token=${marker}`,
    ];
    const attributes = (prefix: string) => [
      { key: "test.run_id", value: { stringValue: runId } },
      ...fixtures.map((value, index) => ({
        key: `${prefix}.${index}`,
        value: { stringValue: value },
      })),
    ];
    const resource = { attributes: attributes("resource.case") };
    const timeUnixNano = String(Date.now() * 1_000_000);
    const traceId = crypto.randomUUID().replaceAll("-", "");

    await send("metrics", {
      resourceMetrics: [
        {
          resource,
          scopeMetrics: [
            {
              scope: { name: "obs47" },
              metrics: [
                {
                  name: "obs47.collector.redaction",
                  gauge: {
                    dataPoints: [
                      { timeUnixNano, asDouble: 1, attributes: attributes("point.case") },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    await send("logs", {
      resourceLogs: [
        {
          resource,
          scopeLogs: [
            {
              scope: { name: "obs47" },
              logRecords: fixtures.map((value) => ({
                timeUnixNano,
                body: { stringValue: value },
                attributes: attributes("log.case"),
              })),
            },
          ],
        },
      ],
    });
    await send("traces", {
      resourceSpans: [
        {
          resource,
          scopeSpans: [
            {
              scope: { name: "obs47" },
              spans: fixtures.map((value) => ({
                traceId,
                spanId: crypto.randomUUID().replaceAll("-", "").slice(0, 16),
                name: value,
                startTimeUnixNano: timeUnixNano,
                endTimeUnixNano: String(Number(timeUnixNano) + 1),
                attributes: attributes("span.case"),
                events: [
                  {
                    timeUnixNano,
                    name: value,
                    attributes: attributes("event.case"),
                  },
                ],
              })),
            },
          ],
        },
      ],
    });

    const content = await waitForExport(runId);
    assert.notInclude(content, marker);
    assert.include(content, "[REDACTED]");
  });
});
