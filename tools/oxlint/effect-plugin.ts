import { definePlugin } from "@oxlint/plugins";
import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";

const effectPlugin = definePlugin({
  meta: { name: "effect" },
  rules: {
    "no-service-constructor-imports": noServiceConstructorImportsRule,
  },
});

export default effectPlugin;
