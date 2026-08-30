import { Schema } from "effect";

export const resourceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const serviceNameMaxLength = 63;
export const environmentNameMaxLength = 32;

export const ServiceName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(serviceNameMaxLength),
);

export const EnvironmentName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(environmentNameMaxLength),
);
