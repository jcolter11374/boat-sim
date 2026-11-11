import { test } from "node:test";
import assert from "node:assert/strict";
import { mirrorStrength } from "../src/mirror";

test("the sea mirrors when calm, a little in a chop, not at all in open-ocean waves", () => {
  assert.equal(mirrorStrength(0.02), 1);
  assert.ok(mirrorStrength(0.15) > 0.8, "a calm harbour");
  const chop = mirrorStrength(0.4);
  assert.ok(chop > 0.15 && chop < 0.5, `a 0.4 m chop ${chop}`);
  assert.equal(mirrorStrength(1.5), 0, "open ocean: the extra pass is skipped");
  for (let h = 0; h < 1; h += 0.05) assert.ok(mirrorStrength(h + 0.05) <= mirrorStrength(h), "never stronger in bigger waves");
});
