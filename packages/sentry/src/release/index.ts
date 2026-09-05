import { Effect, Schema } from "effect";
import type { SentrySourceMapPlan } from "../policy/SourceMapUpload.ts";

const Identity = Schema.Struct({
  serviceName: Schema.NonEmptyString,
  serviceVersion: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
});
const SourceMapArgument = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) && !value.toLowerCase().startsWith("--auth-token"),
    { expected: "a credential-free source map argument" },
  ),
);
const SourceMapPlan = Schema.Struct({
  command: Schema.Literal("sentry-cli"),
  args: Schema.Array(SourceMapArgument),
  environment: Schema.Struct({ authTokenVariable: Schema.Literal("SENTRY_AUTH_TOKEN") }),
});
const ReleaseReceipt = Schema.Struct({
  observationId: Schema.NonEmptyString,
  identity: Identity,
});

export type SentryReleaseIdentity = typeof Identity.Type;
export type SentryReleaseReceipt = typeof ReleaseReceipt.Type;
export type SentrySourceMapExecutionReceipt = {
  readonly command: "sentry-cli";
  readonly exitCode: 0;
};
export type SentrySourceMapSession = {
  readonly execute: (
    plan: SentrySourceMapPlan,
  ) => Effect.Effect<SentrySourceMapExecutionReceipt, SentryReleaseError>;
};
export type SentrySourceMapTransport = {
  readonly acquire: Effect.Effect<SentrySourceMapSession, SentryReleaseError>;
  readonly release: (session: SentrySourceMapSession) => Effect.Effect<void>;
};
export type SentryReleaseSession = {
  readonly emit: (
    identity: SentryReleaseIdentity,
  ) => Effect.Effect<{ readonly observationId: string }, SentryReleaseError>;
  readonly readBack: (input: {
    readonly identity: SentryReleaseIdentity;
    readonly observationId: string;
  }) => Effect.Effect<SentryReleaseReceipt, SentryReleaseError>;
};
export type SentryReleaseTransport = {
  readonly acquire: Effect.Effect<SentryReleaseSession, SentryReleaseError>;
  readonly release: (session: SentryReleaseSession) => Effect.Effect<void>;
};

export class SentryReleaseError extends Schema.TaggedError<SentryReleaseError>()(
  "SentryReleaseError",
  {
    code: Schema.Literals([
      "OBS_SENTRY_RELEASE_INPUT_INVALID",
      "OBS_SENTRY_SOURCE_MAP_EXECUTION_FAILED",
      "OBS_SENTRY_RELEASE_VERIFICATION_FAILED",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const failure = (
  code: SentryReleaseError["code"],
  message: string,
  cause: unknown,
): SentryReleaseError => new SentryReleaseError({ code, message, cause });
const decodeIdentity = Schema.decodeUnknownEffect(Identity);
const decodePlan = Schema.decodeUnknownEffect(SourceMapPlan);
const decodeReceipt = Schema.decodeUnknownEffect(ReleaseReceipt);

export const executeSentrySourceMapUpload = Effect.fn("executeSentrySourceMapUpload")(function* (
  plan: SentrySourceMapPlan,
  transport: SentrySourceMapTransport,
) {
  const parsed = yield* decodePlan(plan).pipe(
    Effect.mapError((cause) =>
      failure(
        "OBS_SENTRY_RELEASE_INPUT_INVALID",
        "The Sentry source map execution plan is invalid.",
        cause,
      ),
    ),
  );
  return yield* Effect.acquireUseRelease(
    transport.acquire,
    (session) => session.execute(parsed),
    transport.release,
  );
});

export const runSentryReleaseVerification = Effect.fn("runSentryReleaseVerification")(function* (
  identity: SentryReleaseIdentity,
  transport: SentryReleaseTransport,
) {
  const parsedIdentity = yield* decodeIdentity(identity).pipe(
    Effect.mapError((cause) =>
      failure("OBS_SENTRY_RELEASE_INPUT_INVALID", "The Sentry release identity is invalid.", cause),
    ),
  );
  return yield* Effect.acquireUseRelease(
    transport.acquire,
    (session) =>
      Effect.gen(function* () {
        const emitted = yield* session.emit(parsedIdentity);
        const receipt = yield* session
          .readBack({ identity: parsedIdentity, observationId: emitted.observationId })
          .pipe(
            Effect.flatMap(decodeReceipt),
            Effect.mapError((cause) =>
              cause instanceof SentryReleaseError
                ? cause
                : failure(
                    "OBS_SENTRY_RELEASE_VERIFICATION_FAILED",
                    "The Sentry verification read-back is invalid.",
                    cause,
                  ),
            ),
          );
        if (
          receipt.observationId !== emitted.observationId ||
          receipt.identity.serviceName !== parsedIdentity.serviceName ||
          receipt.identity.serviceVersion !== parsedIdentity.serviceVersion ||
          receipt.identity.environment !== parsedIdentity.environment
        )
          return yield* failure(
            "OBS_SENTRY_RELEASE_VERIFICATION_FAILED",
            "The Sentry verification read-back does not match the emitted release identity.",
            receipt,
          );
        return receipt;
      }),
    transport.release,
  );
});

export const sentryCliSourceMapTransport = (): SentrySourceMapTransport => ({
  acquire: Effect.succeed({
    execute: (plan) =>
      Effect.acquireUseRelease(
        Effect.try({
          try: () =>
            Bun.spawn([plan.command, ...plan.args], {
              stdin: "ignore",
              stdout: "inherit",
              stderr: "inherit",
            }),
          catch: (cause) =>
            failure(
              "OBS_SENTRY_SOURCE_MAP_EXECUTION_FAILED",
              "The Sentry source map uploader could not start.",
              cause,
            ),
        }),
        (child) =>
          Effect.tryPromise({
            try: async () => {
              const exitCode = await child.exited;
              if (exitCode !== 0)
                throw failure(
                  "OBS_SENTRY_SOURCE_MAP_EXECUTION_FAILED",
                  `The Sentry source map uploader exited with code ${exitCode}.`,
                  exitCode,
                );
              const receipt: SentrySourceMapExecutionReceipt = {
                command: "sentry-cli",
                exitCode: 0,
              };
              return receipt;
            },
            catch: (cause) =>
              cause instanceof SentryReleaseError
                ? cause
                : failure(
                    "OBS_SENTRY_SOURCE_MAP_EXECUTION_FAILED",
                    "The Sentry source map uploader failed.",
                    cause,
                  ),
          }).pipe(
            Effect.timeout("5 minutes"),
            Effect.mapError((cause) =>
              cause instanceof SentryReleaseError
                ? cause
                : failure(
                    "OBS_SENTRY_SOURCE_MAP_EXECUTION_FAILED",
                    "The Sentry source map uploader timed out.",
                    cause,
                  ),
            ),
          ),
        (child) => Effect.sync(() => child.kill()),
      ),
  }),
  release: () => Effect.void,
});
