import { Effect } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { DockerCompose } from "./DockerCompose.ts";

const composeFile = Flag.string("file").pipe(
  Flag.withAlias("f"),
  Flag.withDescription("Caminho do docker-compose.yml da stack local"),
  Flag.withDefault("compose/docker-compose.yml"),
);

const up = Command.make(
  "up",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    yield* compose.up(file);
  }),
).pipe(Command.withDescription("Sobe a stack local (collector + viewer)"));

const down = Command.make(
  "down",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    yield* compose.down(file);
  }),
).pipe(Command.withDescription("Derruba a stack local"));

const status = Command.make(
  "status",
  { file: composeFile },
  Effect.fn(function* ({ file }) {
    const compose = yield* DockerCompose;
    yield* compose.status(file);
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
