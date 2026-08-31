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

const Name = Schema.NonEmptyString.check(Schema.isPattern(/^[a-zA-Z0-9._-]+$/));
const Path = Schema.NonEmptyString.check(
  Schema.makeFilter(
    (value) =>
      !value.startsWith("-") &&
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0);
        return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
      }),
    { expected: "a path without leading flags or control characters" },
  ),
);
const decodeName = Schema.decodeUnknownOption(Name);
const decodePath = Schema.decodeUnknownOption(Path);

const invalid = (): never => {
  throw new SentryAdapterError({
    code: "OBS_SENTRY_SOURCE_MAP_INVALID",
    message:
      "The Sentry source map upload configuration is invalid. Set organization, project, release, and at least one safe include path.",
    cause: "invalid source map upload configuration",
  });
};

export const sentrySourceMapUpload = (input: SentrySourceMapInput): SentrySourceMapPlan => {
  if (
    Option.isNone(decodeName(input.organization)) ||
    Option.isNone(decodeName(input.project)) ||
    Option.isNone(decodeName(input.release)) ||
    input.includePaths.length === 0 ||
    input.includePaths.some((path) => Option.isNone(decodePath(path))) ||
    (input.urlPrefix !== undefined && Option.isNone(decodePath(input.urlPrefix)))
  ) {
    return invalid();
  }
  const args = [
    "sourcemaps",
    "upload",
    "--org",
    input.organization,
    "--project",
    input.project,
    "--release",
    input.release,
  ];
  if (input.urlPrefix !== undefined) args.push("--url-prefix", input.urlPrefix);
  if (input.deleteAfterUpload === true) args.push("--delete-after-upload");
  args.push("--", ...input.includePaths);
  return {
    command: "sentry-cli",
    args,
    environment: { authTokenVariable: "SENTRY_AUTH_TOKEN" },
  };
};
