import { Effect, Option, Schema } from "effect";

export class InvalidErrorCatalog extends Schema.TaggedError<InvalidErrorCatalog>()(
  "InvalidErrorCatalog",
  {
    code: Schema.Literals([
      "OBS_EFFECT_ERROR_CATALOG_PREFIX_INVALID",
      "OBS_EFFECT_ERROR_CATALOG_INVALID",
    ]),
    message: Schema.String,
    catalogCode: Schema.String,
  },
) {}

const CatalogPrefix = Schema.NonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/),
  Schema.makeFilter((prefix) => !/^OBS_/i.test(prefix), {
    expected: "a prefix outside the reserved OBS_ namespace",
  }),
);
const EntryName = Schema.NonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]*$/),
);
const EntryStatus = Schema.Int.check(Schema.isBetween({ minimum: 400, maximum: 599 }));
const EntryMessage = Schema.NonEmptyString.check(Schema.isMaxLength(512));
const CatalogEntryDocument = Schema.Struct({ status: EntryStatus, message: EntryMessage });

const decodeCatalogPrefix = Schema.decodeUnknownOption(CatalogPrefix);
const decodeEntryName = Schema.decodeUnknownOption(EntryName);
const decodeCatalogEntry = Schema.decodeUnknownOption(CatalogEntryDocument);

export type ErrorCatalogEntryInput = {
  readonly status: number;
  readonly message: string;
};

export type ErrorCatalogEntries = {
  readonly [name: string]: ErrorCatalogEntryInput;
};

export type ErrorCatalogInput<Entries extends ErrorCatalogEntries = ErrorCatalogEntries> = {
  readonly prefix: string;
  readonly entries: Entries;
};

export type ErrorCatalogEntry = {
  readonly code: string;
  readonly status: number;
  readonly message: string;
};

export class ErrorCatalog<Entries extends ErrorCatalogEntries = ErrorCatalogEntries> {
  readonly prefix: string;
  readonly #entries: ReadonlyMap<string, ErrorCatalogEntry>;

  constructor(prefix: string, entries: ReadonlyMap<string, ErrorCatalogEntry>) {
    this.prefix = prefix;
    this.#entries = entries;
  }

  get entries(): ReadonlyArray<ErrorCatalogEntry> {
    return [...this.#entries.values()];
  }

  code(name: keyof Entries & string): string {
    return `${this.prefix}.${name}`;
  }

  lookup(code: string): Option.Option<ErrorCatalogEntry> {
    return Option.fromNullishOr(this.#entries.get(code));
  }
}

const invalidEntry = (catalogCode: string, reason: string): InvalidErrorCatalog =>
  new InvalidErrorCatalog({
    code: "OBS_EFFECT_ERROR_CATALOG_INVALID",
    message: `The error catalog declaration "${catalogCode}" is invalid: ${reason}. Fix the declaration before starting the server.`,
    catalogCode,
  });

export const defineErrorCatalog = Effect.fnUntraced(function* <
  const Entries extends ErrorCatalogEntries,
>(input: ErrorCatalogInput<Entries>): Effect.fn.Return<ErrorCatalog<Entries>, InvalidErrorCatalog> {
  const prefix = decodeCatalogPrefix(input.prefix);
  if (Option.isNone(prefix)) {
    return yield* new InvalidErrorCatalog({
      code: "OBS_EFFECT_ERROR_CATALOG_PREFIX_INVALID",
      message:
        "The error catalog prefix is invalid. Provide a stable application prefix that does not use the reserved OBS_ package namespace.",
      catalogCode: `${input.prefix}.*`,
    });
  }
  const entries = new Map<string, ErrorCatalogEntry>();
  for (const [name, declaration] of Object.entries(input.entries)) {
    const code = `${prefix.value}.${name}`;
    if (Option.isNone(decodeEntryName(name))) {
      return yield* invalidEntry(code, "the entry name must be a bounded identifier");
    }
    const entry = decodeCatalogEntry(declaration);
    if (Option.isNone(entry)) {
      return yield* invalidEntry(
        code,
        "the declaration needs an integer status between 400 and 599 and a literal public message",
      );
    }
    entries.set(code, { code, status: entry.value.status, message: entry.value.message });
  }
  if (entries.size === 0) {
    return yield* invalidEntry(`${prefix.value}.*`, "the catalog declares no entries");
  }
  return new ErrorCatalog<Entries>(prefix.value, entries);
});
