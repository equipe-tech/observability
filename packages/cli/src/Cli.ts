import { Console, Effect, Option, Path } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { DockerCompose } from "./DockerCompose.ts";
import { ProvisionAssets } from "./ProvisionAssets.ts";
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

const provisionDirectory = Flag.string("dir").pipe(
  Flag.withAlias("d"),
  Flag.withDescription("Diretório do projeto alvo (padrão: diretório atual)"),
  Flag.withDefault("."),
);

const provisionName = Flag.string("name").pipe(
  Flag.withAlias("n"),
  Flag.withDescription("Nome do projeto usado nos datasets (padrão: nome do diretório alvo)"),
  Flag.optional,
);

const provisionForce = Flag.boolean("force").pipe(
  Flag.withDescription("Sobrescreve arquivos provisionados que foram modificados"),
  Flag.withDefault(false),
);

const provision = Command.make(
  "provision",
  { dir: provisionDirectory, name: provisionName, force: provisionForce },
  Effect.fn(function* ({ dir, force, name }) {
    const assets = yield* ProvisionAssets;
    const files = yield* assets.provision(dir, name, force);
    for (const file of files) {
      yield* Console.log(`${file.action}  ${file.relativePath}`);
    }
    yield* Console.log(
      "Merge observability/kamal.accessory.yml into config/deploy.yml and set the AXIOM_TOKEN secret.",
    );
  }),
).pipe(
  Command.withDescription(
    "Provisiona os assets do Collector de produção (config + accessory Kamal) no projeto",
  ),
);

export const observability = Command.make("observability").pipe(
  Command.withSubcommands([dev, provision]),
  Command.withDescription("Plataforma de observabilidade da Equipe Tech"),
);
