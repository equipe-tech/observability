import { readFile } from "node:fs/promises";
import { assert, describe, it } from "vite-plus/test";
import * as Browser from "../src/browser/index.ts";
import * as BrowserClient from "../src/browser/client.ts";
import * as Root from "../src/index.ts";

const auditApiNames = Object.keys(Root).filter((name) => name.toLowerCase().includes("audit"));
const auditBarrel = await readFile(new URL("../src/audit/index.ts", import.meta.url), "utf8");

describe("audit exports", () => {
  it("keeps internal audit helpers outside the public API", () => {
    assert.notInclude(auditBarrel, "export *");
    assert.notProperty(Root, "encodeAuditOutboxDocument");
    assert.notProperty(Root, "isControlCharacterFree");
    assert.notProperty(Root, "auditCommitDocumentFor");
    assert.notProperty(Root, "reparseAuditRecord");
    assert.isFunction(Root.parseAuditRecord);
    assert.isFunction(Root.commitAuditRecord);
    assert.isFunction(Root.drainAuditOutbox);
  });

  it("keeps the audit API out of browser source entrypoints", () => {
    assert.isAbove(auditApiNames.length, 0);
    for (const name of auditApiNames) {
      assert.notProperty(Browser, name);
      assert.notProperty(BrowserClient, name);
    }
  });
});
