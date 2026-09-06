import { OtlpTracer } from "effect/unstable/observability";

export const applicationExporter = OtlpTracer.layer({ url: "http://127.0.0.1:4318/v1/traces" });
