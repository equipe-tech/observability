import assert from "node:assert/strict";
import { describe, it } from "bun:test";
import {
  declarationReferences,
  declarationReferenceViolations,
  isSourcePathReference,
} from "../scripts/declaration-references.ts";

describe("packed declaration references", () => {
  it("extracts module, type, and path references", () => {
    assert.deepEqual(
      declarationReferences(
        [
          'import type { Effect } from "effect";',
          'type Service = import("@equipe-tech/service").Service;',
          'import Runtime = require("runtime-package");',
          '/// <reference types="node" />',
          '/// <reference path="../src/private.d.ts" />',
        ].join("\n"),
      ),
      [
        { kind: "module", specifier: "effect" },
        { kind: "module", specifier: "@equipe-tech/service" },
        { kind: "module", specifier: "runtime-package" },
        { kind: "types", specifier: "node" },
        { kind: "path", specifier: "../src/private.d.ts" },
      ],
    );
  });

  it("rejects undeclared type references and source path references", () => {
    assert.deepEqual(
      declarationReferenceViolations(
        [
          '/// <reference types="undeclared-types" />',
          '/// <reference types="declared-types" />',
          '/// <reference path="../src/private.d.ts" />',
          'export type { Value } from "declared-package";',
        ].join("\n"),
        new Set(["declared-types", "declared-package"]),
      ),
      [
        { kind: "undeclared", specifier: "undeclared-types" },
        { kind: "source-path", specifier: "../src/private.d.ts" },
      ],
    );
  });

  it("classifies relative and absolute source references", () => {
    for (const specifier of [
      "../src/private.d.ts",
      "../../packages/core/index.d.ts",
      "/workspace/core.d.ts",
      "C:\\workspace\\core.d.ts",
      "./private.ts",
    ]) {
      assert.equal(isSourcePathReference(specifier), true);
    }
    assert.equal(isSourcePathReference("./ambient.generated"), false);
  });
});
