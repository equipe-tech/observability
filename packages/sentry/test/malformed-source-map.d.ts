import type { sentrySourceMapUpload } from "../src/policy/SourceMapUpload.ts";

export declare const malformedSourceMapErrors: (
  upload: typeof sentrySourceMapUpload,
) => Array<string>;
