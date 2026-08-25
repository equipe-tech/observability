import { definePlugin } from "@oxlint/plugins";
import { noAsyncContextEnterWithRule } from "./rules/no-async-context-enter-with.ts";
import { noForeignDirectiveRule } from "./rules/no-foreign-directive.ts";
import { noVacuousThrowAssertionRule } from "./rules/no-vacuous-throw-assertion.ts";
import { noVoidOperatorRule } from "./rules/no-void-operator.ts";
import { requireSuppressionReasonRule } from "./rules/require-suppression-reason.ts";

const hygienePlugin = definePlugin({
  meta: { name: "hygiene" },
  rules: {
    "no-async-context-enter-with": noAsyncContextEnterWithRule,
    "no-foreign-directive": noForeignDirectiveRule,
    "no-vacuous-throw-assertion": noVacuousThrowAssertionRule,
    "no-void-operator": noVoidOperatorRule,
    "require-suppression-reason": requireSuppressionReasonRule,
  },
});

export default hygienePlugin;
