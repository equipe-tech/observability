import { defineRule } from "@oxlint/plugins";

export const noRecordTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the TypeScript Record utility type in favor of owner-provided or schema-derived types.",
    },
    messages: {
      recordType:
        "`Record` erases the meaning and provenance of this data shape. Model the fields as a named domain type, and parse external data into it at the I/O boundary where it originates.",
    },
  },
  create(context) {
    return {
      TSTypeReference(node) {
        if (node.typeName.type === "Identifier" && node.typeName.name === "Record") {
          context.report({ node, messageId: "recordType" });
        }
      },
    };
  },
});
