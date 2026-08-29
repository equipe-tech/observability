import { Effect, Option, Schema } from "effect";

export const serviceNamespace = "equipe-tech";

const resourceNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
const immutableReleasePattern = /^[0-9a-f]{7,64}$/;

export const ServiceName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(63),
).pipe(Schema.brand("ServiceName"));
export type ServiceName = typeof ServiceName.Type;

export const EnvironmentName = Schema.String.check(
  Schema.isPattern(resourceNamePattern),
  Schema.isMaxLength(32),
).pipe(Schema.brand("EnvironmentName"));
export type EnvironmentName = typeof EnvironmentName.Type;

export const ServiceVersion = Schema.String.check(
  Schema.makeFilter((value) => semverPattern.test(value) || immutableReleasePattern.test(value), {
    expected: "SemVer 2.0.0 or a 7 to 64 character lowercase hexadecimal release identifier",
  }),
).pipe(Schema.brand("ServiceVersion"));
export type ServiceVersion = typeof ServiceVersion.Type;

export const ServiceInstanceId = Schema.NonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("ServiceInstanceId"),
);
export type ServiceInstanceId = typeof ServiceInstanceId.Type;

export const EnvironmentAliasPolicy = Schema.Literals(["emitted", "omitted"]);
export type EnvironmentAliasPolicy = typeof EnvironmentAliasPolicy.Type;

export class ResourceIdentity extends Schema.Class<ResourceIdentity>(
  "@equipe-tech/observability/ResourceIdentity",
)({
  serviceName: ServiceName,
  serviceVersion: ServiceVersion,
  environment: EnvironmentName,
  instance: Schema.Option(ServiceInstanceId).pipe(
    Schema.withConstructorDefault(Effect.succeed(Option.none())),
  ),
}) {}

export const ResourceIdentityField = Schema.Literals([
  "service.name",
  "service.version",
  "deployment.environment.name",
  "service.instance.id",
]);
export type ResourceIdentityField = typeof ResourceIdentityField.Type;

export class InvalidResourceIdentity extends Schema.TaggedError<InvalidResourceIdentity>()(
  "InvalidResourceIdentity",
  {
    code: Schema.Literal("OBS_RESOURCE_IDENTITY_INVALID"),
    message: Schema.String,
    field: ResourceIdentityField,
    value: Schema.String,
    rule: Schema.String,
  },
) {}

export interface ResourceIdentityInput {
  readonly serviceName: string;
  readonly serviceVersion: string;
  readonly environment: string;
  readonly instance?: Option.Option<string> | undefined;
}

const serviceNameRule = "lowercase letters, numbers, and hyphens with at most 63 characters";
const environmentNameRule = "lowercase letters, numbers, and hyphens with at most 32 characters";
const serviceVersionRule =
  "SemVer 2.0.0 or a 7 to 64 character lowercase hexadecimal immutable release identifier";
const serviceInstanceRule = "a non-empty value with at most 128 characters";

const invalidIdentity = (
  field: ResourceIdentityField,
  value: string,
  rule: string,
  label: string,
): InvalidResourceIdentity =>
  new InvalidResourceIdentity({
    code: "OBS_RESOURCE_IDENTITY_INVALID",
    field,
    value,
    rule,
    message: `${label} ${JSON.stringify(value)} is invalid. Use ${rule}.`,
  });

const decodeResourceIdentity = Schema.decodeUnknownSync(ResourceIdentity);
const decodeServiceName = Schema.decodeUnknownEffect(ServiceName);
const decodeServiceVersion = Schema.decodeUnknownEffect(ServiceVersion);
const decodeEnvironmentName = Schema.decodeUnknownEffect(EnvironmentName);
const decodeServiceInstanceId = Schema.decodeUnknownEffect(ServiceInstanceId);

export const parseResourceIdentity = Effect.fn("parseResourceIdentity")(function* (
  input: ResourceIdentityInput,
): Effect.fn.Return<ResourceIdentity, InvalidResourceIdentity> {
  const serviceName = yield* decodeServiceName(input.serviceName).pipe(
    Effect.mapError(() =>
      invalidIdentity("service.name", input.serviceName, serviceNameRule, "Service name"),
    ),
  );
  const serviceVersion = yield* decodeServiceVersion(input.serviceVersion).pipe(
    Effect.mapError(() =>
      invalidIdentity(
        "service.version",
        input.serviceVersion,
        serviceVersionRule,
        "Service version",
      ),
    ),
  );
  const environment = yield* decodeEnvironmentName(input.environment).pipe(
    Effect.mapError(() =>
      invalidIdentity(
        "deployment.environment.name",
        input.environment,
        environmentNameRule,
        "Environment name",
      ),
    ),
  );
  const rawInstance = input.instance ?? Option.none();
  const instance = yield* Option.match(rawInstance, {
    onNone: () => Effect.succeed(Option.none<ServiceInstanceId>()),
    onSome: (value) =>
      decodeServiceInstanceId(value).pipe(
        Effect.map(Option.some),
        Effect.mapError(() =>
          invalidIdentity("service.instance.id", value, serviceInstanceRule, "Service instance ID"),
        ),
      ),
  });
  return new ResourceIdentity({ serviceName, serviceVersion, environment, instance });
});

export const resourceIdentity = (input: ResourceIdentityInput): ResourceIdentity =>
  decodeResourceIdentity({
    serviceName: input.serviceName,
    serviceVersion: input.serviceVersion,
    environment: input.environment,
    instance: input.instance ?? Option.none(),
  });

export type ResourceAttributes = {
  readonly [attributeName: string]: string;
};

type MutableResourceAttributes = {
  [attributeName: string]: string;
};

const projectedAttributes = (
  identity: ResourceIdentity,
  alias: EnvironmentAliasPolicy,
): MutableResourceAttributes => {
  const attributes: MutableResourceAttributes = {
    "service.namespace": serviceNamespace,
    "service.name": identity.serviceName,
    "service.version": identity.serviceVersion,
    "deployment.environment.name": identity.environment,
  };
  if (alias === "emitted") {
    attributes["deployment.environment"] = identity.environment;
  }
  return attributes;
};

export const instanceResourceAttributes = (
  identity: ResourceIdentity,
  alias: EnvironmentAliasPolicy,
): ResourceAttributes => {
  const attributes = projectedAttributes(identity, alias);
  if (Option.isSome(identity.instance)) {
    attributes["service.instance.id"] = identity.instance.value;
  }
  return attributes;
};

export const serviceResourceAttributes = (
  identity: ResourceIdentity,
  alias: EnvironmentAliasPolicy,
): ResourceAttributes => projectedAttributes(identity, alias);

export const releaseIdentifier = (identity: ResourceIdentity): ServiceVersion =>
  identity.serviceVersion;
