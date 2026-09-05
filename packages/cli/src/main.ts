#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, Layer, Option } from "effect";
import { Command } from "effect/unstable/cli";
import { observability } from "./Cli.ts";
import { CredentialsStore } from "./CredentialsStore.ts";
import { DockerCompose } from "./DockerCompose.ts";
import { packageVersion } from "./PackageVersion.ts";
import { publicErrorFromCause } from "./ErrorReporter.ts";
import { ProvisionAssets } from "./ProvisionAssets.ts";
import { AxiomApi, SentryApi } from "./ProviderApis.ts";
import { Authentication, RemoteEnvironment } from "./RemoteEnvironment.ts";
import { OperationsPlanner } from "./OperationsPlan.ts";
import { OperationsState } from "./OperationsState.ts";
import { StackAssets } from "./StackAssets.ts";

const ProviderLayer = Layer.mergeAll(CredentialsStore.layer, AxiomApi.layer, SentryApi.layer);
const RemoteLayer = Layer.mergeAll(Authentication.layer, RemoteEnvironment.layer).pipe(
  Layer.provide(ProviderLayer),
);
const OperationsLayer = OperationsPlanner.layer.pipe(
  Layer.provide(Layer.mergeAll(ProviderLayer, OperationsState.layer)),
);
const MainLayer = Layer.mergeAll(
  DockerCompose.layer,
  StackAssets.layer,
  ProvisionAssets.layer,
  ProviderLayer,
  RemoteLayer,
  OperationsLayer,
).pipe(Layer.provideMerge(BunServices.layer));

observability.pipe(
  Command.run({ version: packageVersion }),
  Effect.provide(MainLayer),
  Effect.catchTags({
    DockerComposeError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    StackAssetsError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    ProvisionError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    CredentialsError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    RemoteApiError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    RemoteEnvironmentError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    OperationsManifestError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    ManagedQueryError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    OperationsError: (error) =>
      Console.error(`${error.code}: ${error.message}`).pipe(Effect.andThen(Effect.fail(error))),
    OperationsStateError: (error) =>
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
