import { definePlugin } from "@oxlint/plugins";
import { noChainedTypeAssertionsRule } from "./rules/no-chained-type-assertions.ts";
import { noConditionalEmptyObjectSpreadRule } from "./rules/no-conditional-empty-object-spread.ts";
import { noObjectParametersRule } from "./rules/no-object-parameters.ts";
import { noRecordTypeRule } from "./rules/no-record-type.ts";
import { noRuntimeTypeofRule } from "./rules/no-runtime-typeof.ts";
import { noForbiddenTermInSymbolNamesRule } from "./rules/no-shape-in-symbol-names.ts";
import { noUnknownParametersRule } from "./rules/no-unknown-parameters.ts";
import { noUnknownTypeAliasesRule } from "./rules/no-unknown-type-aliases.ts";

const antiSlopPlugin = definePlugin({
  meta: { name: "anti-slop" },
  rules: {
    "no-chained-type-assertions": noChainedTypeAssertionsRule,
    "no-conditional-empty-object-spread": noConditionalEmptyObjectSpreadRule,
    "no-object-parameters": noObjectParametersRule,
    "no-record-type": noRecordTypeRule,
    "no-runtime-typeof": noRuntimeTypeofRule,
    "no-shape-in-symbol-names": noForbiddenTermInSymbolNamesRule,
    "no-unknown-parameters": noUnknownParametersRule,
    "no-unknown-type-aliases": noUnknownTypeAliasesRule,
  },
});

export default antiSlopPlugin;
