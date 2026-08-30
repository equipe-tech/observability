import { readFile } from "node:fs/promises";
import { assert, describe, it } from "vite-plus/test";
import * as Policy from "../src/policy/index.ts";
import * as Profile from "../src/profile/index.ts";

const profileSource = await readFile(new URL("../src/profile/index.ts", import.meta.url), "utf8");

describe("policy exports", () => {
  it("keeps policy ownership canonical and internal vocabulary private", () => {
    const policyKeys = Object.keys(Policy);
    const profileKeys = Object.keys(Profile);
    for (const name of ["CurrentDataPolicy", "baseDataPolicy", "definePolicy", "parseDataPolicy"]) {
      assert.include(policyKeys, name);
      assert.notInclude(profileKeys, name);
    }
    assert.notInclude(profileSource, "DataPolicy");
    assert.notInclude(profileSource, "DataPolicyInput");
    assert.notInclude(policyKeys, "baseBlockedKeyPatternSource");
    assert.notInclude(policyKeys, "baseBlockedValuePatterns");
    assert.notInclude(policyKeys, "effectDroppedAttributesKey");
  });
});
