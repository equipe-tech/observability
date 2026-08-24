import { Effect, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { DockerCompose } from "./DockerCompose.ts";
import { StackAssets } from "./StackAssets.ts";

const composeFile = Flag.string("file").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Caminho alternativo do docker-compose.yml da stack local"),
  Flag.optional,
);

const resolveComposeFile = Effect.fn("resolveComposeFile")(function* (file: Option.Option<string>) {
  if (Option.isSome(file)) {
    const path = yield* Path.Path;
    return path.resolve(file.value);
  }
  const assets = yield* StackAssets;
  return yield* assets.prepare();
});

const up = Command.make(
  "up",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.up(resolvedFile);
  }),
).pipe(Command.withDescription("Sobe a stack local (collector + viewer)"));

const down = Command.make(
  "down",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.down(resolvedFile);
  }),
).pipe(Command.withDescription("Derruba a stack local"));

const status = Command.make(
  "status",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    const resolvedFile = yield* resolveComposeFile(file);
    yield* compose.status(resolvedFile);
  }),
).pipe(Command.withDescription("Mostra o estado da stack local"));

const dev = Command.make("dev").pipe(
  Command.withSubcommands([up, down, status]),
  Command.withDescription("Ciclo de vida da stack local de observabilidade"),
);

export const observability = Command.make("observability").pipe(
  Command.withSubcommands([dev]),
  Command.withDescription("Plataforma de observabilidade da Equipe Tech"),
);
