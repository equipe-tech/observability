import { OtlpExporter } from "effect/unstable/observability";

export const applicationExporter = new OtlpExporter({ url: "http://127.0.0.1:4318" });
