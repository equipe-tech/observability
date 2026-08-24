import { Console, Context, Effect, Layer, Schema, Stream } from "effect";
import type { Scope } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class DockerComposeError extends Schema.TaggedError<DockerComposeError>()(
  "DockerComposeError",
  {
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
                command,
                message: `Failed to start "${command}". Check that Docker is installed and the daemon is running, then retry.`,
                cause,
              }),
          ),
        );

        yield* handle.all.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => Console.log(line)),
          Effect.mapError(
            (cause) =>
              new DockerComposeError({
                command,
                message: `Lost the output stream of "${command}". Retry the command.`,
                cause,
              }),
          ),
        );

        const exitCode = yield* handle.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new DockerComposeError({
                command,
                message: `Could not read the exit code of "${command}". Retry the command.`,
                cause,
              }),
          ),
        );

        if (exitCode !== ChildProcessSpawner.ExitCode(0)) {
          return yield* new DockerComposeError({
            command,
            message: `"${command}" exited with code ${exitCode}. Inspect the output above, fix the compose file or the Docker state, then retry.`,
            cause: exitCode,
          });
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
