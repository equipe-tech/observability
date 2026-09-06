import { Effect, Redacted, Schema } from "effect";

const AuthenticationTokenEnvironmentName = Schema.String.check(
  Schema.isPattern(/^[A-Z][A-Z0-9_]*$/),
);
const AuthenticationToken = Schema.String.check(
  Schema.makeFilter((value) => value.length > 0 && !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value), {
    expected: "a nonempty authentication token without control characters",
  }),
);
const AuthenticationEnvironment = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Undefined]),
);
const decodeEnvironmentName = Schema.decodeUnknownEffect(AuthenticationTokenEnvironmentName);
const decodeToken = Schema.decodeUnknownEffect(AuthenticationToken);

export class AuthenticationInputError extends Schema.TaggedError<AuthenticationInputError>()(
  "AuthenticationInputError",
  {
    code: Schema.Literal("OBS_CLI_AUTH_TOKEN_INPUT_INVALID"),
    message: Schema.String,
    requestId: Schema.String,
    retryable: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

const failure = (message: string, cause: string): AuthenticationInputError =>
  new AuthenticationInputError({
    code: "OBS_CLI_AUTH_TOKEN_INPUT_INVALID",
    message,
    requestId: crypto.randomUUID(),
    retryable: true,
    cause,
  });

export const authenticationTokenFromEnvironment = Effect.fn("authenticationTokenFromEnvironment")(
  function* (rawName: string) {
    const name = yield* decodeEnvironmentName(rawName).pipe(
      Effect.mapError(() =>
        failure(
          "The authentication token environment name must start with A-Z and contain only A-Z, 0-9, or underscore.",
          "invalid environment name",
        ),
      ),
    );
    const environment = Schema.decodeUnknownSync(AuthenticationEnvironment)(process.env);
    const rawToken = environment[name];
    if (rawToken === undefined || rawToken.length === 0)
      return yield* failure(
        `Authentication token environment variable ${name} is missing or empty. Set it and retry.`,
        "missing environment value",
      );
    const token = yield* decodeToken(rawToken).pipe(
      Effect.mapError(() =>
        failure(
          `Authentication token environment variable ${name} contains an invalid value. Replace it and retry.`,
          "invalid environment value",
        ),
      ),
    );
    return Redacted.make(token);
  },
);
