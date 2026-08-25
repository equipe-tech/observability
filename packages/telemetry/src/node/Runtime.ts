import { Effect, Runtime } from "effect";
import type { Layer } from "effect";
import { layerFromEnv } from "../Telemetry.ts";
import type { EnvironmentVariables, InvalidTelemetryEnvironment } from "../TelemetryConfig.ts";

export const layer = (
  env?: EnvironmentVariables,
): Layer.Layer<never, InvalidTelemetryEnvironment> => layerFromEnv(env ?? process.env);

const runProcessMain = Runtime.makeRunMain(({ fiber, teardown }) => {
  let receivedSignal = false;

  const onSignal = () => {
    receivedSignal = true;
    fiber.interruptUnsafe(fiber.id);
  };

  fiber.addObserver((exit) => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    teardown(exit, (code) => {
      if (receivedSignal || code !== 0) {
        process.exit(code);
      }
    });
  });

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
});

export type RunMainOptions = {
  readonly env?: EnvironmentVariables;
  readonly disableErrorReporting?: boolean;
  readonly teardown?: Runtime.Teardown;
};

export const runMain = <A, E>(program: Effect.Effect<A, E>, options?: RunMainOptions): void =>
  runProcessMain(Effect.provide(program, layer(options?.env)), {
    disableErrorReporting: options?.disableErrorReporting,
    teardown: options?.teardown,
  });
