import { SentryAdapterError } from "../SentryAdapterError.ts";

const unavailable = (cause: unknown): never => {
  throw new SentryAdapterError({
    code: "OBS_SENTRY_CAPTURE_INVALID",
    message: "The Sentry event ID could not be generated. A secure random source is required.",
    cause,
  });
};

export const secureEventId = (): string => {
  try {
    const bytes = new Uint8Array(16);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch (cause) {
    return unavailable(cause);
  }
};
