import { defineErrorCatalog } from "evlog";
import { assert, describe, it } from "vite-plus/test";
import {
  NestErrorBoundaryModule,
  type ErrorCatalogReference,
  type NestErrorBoundaryOptions,
} from "../src/index.ts";

const catalog = defineErrorCatalog("typed_catalog", {
  INSUFFICIENT_FUNDS: {
    status: 402,
    message: ({ available, required }: { available: number; required: number }) =>
      `Insufficient funds: ${String(available)}/${String(required)}`,
    why: "The account balance is too low.",
    fix: "Add funds and retry.",
    link: "https://example.test/funds",
    tags: ["billing"],
    internal: { owner: "payments" },
  },
});

const catalogReference: ErrorCatalogReference = catalog;
const options: NestErrorBoundaryOptions<typeof catalog> = {
  catalog,
  recordDefect: () => undefined,
};

describe("Nest error catalog type contract", () => {
  it("accepts the catalog value returned by defineErrorCatalog", () => {
    assert.strictEqual(catalogReference._prefix, "typed_catalog");
    assert.isDefined(NestErrorBoundaryModule.forRoot(options));
  });
});
