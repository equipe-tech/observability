#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { Command } from "effect/unstable/cli";
import { observability } from "./Cli.ts";
import { DockerCompose } from "./DockerCompose.ts";

const MainLayer = DockerCompose.layer.pipe(Layer.provideMerge(BunServices.layer));

observability.pipe(
  Command.run({ version: "0.1.0" }),
  Effect.provide(MainLayer),
  BunRuntime.runMain,
);
