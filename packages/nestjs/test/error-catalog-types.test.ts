import { defineErrorCatalog } from "evlog";
import { assert, describe, it } from "vite-plus/test";
import {
  NestErrorBoundary,
  NestErrorBoundaryModule,
  type ErrorCatalogReference,
  type NestErrorBoundaryOptions,
} from "../src/index.ts";

const catalog = defineErrorCatalog("typed_catalog", {
  PAYMENT_REQUIRED: {
    status: 402,
    message: "Payment is required.",
    why: "The account balance is too low.",
    fix: "Add funds and retry.",
    link: "https://example.test/funds",
    tags: ["billing"],
    internal: { owner: "payments" },
  },
});

const templatedCatalog = defineErrorCatalog("templated_catalog", {
  INSUFFICIENT_FUNDS: {
    status: 402,
    message: ({ available, required }: { available: number; required: number }) =>
      `Insufficient funds: ${String(available)}/${String(required)}`,
  },
});

type TemplatedCatalogOption = NestErrorBoundaryOptions<typeof templatedCatalog>["catalog"];
type TemplatedMessageCompatibility = TemplatedCatalogOption["INSUFFICIENT_FUNDS"];
type IsNever<Value> = [Value] extends [never] ? true : false;
type CatalogConstrainedBoundaryConstructor = abstract new <Catalog extends ErrorCatalogReference>(
  options: NestErrorBoundaryOptions<Catalog>,
) => NestErrorBoundary;

const catalogReference: ErrorCatalogReference = catalog;
const options: NestErrorBoundaryOptions<typeof catalog> = {
  catalog,
  recordDefect: () => undefined,
};

describe("Nest error catalog type contract", () => {
  it("accepts literal-message catalogs and rejects templated catalogs", () => {
    const templatedMessagesAreRejected: IsNever<TemplatedMessageCompatibility> = true;
    assert.isTrue(templatedMessagesAreRejected);
    assert.strictEqual(catalogReference._prefix, "typed_catalog");
    assert.isDefined(NestErrorBoundaryModule.forRoot(options));
  });

  it("applies the literal-message constraint to the exported constructor", () => {
    const constructorConstrainsCatalog: typeof NestErrorBoundary extends CatalogConstrainedBoundaryConstructor
      ? true
      : false = true;
    assert.isTrue(constructorConstrainsCatalog);
  });
});
