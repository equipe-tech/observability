import { Schema } from "effect";

export const resourceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const serviceNameMaxLength = 63;
export const environmentNameMaxLength = 32;
export const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
export const immutableReleasePattern = /^[0-9a-f]{7,64}$/;

export const ServiceName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(serviceNameMaxLength),
);

export const EnvironmentName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(environmentNameMaxLength),
);

export const ServiceVersion = Schema.String.check(
  Schema.makeFilter((value) => semverPattern.test(value) || immutableReleasePattern.test(value), {
    expected: "SemVer 2.0.0 or a 7 to 64 character lowercase hexadecimal release identifier",
  }),
);
