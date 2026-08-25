import { definePlugin } from "@oxlint/plugins";
import { noAmbientEnvReadRule } from "./rules/no-ambient-env-read.ts";
import { noBareErrorRule } from "./rules/no-bare-error.ts";
import { noServiceConstructorImportsRule } from "./rules/no-service-constructor-imports.ts";
import { requireFetchAbortSignalRule } from "./rules/require-fetch-abort-signal.ts";
import { taggedErrorRequiresMessageRule } from "./rules/tagged-error-requires-message.ts";

const effectPlugin = definePlugin({
  meta: { name: "effect" },
  rules: {
    "no-ambient-env-read": noAmbientEnvReadRule,
    "no-bare-error": noBareErrorRule,
    "no-service-constructor-imports": noServiceConstructorImportsRule,
    "require-fetch-abort-signal": requireFetchAbortSignalRule,
    "tagged-error-requires-message": taggedErrorRequiresMessageRule,
  },
});

export default effectPlugin;
