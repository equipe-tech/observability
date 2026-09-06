export type ReactWebLifecycle = {
  readonly environmentRequiringDefects: "production";
  readonly shutdownDeadlineMillis: 2_000;
  readonly eventShutdownDeadlineMillis: 1_150;
  readonly sentryDeadlineMillis: 800;
  readonly flushDeadlineMillis: 5_000;
};

export const reactWebLifecycle: ReactWebLifecycle = Object.freeze({
  environmentRequiringDefects: "production",
  shutdownDeadlineMillis: 2_000,
  eventShutdownDeadlineMillis: 1_150,
  sentryDeadlineMillis: 800,
  flushDeadlineMillis: 5_000,
});
