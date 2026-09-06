import { Effect, Schema } from "effect";
import { SentryAdapterError } from "./SentryAdapterError.ts";

export const SentryDsn = Schema.URL.pipe(Schema.brand("SentryDsn"));
export type SentryDsn = typeof SentryDsn.Type;

export type SentryDsnParts = {
  readonly dsn: SentryDsn;
  readonly publicKey: string;
  readonly projectId: string;
};

const keyPattern = /^[a-zA-Z0-9_-]{1,64}$/;
const projectPattern = /^[0-9]{1,20}$/;

export const parseSentryDsn = (value: URL): Effect.Effect<SentryDsnParts, SentryAdapterError> => {
  const path = value.pathname.split("/").filter((part) => part !== "");
  const projectId = path.at(-1);
  if (
    (value.protocol !== "http:" && value.protocol !== "https:") ||
    !keyPattern.test(value.username) ||
    value.password !== "" ||
    projectId === undefined ||
    !projectPattern.test(projectId) ||
    value.search !== "" ||
    value.hash !== ""
  ) {
    return Effect.fail(
      new SentryAdapterError({
        code: "OBS_SENTRY_DSN_INVALID",
        message:
          "SENTRY_DSN is invalid. Use an HTTP or HTTPS Sentry DSN with a public key and numeric project ID.",
        cause: "invalid Sentry DSN",
      }),
    );
  }
  return Effect.succeed({ dsn: SentryDsn.make(value), publicKey: value.username, projectId });
};
