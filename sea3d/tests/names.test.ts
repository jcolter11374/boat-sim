import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { internalWords, nameOf, namesFrom, type GridIndex } from "../src/names";
import { bestHeadline } from "../src/boardwords";

const index = JSON.parse(readFileSync(new URL("../public/boatyard/index.json", import.meta.url), "utf8")) as GridIndex;

test("no build name on screen shows an internal word (Leo, audit item 9)", () => {
  for (const b of index.builds) {
    assert.deepEqual(internalWords(b.label, index.slots), [], b.label);
    assert.ok(b.label.length <= 60, b.label);
  }
});

test("internalWords catches what the old names showed", () => {
  const s = index.slots;
  assert.deepEqual(internalWords("Our kayak, Solar panels: solar-300, Batteries: two-100ah", s).sort(), ["Solar panels: solar-300", "solar-300", "two-100ah"].sort());
  assert.ok(internalWords("25 W cruise, Drive: hybrid", s).length > 0);
  assert.ok(internalWords("Randolph's Rev C as built (our model)", s).length > 0);
  assert.ok(internalWords("ROUGH", s).length > 0);
  assert.deepEqual(internalWords("Our kayak, bigger panels and batteries", s), []);
  assert.deepEqual(internalWords("Our kayak + wing sail", s), []);
});

test("the leaderboard takes the grid's name over a board's old label", () => {
  const names = namesFrom(index);
  assert.equal(nameOf(names, "k-p25-drive.hybrid", "25 W cruise, Drive: hybrid").label, "Our kayak + wing sail");
  assert.match(nameOf(names, "revc", "Randolph Rev C as published (our model)").note ?? "", /^Our model of/);
  assert.equal(nameOf(names, "not-on-grid", "Something else").label, "Something else");
  // The sample board the smoke test uses: every row gets a clean name.
  const sample = JSON.parse(readFileSync(new URL("../public/leaderboard-sample/board.json", import.meta.url), "utf8"));
  for (const r of sample.summary.rows) assert.deepEqual(internalWords(nameOf(names, r.design, r.label).label, index.slots), [], r.design);
});

test("the headline answers who's best", () => {
  const top = [
    { label: "Our kayak + wing sail", finish_rate: 0.85 },
    { label: "Our kayak", finish_rate: 0.83 },
    { label: "Our kayak, bigger panels and batteries", finish_rate: 0.83 },
    { label: "Our kayak, motors turned up (30 W)", finish_rate: 0.83 },
    { label: "Our kayak, motors turned down (20 W)", finish_rate: 0.82 },
  ];
  assert.equal(bestHeadline(top, 3), "Best: our kayak + wing sail and 4 others, about 83 % finish.");
  assert.equal(bestHeadline(top.slice(1, 2), 3), "Best: our kayak, about 83 % finish.");
  assert.equal(bestHeadline(top, 1), "Too close to call: every build finishes about 83 % of the time.");
  assert.equal(bestHeadline([], 2), "");
});
