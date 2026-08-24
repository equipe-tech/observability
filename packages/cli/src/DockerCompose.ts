import { Console, Context, Effect, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class DockerComposeError extends Schema.TaggedError<DockerComposeError>()(
  "DockerComposeError",
  {
    code: Schema.Literal("OBS_CLI_COMPOSE_FAILED"),
    command: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class DockerCompose extends Context.Service<
  DockerCompose,
  {
    up(file: string): Effect.Effect<void, DockerComposeError>;
    down(file: string): Effect.Effect<void, DockerComposeError>;
    status(file: string): Effect.Effect<void, DockerComposeError>;
  }
>()("@equipe-tech/observability-cli/DockerCompose") {
  static readonly layer = Layer.effect(
    DockerCompose,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

      const run = Effect.fn("DockerCompose.run")(function* (
        args: ReadonlyArray<string>,
      ): Effect.fn.Return<void, DockerComposeError, Scope.Scope> {
        const command = `docker compose ${args.join(" ")}`;
        const handle = yield* spawner.spawn(ChildProcess.make("docker", ["compose", ...args])).pipe(
          Effect.mapError(
            (cause) =>
              new DockerComposeError({
                code: "OBS_CLI_COMPOSE_FAILED",
                command,
                message:
                  "Docker Compose could not start. Check that Docker is installed and the daemon is available, then retry.",
                cause,
              }),
          ),
        );

        const output = yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runFold(
            () => "",
            (text, line) => (text === "" ? line : `${text}\n${line}`),
          ),
          Effect.mapError(
            (cause) =>
              new DockerComposeError({
                code: "OBS_CLI_COMPOSE_FAILED",
                command,
                message: "Docker Compose output stopped unexpectedly. Retry the command.",
                cause,
              }),
          ),
        );

        const exitCode = yield* handle.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new DockerComposeError({
                code: "OBS_CLI_COMPOSE_FAILED",
                command,
                message: "Docker Compose did not return an exit code. Retry the command.",
                cause,
              }),
          ),
        );

        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new DockerComposeError({
            code: "OBS_CLI_COMPOSE_FAILED",
            command,
            message:
              "Docker Compose rejected the stack configuration or runtime state. Check the configuration and Docker state, then retry.",
            cause: exitCode,
          });
        }

        if (output !== "") {
          yield* Console.log(output);
        }
      }, Effect.scoped);

      return DockerCompose.of({
        up: (file) => run(["-f", file, "up", "-d", "--wait"]),
        down: (file) => run(["-f", file, "down"]),
        status: (file) => run(["-f", file, "ps"]),
      });
    }),
  );
}
