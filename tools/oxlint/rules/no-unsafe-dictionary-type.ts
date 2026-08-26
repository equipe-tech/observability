import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type UnsafeValue = "any" | "empty-object" | "object" | "union" | "unknown";

type TypeEnvironment = {
  readonly aliases: ReadonlyMap<string, ESTree.TSTypeAliasDeclaration>;
  readonly interfaces: ReadonlyMap<string, ReadonlyArray<ESTree.TSInterfaceDeclaration>>;
};

function unwrapType(type: ESTree.TSType): ESTree.TSType {
  let current = type;
  while (
    current.type === "TSParenthesizedType" ||
    (current.type === "TSTypeOperator" && current.operator === "readonly")
  ) {
    current = current.typeAnnotation;
  }
  return current;
}

function referenceName(type: ESTree.TSTypeReference): string | null {
  return type.typeName.type === "Identifier" ? type.typeName.name : null;
}

function unsafeValue(
  type: ESTree.TSType,
  environment: TypeEnvironment,
  visited = new Set<string>(),
): UnsafeValue | null {
  const current = unwrapType(type);
  if (current.type === "TSUnknownKeyword") {
    return "unknown";
  }
  if (current.type === "TSAnyKeyword") {
    return "any";
  }
  if (current.type === "TSObjectKeyword") {
    return "object";
  }
  if (current.type === "TSTypeLiteral" && current.members.length === 0) {
    return "empty-object";
  }
  if (current.type === "TSUnionType") {
    return current.types.some((member) => unsafeValue(member, environment, visited) !== null)
      ? "union"
      : null;
  }
  if (current.type === "TSIntersectionType") {
    const members = current.types.map((member) => unsafeValue(member, environment, visited));
    if (members.includes("any")) {
      return "any";
    }
    return members.length > 0 && members.every((member) => member !== null)
      ? (members[0] ?? null)
      : null;
  }
  if (current.type !== "TSTypeReference") {
    return null;
  }
  const name = referenceName(current);
  if (name === null) {
    return null;
  }
  if (["NonNullable", "Partial", "Readonly", "Required"].includes(name)) {
    const wrapped = current.typeArguments?.params[0];
    return wrapped === undefined ? null : unsafeValue(wrapped, environment, visited);
  }
  const declarations = environment.interfaces.get(name);
  if (
    declarations !== undefined &&
    declarations.length === 1 &&
    declarations[0]?.extends.length === 0 &&
    declarations[0].body.body.length === 0
  ) {
    return "empty-object";
  }
  if (visited.has(name)) {
    return null;
  }
  const alias = environment.aliases.get(name);
  if (
    alias === undefined ||
    (alias.typeParameters !== null && alias.typeParameters !== undefined) ||
    (current.typeArguments !== null &&
      current.typeArguments !== undefined &&
      current.typeArguments.params.length > 0)
  ) {
    return null;
  }
  const nextVisited = new Set(visited);
  nextVisited.add(name);
  return unsafeValue(alias.typeAnnotation, environment, nextVisited);
}

export const noUnsafeDictionaryTypeRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow index and mapped type contracts whose value type is unknown, any, object, an empty object, or an alias containing one.",
    },
    messages: {
      unsafeDictionary:
        "This dictionary's {{value}} value type gives callers no concrete value contract. Use an owner or schema-derived value type, and parse external payloads before insertion.",
    },
  },
  createOnce(context) {
    const aliases = new Map<string, ESTree.TSTypeAliasDeclaration>();
    const interfaces = new Map<string, Array<ESTree.TSInterfaceDeclaration>>();
    let environment: TypeEnvironment = { aliases, interfaces };

    const reportValue = (node: ESTree.Node, type: ESTree.TSType) => {
      const value = unsafeValue(type, environment);
      if (value !== null) {
        context.report({ node, messageId: "unsafeDictionary", data: { value } });
      }
    };

    return {
      Program(node) {
        aliases.clear();
        interfaces.clear();
        for (const statement of node.body) {
          const declaration =
            statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
          if (declaration?.type === "TSTypeAliasDeclaration") {
            aliases.set(declaration.id.name, declaration);
          }
          if (declaration?.type === "TSInterfaceDeclaration") {
            const declarations = interfaces.get(declaration.id.name) ?? [];
            declarations.push(declaration);
            interfaces.set(declaration.id.name, declarations);
          }
        }
        environment = { aliases, interfaces };
      },
      TSIndexSignature(node) {
        if (node.typeAnnotation !== null) {
          reportValue(node, node.typeAnnotation.typeAnnotation);
        }
      },
      TSMappedType(node) {
        if (node.typeAnnotation !== null) {
          reportValue(node, node.typeAnnotation);
        }
      },
    };
  },
});
