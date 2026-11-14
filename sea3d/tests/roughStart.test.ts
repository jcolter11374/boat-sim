import { test } from "node:test";
import assert from "node:assert/strict";
import { knockdownNote, roughStartLine } from "../src/helm/roughStart.ts";

test("the Set sail card warns of a rough start only on the days that have one (Elena, 14 Nov)", () => {
  assert.equal(roughStartLine("2020-04-01"), "Rough start: waves of 5 m at the drop. She may be knocked flat in the first hours.");
  assert.equal(roughStartLine("2020-05-01"), "Rough start: waves of 4 m at the drop. She may be knocked flat in the first hours.");
  assert.equal(roughStartLine("2020-04-23"), "");
  assert.equal(roughStartLine("2020-06-15"), "");
  assert.equal(roughStartLine(null), "");
});

test("a knockdown just after the drop says so, and \"came back upright\" only if she did", () => {
  assert.equal(knockdownNote(0.2, 1, "4.3", false), "Knocked flat by a breaking wave just after the drop (waves 4.3 m). She came back upright.");
  assert.equal(knockdownNote(3, 2, "4.5", false), "Knocked flat twice by a breaking wave just after the drop (waves 4.5 m). She came back upright.");
  assert.equal(knockdownNote(0.2, 1, "4.3", true), "Knocked flat by a breaking wave just after the drop (waves 4.3 m).");
  assert.equal(knockdownNote(60, 1, "5.4", false), "Knocked flat by a breaking wave, waves 5.4 m", "later: the words as before");
});
