import { startOtlpCaptureServer } from "../../src/testing/index.ts";

const host = process.argv[2] ?? "";

try {
  const capture = await startOtlpCaptureServer({ host });
  console.log(`acquired ${capture.endpoint.href}`);
  await capture.stop();
  await capture.stop();
  console.log("stopped");
} catch (cause) {
  console.log(`rejected ${String(cause)}`);
}
