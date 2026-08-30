import { Schema } from "effect";

export const EvlogAdapterErrorCode = Schema.Literals([
  "OBS_EVLOG_ADAPTER_CONFIG_INVALID",
  "OBS_EVLOG_LOGGER_CONFLICT",
  "OBS_EVLOG_EVENT_REJECTED",
]);
export type EvlogAdapterErrorCode = typeof EvlogAdapterErrorCode.Type;

export class EvlogAdapterError extends Schema.TaggedError<EvlogAdapterError>()(
  "EvlogAdapterError",
  {
    code: EvlogAdapterErrorCode,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}
