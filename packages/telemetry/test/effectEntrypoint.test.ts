import { assert, describe, it } from "vite-plus/test";
import * as EffectEntrypoint from "../src/effect/index.ts";
import * as Root from "../src/index.ts";

describe("Effect entrypoint", () => {
  it("contains the wide event API without leaking it through the root", () => {
    assert.notProperty(Root, "WideEvent");
    assert.notProperty(Root, "layerWideEvent");
    assert.isFunction(EffectEntrypoint.WideEvent.emit);
    assert.ok(EffectEntrypoint.layerWideEvent);
  });
});
