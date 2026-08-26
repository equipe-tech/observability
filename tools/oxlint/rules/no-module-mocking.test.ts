import { RuleTester } from "oxlint/plugins-dev";
import { test } from "vite-plus/test";
import { noModuleMockingRule } from "./no-module-mocking.ts";

const error = { messageId: "moduleMock" };

test("rejects Vitest and Jest module mocking without matching shadowed objects", () => {
  new RuleTester().run("no-module-mocking", noModuleMockingRule, {
    valid: [
      "const vi = testDouble; vi.mock('./store.ts');",
      "const jest = testDouble; jest.mock('./store.ts');",
      "vi.spyOn(store, 'load');",
      "mockStore.load();",
    ],
    invalid: [
      { code: "vi.mock('./store.ts');", errors: [error], output: null },
      { code: "jest.mock('./store.ts');", errors: [error], output: null },
      { code: "vi['doMock']('./store.ts');", errors: [error], output: null },
      {
        code: "import { vi as testApi } from 'vitest'; testApi.mock('./store.ts');",
        errors: [error],
        output: null,
      },
      {
        code: "import { jest } from '@jest/globals'; jest.unstable_mockModule('./store.ts');",
        errors: [error],
        output: null,
      },
    ],
  });
});
