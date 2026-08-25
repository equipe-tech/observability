import { Effect } from "effect";
import { runMain } from "../../src/node/index.ts";
import * as WideEvent from "../../src/WideEvent.ts";

const mode = process.argv[2] ?? "success";
const runId = process.env["NODE_RUN_ID"] ?? "unknown";

if (mode === "success") {
  runMain(
    Effect.gen(function* () {
      yield* WideEvent.emit("node.main.completed", { "node.run_id": runId });
    }).pipe(Effect.withSpan("node.main")),
  );
} else if (mode === "signal") {
  runMain(
    Effect.gen(function* () {
      yield* WideEvent.emit("node.main.started", { "node.run_id": runId });
      yield* Effect.never;
    }).pipe(Effect.withSpan("node.signal")),
  );
  console.log("ready");
} else {
  runMain(Effect.void, { env: {} });
}
