#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { observability } from "./Cli.ts";
import { DockerCompose } from "./DockerCompose.ts";
import { publicErrorFromCause } from "./ErrorReporter.ts";
import { StackAssets } from "./StackAssets.ts";

const MainLayer = Layer.merge(DockerCompose.layer, StackAssets.layer).pipe(
  Layer.provideMerge(BunServices.layer),
);

observability.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  Effect.catchTags({
    DockerComposeError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    StackAssetsError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
  }),
  Effect.catchCause((cause) =>
    Option.match(publicErrorFromCause(cause), {
      onNone: () => Effect.failCause(cause),
      onSome: (message) => Console.error(message).pipe(Effect.andThen(Effect.failCause(cause))),
    }),
  ),
  (program) => BunRuntime.runMain(program, { disableErrorReporting: true }),
);
