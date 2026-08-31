import { Context, Effect, Layer, Option, Schema } from "effect";
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnvironmentName } from "./ResourceNamePolicy.ts";

const OperationsEnvironment = Schema.Struct({
  OBSERVABILITY_HOME: Schema.NonEmptyString.pipe(Schema.optionalKey),
  NODE_ENV: Schema.NonEmptyString.pipe(Schema.optionalKey),
  OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS: Schema.NumberFromString.pipe(Schema.optionalKey),
});
const decodeOperationsEnvironment = Schema.decodeUnknownEffect(OperationsEnvironment);

export class ManualAction extends Schema.Class<ManualAction>(
  "@equipe-tech/observability-cli/ManualAction",
)({
  id: Schema.NonEmptyString,
  provider: Schema.Literals(["Axiom", "Sentry"]),
  capability: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  desiredFingerprint: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "operator-confirmed"]),
  expiresAt: Schema.NonEmptyString.pipe(Schema.optionalKey),
}) {}

export class MutationIntent extends Schema.Class<MutationIntent>(
  "@equipe-tech/observability-cli/MutationIntent",
)({
  id: Schema.NonEmptyString,
  operation: Schema.NonEmptyString,
  resource: Schema.NonEmptyString,
  environment: EnvironmentName,
  desiredFingerprint: Schema.NonEmptyString,
  status: Schema.Literals(["pending", "resolved", "outcome-unknown"]),
  updatedAt: Schema.NonEmptyString,
}) {}

const OperationsStateGeneration = Schema.Int.check(
  Schema.makeFilter((value) => Number.isSafeInteger(value) && value >= 0, {
    expected: "a nonnegative safe integer",
  }),
);

export class OperationsStateDocument extends Schema.Class<OperationsStateDocument>(
  "@equipe-tech/observability-cli/OperationsStateDocument",
)({
  version: Schema.Literal(1),
  generation: OperationsStateGeneration,
  service: Schema.NonEmptyString,
  manualActions: Schema.Array(ManualAction),
  mutations: Schema.Array(MutationIntent),
}) {}

export class OperationsStateError extends Schema.TaggedError<OperationsStateError>()(
  "OperationsStateError",
  {
    code: Schema.Literals([
      "OBS_CLI_OPERATIONS_STATE_INVALID",
      "OBS_CLI_OPERATIONS_STATE_FAILED",
      "OBS_CLI_OPERATIONS_STATE_BUSY",
    ]),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeState = Schema.decodeUnknownEffect(OperationsStateDocument, {
  onExcessProperty: "error",
});
const LockFailure = Schema.Struct({ code: Schema.String });
const LockOwner = Schema.Struct({
  pid: Schema.Int,
  token: Schema.NonEmptyString,
  heartbeatAt: Schema.Number,
});
const decodeLockFailure = Schema.decodeUnknownOption(LockFailure);
const decodeLockOwner = Schema.decodeUnknownOption(LockOwner);
const decodeLockHeartbeat = Schema.decodeUnknownOption(Schema.NumberFromString);
const stateFailure = (cause: unknown): OperationsStateError =>
  new OperationsStateError({
    code: "OBS_CLI_OPERATIONS_STATE_FAILED",
    message:
      "Operations state could not be accessed. Check OBSERVABILITY_HOME permissions and retry.",
    cause,
  });

const initialState = (service: string): OperationsStateDocument =>
  new OperationsStateDocument({
    version: 1,
    generation: 0,
    service,
    manualActions: [],
    mutations: [],
  });

export type OperationsStateAccess = {
  load(service: string): Effect.Effect<OperationsStateDocument, OperationsStateError>;
  update(
    service: string,
    expectedGeneration: number,
    transform: (state: OperationsStateDocument) => OperationsStateDocument,
  ): Effect.Effect<OperationsStateDocument, OperationsStateError>;
};

export class OperationsState extends Context.Service<OperationsState, OperationsStateAccess>()(
  "@equipe-tech/observability-cli/OperationsState",
) {
  static readonly layer = Layer.effect(
    OperationsState,
    Effect.gen(function* () {
      const environment = yield* decodeOperationsEnvironment(process.env).pipe(
        Effect.mapError(stateFailure),
      );
      const root = join(
        environment.OBSERVABILITY_HOME ?? join(homedir(), ".local", "state", "observability"),
        "operations",
      );
      const statePath = (service: string): string => join(root, `${service}.json`);
      const lockPath = (service: string): string => join(root, `${service}.lock`);
      const heartbeatPath = (service: string, token: string): string =>
        join(root, `${service}.heartbeat-${token}`);

      const load = Effect.fn("OperationsState.load")(function* (service: string) {
        const content = yield* Effect.tryPromise({
          try: () => readFile(statePath(service), "utf8"),
          catch: (cause) => cause,
        }).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) => {
            const failure = decodeLockFailure(cause);
            return Option.isSome(failure) && failure.value.code === "ENOENT"
              ? Effect.succeed(Option.none<string>())
              : Effect.fail(stateFailure(cause));
          }),
        );
        if (content._tag === "None") return initialState(service);
        const document = yield* Effect.try({
          try: () => JSON.parse(content.value),
          catch: (cause) =>
            new OperationsStateError({
              code: "OBS_CLI_OPERATIONS_STATE_INVALID",
              message: "Operations state is not valid JSON.",
              cause,
            }),
        });
        const state = yield* decodeState(document).pipe(
          Effect.mapError(
            (cause) =>
              new OperationsStateError({
                code: "OBS_CLI_OPERATIONS_STATE_INVALID",
                message:
                  "Operations state does not match version 1. Remove the invalid file and rerun ops plan to rebuild it.",
                cause,
              }),
          ),
        );
        if (state.service !== service) {
          return yield* new OperationsStateError({
            code: "OBS_CLI_OPERATIONS_STATE_INVALID",
            message: "Operations state belongs to a different service.",
            cause: state.service,
          });
        }
        return state;
      });

      const update = Effect.fn("OperationsState.update")(function* (
        service: string,
        expectedGeneration: number,
        transform: (state: OperationsStateDocument) => OperationsStateDocument,
      ) {
        yield* Effect.tryPromise({
          try: async () => {
            await mkdir(root, { recursive: true, mode: 0o700 });
            await chmod(root, 0o700);
          },
          catch: stateFailure,
        });
        const leaseMilliseconds = 5_000;
        const heartbeatMilliseconds = 1_000;
        const token = crypto.randomUUID();
        const lockDocument = () => ({
          pid: process.pid,
          token,
          heartbeatAt: Date.now(),
        });
        const acquireLock = async () => {
          try {
            const handle = await open(lockPath(service), "wx", 0o600);
            await handle.writeFile(`${JSON.stringify(lockDocument())}\n`);
            return handle;
          } catch (cause) {
            const failure = decodeLockFailure(cause);
            if (Option.isNone(failure) || failure.value.code !== "EEXIST") throw cause;
            const ownerContent = await readFile(lockPath(service), "utf8").catch(() => "");
            const ownerDocument = await Promise.resolve()
              .then(() => JSON.parse(ownerContent))
              .catch(() => undefined);
            const owner = decodeLockOwner(ownerDocument);
            const heartbeat = Option.isSome(owner)
              ? decodeLockHeartbeat(
                  await readFile(heartbeatPath(service, owner.value.token), "utf8").catch(
                    () => "invalid",
                  ),
                )
              : Option.none<number>();
            const lastHeartbeat =
              Option.isSome(heartbeat) && Number.isFinite(heartbeat.value)
                ? heartbeat.value
                : Option.isSome(owner)
                  ? owner.value.heartbeatAt
                  : 0;
            if (Date.now() - lastHeartbeat <= leaseMilliseconds) throw cause;
            await rm(lockPath(service), { force: true });
            if (Option.isSome(owner)) {
              await rm(heartbeatPath(service, owner.value.token), { force: true });
            }
            const handle = await open(lockPath(service), "wx", 0o600);
            await handle.writeFile(`${JSON.stringify(lockDocument())}\n`);
            return handle;
          }
        };
        const lock = yield* Effect.tryPromise({
          try: acquireLock,
          catch: (cause) =>
            new OperationsStateError({
              code: "OBS_CLI_OPERATIONS_STATE_BUSY",
              message: `Operations state for ${service} is locked by another process. Retry later.`,
              cause,
            }),
        });
        const renew = async (): Promise<void> => {
          const target = heartbeatPath(service, token);
          const temporary = `${target}.${crypto.randomUUID()}.tmp`;
          try {
            await writeFile(temporary, `${Date.now()}\n`, { mode: 0o600 });
            await rename(temporary, target);
          } finally {
            await rm(temporary, { force: true });
          }
        };
        yield* Effect.tryPromise({ try: renew, catch: stateFailure });
        const renewHeartbeat = async (): Promise<void> => {
          try {
            await renew();
          } catch {
            return;
          }
        };
        const heartbeat = setInterval(renewHeartbeat, heartbeatMilliseconds);
        return yield* Effect.gen(function* () {
          if (
            environment.NODE_ENV === "test" &&
            environment.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS !== undefined
          ) {
            yield* Effect.sleep(
              `${environment.OBSERVABILITY_CLI_TEST_STATE_HOLD_MILLISECONDS} millis`,
            );
          }
          const current = yield* load(service);
          if (current.generation !== expectedGeneration) {
            return yield* new OperationsStateError({
              code: "OBS_CLI_OPERATIONS_STATE_BUSY",
              message: `Operations state for ${service} changed from generation ${expectedGeneration} to ${current.generation}. Retry with a fresh plan.`,
              cause: current.generation,
            });
          }
          if (current.generation === Number.MAX_SAFE_INTEGER) {
            return yield* new OperationsStateError({
              code: "OBS_CLI_OPERATIONS_STATE_INVALID",
              message: "Operations state generation cannot be incremented safely.",
              cause: current.generation,
            });
          }
          const transformed = transform(current);
          const next = new OperationsStateDocument({
            version: transformed.version,
            generation: current.generation + 1,
            service: transformed.service,
            manualActions: transformed.manualActions,
            mutations: transformed.mutations,
          });
          const temporary = `${statePath(service)}.${crypto.randomUUID()}.tmp`;
          yield* Effect.tryPromise({
            try: async () => {
              await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, {
                mode: 0o600,
              });
              await chmod(temporary, 0o600);
              await rename(temporary, statePath(service));
              await chmod(statePath(service), 0o600);
            },
            catch: stateFailure,
          });
          return next;
        }).pipe(
          Effect.ensuring(
            Effect.tryPromise({
              try: async () => {
                clearInterval(heartbeat);
                await lock.close();
                const ownerContent = await readFile(lockPath(service), "utf8").catch(() => "");
                const ownerDocument = await Promise.resolve()
                  .then(() => JSON.parse(ownerContent))
                  .catch(() => undefined);
                const owner = decodeLockOwner(ownerDocument);
                if (Option.isSome(owner) && owner.value.token === token) {
                  await rm(lockPath(service), { force: true });
                }
                await rm(heartbeatPath(service, token), { force: true });
              },
              catch: stateFailure,
            }).pipe(Effect.ignore),
          ),
        );
      });

      return OperationsState.of({ load, update });
    }),
  );
}
