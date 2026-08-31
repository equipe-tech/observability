import { Option, Schema } from "effect";
import { SentryAdapterError } from "../SentryAdapterError.ts";

export type SentrySourceMapInput = {
  readonly organization: string;
  readonly project: string;
  readonly release: string;
  readonly includePaths: ReadonlyArray<string>;
  readonly urlPrefix?: string;
  readonly deleteAfterUpload?: boolean;
};

export type SentrySourceMapPlan = {
  readonly command: "sentry-cli";
  readonly args: ReadonlyArray<string>;
  readonly environment: { readonly authTokenVariable: "SENTRY_AUTH_TOKEN" };
};

const SafeArgument = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      !value.startsWith("-") &&
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      }),
    { expected: "a value without leading flags or control characters" },
  ),
);
const Name = SafeArgument.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/));
const Path = SafeArgument;
const SourceMapInputDocument = Schema.Struct({
  organization: Name,
  project: Name,
  release: Name,
  includePaths: Schema.Array(Path),
  urlPrefix: Schema.optional(Path),
  deleteAfterUpload: Schema.optional(Schema.Boolean),
});
const decodeInput = Schema.decodeUnknownOption(SourceMapInputDocument, {
  onExcessProperty: "error",
});

const invalid = (): never => {
  throw new SentryAdapterError({
    code: "OBS_SENTRY_SOURCE_MAP_INVALID",
    message:
      "The Sentry source map upload configuration is invalid. Set organization, project, release, and at least one safe include path.",
    cause: "invalid source map upload configuration",
  });
};

export const sentrySourceMapUpload = (input: SentrySourceMapInput): SentrySourceMapPlan => {
  const decoded = decodeInput(input);
  if (Option.isNone(decoded) || decoded.value.includePaths.length === 0) return invalid();
  const config = decoded.value;
  const args = [
    "sourcemaps",
    "upload",
    "--org",
    config.organization,
    "--project",
    config.project,
    "--release",
    config.release,
  ];
  if (config.urlPrefix !== undefined) args.push("--url-prefix", config.urlPrefix);
  if (config.deleteAfterUpload === true) args.push("--delete-after-upload");
  args.push("--", ...config.includePaths);
  return {
    command: "sentry-cli",
    args,
    environment: { authTokenVariable: "SENTRY_AUTH_TOKEN" },
  };
};
