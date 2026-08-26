import type { ESTree } from "@oxlint/plugins";

function addTypeParameters(node: ESTree.Node, names: Set<string>): void {
  if (!("typeParameters" in node)) {
    return;
  }
  for (const parameter of node.typeParameters?.params ?? []) {
    names.add(parameter.name.name);
  }
}

export function lexicalTypeParameterNames(node: ESTree.Node): ReadonlySet<string> {
  const names = new Set<string>();
  let descendant: ESTree.Node = node;
  let current: ESTree.Node | null = node;
  while (current !== null && current.type !== "Program") {
    addTypeParameters(current, names);
    if (
      current.type === "TSMappedType" &&
      (descendant === current.nameType || descendant === current.typeAnnotation)
    ) {
      names.add(current.key.name);
    }
    if (
      current.type === "TSConditionalType" &&
      descendant === current.trueType &&
      current.extendsType.type === "TSInferType"
    ) {
      names.add(current.extendsType.typeParameter.name.name);
    }
    descendant = current;
    current = current.parent;
  }
  return names;
}
