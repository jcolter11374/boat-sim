import { test } from "node:test";
import assert from "node:assert/strict";
import { PERSONAL_BEST_KEY, bestId, bestWords, loadPersonalBest, savePersonalBest, tidyBests, toBeatWords } from "../src/helm/personalBest.ts";

const box = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const DAY = { launch: "2020-04-23T00:00:00", breakdowns: true };

test("each launch day, start and breakdowns setting has its own best", () => {
  assert.equal(bestId(DAY), "2020-04-23");
  assert.equal(bestId({ ...DAY, port: "" }), "2020-04-23");
  assert.equal(bestId({ ...DAY, port: "new york!" }), "2020-04-23_newyork");
  assert.equal(bestId({ ...DAY, breakdowns: false }), "2020-04-23_easy");
  assert.equal(bestId({ launch: "0", breakdowns: true }), null);
});

test("the first finish is the time to beat, a faster one replaces it, a slower one only counts", () => {
  const s = box();
  const a = savePersonalBest(DAY, { finished: true, days: 73.8 }, { boat: "Our kayak", at: "2026-11-21T08:00:00Z" }, s);
  assert.equal(a.isBest, true);
  assert.equal(a.before, null);
  assert.equal(bestWords(a, { finished: true, days: 73.8 }), "Your first finish from this launch day: 73.8 days is now your time to beat.");
  const b = savePersonalBest(DAY, { finished: true, days: 75.9 }, { boat: "Petrel" }, s);
  assert.equal(b.isBest, false);
  assert.deepEqual(b.now, { days: 73.8, boat: "Our kayak", at: "2026-11-21T08:00:00Z", finishes: 2 });
  assert.equal(bestWords(b, { finished: true, days: 75.9 }), "2.1 days off your personal best of 73.8 days from this launch day.");
  const c = savePersonalBest(DAY, { finished: true, days: 71.7 }, { boat: "Petrel", at: "2026-11-22T08:00:00Z" }, s);
  assert.equal(c.isBest, true);
  assert.equal(bestWords(c, { finished: true, days: 71.7 }), "A new personal best: 2.1 days faster than your old best of 73.8 days.");
  assert.deepEqual(loadPersonalBest(DAY, s), { days: 71.7, boat: "Petrel", at: "2026-11-22T08:00:00Z", finishes: 3 });
  assert.equal(toBeatWords(loadPersonalBest(DAY, s)!), "Your best from this launch day is 71.7 days. That's the time to beat.");
  // Another day, or the same day with breakdowns off, starts afresh.
  assert.equal(loadPersonalBest({ ...DAY, launch: "2020-06-01" }, s), null);
  assert.equal(loadPersonalBest({ ...DAY, breakdowns: false }, s), null);
});

test("a crossing that didn't finish changes nothing, and says so only if there is a best", () => {
  const s = box();
  const lost = savePersonalBest(DAY, { finished: false, days: 12 }, {}, s);
  assert.equal(lost.isBest, false);
  assert.equal(bestWords(lost, { finished: false, days: 12 }), "");
  assert.equal(s.m.size, 0);
  savePersonalBest(DAY, { finished: true, days: 80 }, {}, s);
  const again = savePersonalBest(DAY, { finished: false, days: 3 }, {}, s);
  assert.equal(again.now?.finishes, 1);
  assert.equal(bestWords(again, { finished: false, days: 3 }), "Your best from this launch day is still 80.0 days.");
});

test("a near tie reads as level, and a small win is never '0.0 days faster'", () => {
  const s = box();
  savePersonalBest(DAY, { finished: true, days: 70.0 }, {}, s);
  const tie = savePersonalBest(DAY, { finished: true, days: 70.02 }, {}, s);
  assert.equal(bestWords(tie, { finished: true, days: 70.02 }), "Level with your personal best of 70.0 days from this launch day.");
  const win = savePersonalBest(DAY, { finished: true, days: 69.98 }, {}, s);
  assert.equal(bestWords(win, { finished: true, days: 69.98 }), "A new personal best: 0.1 days faster than your old best of 70.0 days.");
});

test("nothing odd is kept or read back", () => {
  const s = box();
  assert.equal(savePersonalBest({ launch: "nonsense", breakdowns: true }, { finished: true, days: 5 }, {}, s).now, null);
  assert.equal(savePersonalBest(DAY, { finished: true, days: Number.NaN }, {}, s).now, null);
  assert.equal(savePersonalBest(DAY, { finished: true, days: -1 }, {}, s).now, null);
  assert.equal(s.m.size, 0);
  s.setItem(PERSONAL_BEST_KEY, "{not json");
  assert.equal(loadPersonalBest(DAY, s), null);
  assert.deepEqual(tidyBests({ "2020-04-23": { days: 70, boat: 5, at: "x", finishes: 0 }, "../x": { days: 1 }, bad: { days: "soon" }, worse: null }), {
    "2020-04-23": { days: 70, boat: "", at: "", finishes: 1 },
  });
});

test("with storage off, this page still remembers", () => {
  const off = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  savePersonalBest({ launch: "2021-05-05", breakdowns: true }, { finished: true, days: 66 }, {}, off);
  assert.equal(loadPersonalBest({ launch: "2021-05-05", breakdowns: true }, off)?.days, 66);
  // A save that stores again clears the fallback.
  const s = box();
  savePersonalBest(DAY, { finished: true, days: 70 }, {}, s);
  assert.equal(loadPersonalBest({ launch: "2021-05-05", breakdowns: true }, s)?.days, 66);
});
