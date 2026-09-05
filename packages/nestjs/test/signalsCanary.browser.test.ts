import { Schema } from "effect";
import { expect, test } from "vite-plus/test";
import {
  browserBatchByteLength,
  browserRequestByteBudget,
  createBrowserTelemetryClient,
} from "@equipe-tech/observability/browser";

const Rejection = Schema.Struct({ code: Schema.String });
const Probe = Schema.Struct({ content: Schema.String });

const post = (payload: {
  readonly version: 1;
  readonly events: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly occurredAt: number;
    readonly fields: { readonly [name: string]: string | number | boolean };
  }>;
  readonly metrics: ReadonlyArray<{
    readonly name: string;
    readonly value: number;
    readonly occurredAt: number;
    readonly fields: { readonly [name: string]: string | number | boolean };
  }>;
}): Promise<Response> =>
  fetch("/_telemetry/events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

const readExport = async (marker: string): Promise<string> => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = Schema.decodeUnknownSync(Probe)(await (await fetch("/_probe/export")).json());
    if (probe.content.includes(marker)) return probe.content;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return "";
};

test("admits complete browser batches before Collector side effects", async () => {
  const marker = crypto.randomUUID();
  const metric = (value: number, proof: string) => ({
    name: "browser.operations",
    value,
    occurredAt: Date.now(),
    fields: { "proof.id": `${marker}-${proof}` },
  });
  const event = (name: string) => ({
    id: crypto.randomUUID(),
    name,
    occurredAt: Date.now(),
    fields: {},
  });

  const ordering = await post({
    version: 1,
    events: [event("undeclared.event")],
    metrics: [{ ...metric(1, "unused"), name: "undeclared.metric" }],
  });
  expect(ordering.status).toBe(400);
  expect(Schema.decodeUnknownSync(Rejection)(await ordering.json()).code).toBe(
    "OBS_EVENT_UNKNOWN_NAME",
  );

  const rejectedEvent = await post({
    version: 1,
    events: [event("undeclared.event")],
    metrics: [metric(13, "rejected-event")],
  });
  expect(rejectedEvent.status).toBe(400);

  const rejectedMetric = await post({
    version: 1,
    events: [],
    metrics: [metric(17, "rejected-metric"), { ...metric(1, "unused"), name: "undeclared.metric" }],
  });
  expect(rejectedMetric.status).toBe(400);

  const accepted = await post({
    version: 1,
    events: [
      {
        ...event("accepted.event"),
        fields: { "proof.id": `${marker}-accepted-event` },
      },
    ],
    metrics: [metric(2, "accepted")],
  });
  expect(accepted.status).toBe(202);

  const content = await readExport(`${marker}-accepted-event`);
  expect(content).toContain(`${marker}-accepted-event`);
  expect(content).toContain(`${marker}-accepted`);
  expect(content).not.toContain(`${marker}-rejected-event`);
  expect(content).not.toContain(`${marker}-rejected-metric`);
  expect(content).not.toContain(`${marker}-unused`);
});

test("enforces transactional metric capacity at the Collector destination", async () => {
  const metric = (
    name: string,
    fields: { readonly [name: string]: string | number | boolean } = {},
  ) => ({ name, value: 1, occurredAt: Date.now(), fields });
  const series = (index: number) =>
    metric("capacity.series", {
      "label.first": `f${Math.floor(index / 100)}`,
      "label.second": `s${index % 100}`,
    });

  for (let index = 0; index < 999; index += 32) {
    const response = await post({
      version: 1,
      events: [],
      metrics: Array.from({ length: Math.min(32, 999 - index) }, (_, offset) =>
        series(index + offset),
      ),
    });
    expect(response.status).toBe(202);
  }

  const cumulativeOverflow = await post({
    version: 1,
    events: [],
    metrics: [series(999), series(1_000)],
  });
  expect(cumulativeOverflow.status).toBe(400);

  const repeatedSeries = await post({
    version: 1,
    events: [],
    metrics: [series(999), series(999)],
  });
  expect(repeatedSeries.status).toBe(202);

  const concurrentOverflow = await Promise.all(
    [1_000, 1_001].map((index) => post({ version: 1, events: [], metrics: [series(index)] })),
  );
  expect(concurrentOverflow.map((response) => response.status)).toEqual([400, 400]);

  const rejectedRegistrations = await Promise.all(
    Array.from({ length: 100 }, (_, index) =>
      post({
        version: 1,
        events: [],
        metrics: [metric(`poison.counter_${index}`), metric("undeclared.counter")],
      }),
    ),
  );
  expect(rejectedRegistrations.every((response) => response.status === 400)).toBe(true);

  const admittedAfterRejections = await post({
    version: 1,
    events: [],
    metrics: [metric("poison.counter_100")],
  });
  expect(admittedAfterRejections.status).toBe(202);

  const content = await readExport("poison.counter_100");
  expect(content).toContain("capacity.series");
  expect(content).toContain("poison.counter_100");
  expect(content).not.toContain('poison.counter_0"');
  expect(content).not.toContain('"stringValue":"f10"');
});

test("delivers a canonical near-budget event and unrelated work through Nest", async () => {
  const marker = crypto.randomUUID();
  const fields = Object.fromEntries(
    Array.from({ length: 14 }, (_, index) => [`field.f${index}`, "\u0001".repeat(1_024)]),
  );
  fields["field.f14"] = `${marker}${"\u0001".repeat(566)}`;
  const client = createBrowserTelemetryClient({ flushIntervalMs: 60_000 });
  client.emit("near.limit", fields);
  client.emit("after.large");

  await client.flush();
  await client.dispose();

  expect(client.pending()).toBe(0);
  expect(client.dropped()).toBe(0);
  expect(
    browserBatchByteLength({
      version: 1,
      events: [
        {
          id: "bounded-control",
          name: "near.limit",
          occurredAt: 1,
          fields,
        },
      ],
    }),
  ).toBeLessThanOrEqual(browserRequestByteBudget);
  const content = await readExport(marker);
  expect(content).toContain(marker);
  expect(content).toContain("near.limit");
  expect(content).toContain("after.large");
});
