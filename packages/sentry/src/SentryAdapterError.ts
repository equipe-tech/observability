import { Schema } from "effect";

export const SentryErrorCode = Schema.Literals([
  "OBS_SENTRY_CONFIG_INVALID",
  "OBS_SENTRY_CAPTURE_INVALID",
  "OBS_SENTRY_DSN_INVALID",
  "OBS_SENTRY_DISABLED",
  "OBS_SENTRY_SOURCE_MAP_INVALID",
]);
export type SentryErrorCode = typeof SentryErrorCode.Type;

export class SentryAdapterError extends Schema.TaggedError<SentryAdapterError>()(
  "SentryAdapterError",
  {
    code: SentryErrorCode,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
