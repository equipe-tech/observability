import { defineRule } from "@oxlint/plugins";
import type { Context, ESTree } from "@oxlint/plugins";

function reportForbiddenName(context: Context, node: ESTree.Node, name: string): void {
  if (!name.toLowerCase().includes("shape")) {
    return;
  }
  context.report({ node, messageId: "forbiddenTerm", data: { name } });
}

function reportPropertyKey(context: Context, key: ESTree.PropertyKey): void {
  if (key.type === "Identifier" || key.type === "PrivateIdentifier") {
    reportForbiddenName(context, key, key.name);
  }
}

function reportBinding(
  context: Context,
  pattern: ESTree.ParamPattern | ESTree.BindingPattern,
): void {
  if (pattern.type === "TSParameterProperty") {
    reportBinding(context, pattern.parameter);
    return;
  }
  if (pattern.type === "Identifier") {
    reportForbiddenName(context, pattern, pattern.name);
    return;
  }
  if (pattern.type === "AssignmentPattern") {
    reportBinding(context, pattern.left);
    return;
  }
  if (pattern.type === "RestElement") {
    reportBinding(context, pattern.argument);
    return;
  }
  if (pattern.type === "ArrayPattern") {
    for (const element of pattern.elements) {
      if (element !== null) {
        reportBinding(context, element);
      }
    }
    return;
  }
  for (const property of pattern.properties) {
    reportBinding(context, property.type === "RestElement" ? property.argument : property.value);
  }
}

function reportParameters(context: Context, parameters: ReadonlyArray<ESTree.ParamPattern>): void {
  for (const parameter of parameters) {
    reportBinding(context, parameter);
  }
}

function reportFunctionBindings(
  context: Context,
  node: ESTree.ArrowFunctionExpression | ESTree.Function,
): void {
  if ("id" in node && node.id !== null) {
    reportForbiddenName(context, node.id, node.id.name);
  }
  reportParameters(context, node.params);
}

export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in declared JavaScript and TypeScript symbol names.',
    },
    messages: {
      forbiddenTerm:
        '`{{name}}` names a structure, not a concept. "Shape" hides what the data means, so name the domain concept instead.',
    },
  },
  createOnce(context) {
    return {
      VariableDeclarator(node) {
        reportBinding(context, node.id);
      },
      ArrowFunctionExpression(node) {
        reportFunctionBindings(context, node);
      },
      FunctionDeclaration(node) {
        reportFunctionBindings(context, node);
      },
      FunctionExpression(node) {
        reportFunctionBindings(context, node);
      },
      ClassDeclaration(node) {
        if (node.id !== null) {
          reportForbiddenName(context, node.id, node.id.name);
        }
      },
      ClassExpression(node) {
        if (node.id !== null) {
          reportForbiddenName(context, node.id, node.id.name);
        }
      },
      ImportDefaultSpecifier(node) {
        reportForbiddenName(context, node.local, node.local.name);
      },
      ImportNamespaceSpecifier(node) {
        reportForbiddenName(context, node.local, node.local.name);
      },
      ImportSpecifier(node) {
        reportForbiddenName(context, node.local, node.local.name);
      },
      CatchClause(node) {
        if (node.param !== null) {
          reportBinding(context, node.param);
        }
      },
      TSTypeAliasDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      TSInterfaceDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      TSEnumDeclaration(node) {
        reportForbiddenName(context, node.id, node.id.name);
      },
      TSTypeParameter(node) {
        reportForbiddenName(context, node.name, node.name.name);
      },
      PropertyDefinition(node) {
        reportPropertyKey(context, node.key);
      },
      AccessorProperty(node) {
        reportPropertyKey(context, node.key);
      },
      MethodDefinition(node) {
        reportPropertyKey(context, node.key);
      },
      TSAbstractMethodDefinition(node) {
        reportPropertyKey(context, node.key);
      },
      TSPropertySignature(node) {
        reportPropertyKey(context, node.key);
      },
      TSMethodSignature(node) {
        reportPropertyKey(context, node.key);
        reportParameters(context, node.params);
      },
      TSCallSignatureDeclaration(node) {
        reportParameters(context, node.params);
      },
      TSConstructSignatureDeclaration(node) {
        reportParameters(context, node.params);
      },
      TSConstructorType(node) {
        reportParameters(context, node.params);
      },
      TSDeclareFunction(node) {
        reportFunctionBindings(context, node);
      },
      TSEmptyBodyFunctionExpression(node) {
        reportFunctionBindings(context, node);
      },
      TSFunctionType(node) {
        reportParameters(context, node.params);
      },
      Property(node) {
        if (node.parent.type === "ObjectPattern" && node.shorthand) {
          return;
        }
        reportPropertyKey(context, node.key);
      },
    };
  },
});
