import { test } from "node:test";
import assert from "node:assert/strict";
import { CHALLENGE_BEST_KEY, betterRun, loadChallengeBests, runWords, saveChallengeRun, starsWord, tidyBests } from "../src/helm/challengeBest.ts";

const box = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};

test("a better try: more stars, then finishing, then fewer days (or lasting longer when lost)", () => {
  assert.ok(betterRun({ stars: 2, finished: false, days: 3 }, { stars: 1, finished: true, days: 2 }));
  assert.ok(betterRun({ stars: 1, finished: true, days: 9 }, { stars: 1, finished: false, days: 5 }));
  assert.ok(betterRun({ stars: null, finished: true, days: 40 }, { stars: null, finished: true, days: 41 }));
  assert.ok(betterRun({ stars: null, finished: false, days: 9 }, { stars: null, finished: false, days: 4 }));
  assert.ok(!betterRun({ stars: 1, finished: true, days: 6 }, { stars: 1, finished: true, days: 6 }));
});

test("a challenge's first try is kept, a worse one only counts, a better one replaces it", () => {
  const s = box();
  const a = saveChallengeRun("sandy", { stars: 1, finished: true, days: 6 }, { boat: "Our kayak", autopilot: { stars: 0, finished: true, days: 6 }, at: "2026-11-13T08:00:00Z" }, s);
  assert.equal(a.isBest, true);
  const b = saveChallengeRun("sandy", { stars: 0, finished: false, days: 2 }, { boat: "Other" }, s);
  assert.equal(b.isBest, false);
  assert.deepEqual(b.kept, { best: { stars: 1, finished: true, days: 6 }, boat: "Our kayak", at: "2026-11-13T08:00:00Z", autopilot: { stars: 0, finished: true, days: 6 }, tries: 2 });
  const c = saveChallengeRun("sandy", { stars: 3, finished: true, days: 6 }, { boat: "Petrel", at: "2026-11-13T09:00:00Z" }, s);
  assert.equal(c.isBest, true);
  assert.equal(loadChallengeBests(s).sandy.boat, "Petrel");
  assert.equal(loadChallengeBests(s).sandy.tries, 3);
  assert.equal(loadChallengeBests(s).sandy.autopilot, null);
  saveChallengeRun("gentle-june", { stars: null, finished: true, days: 41.2 }, {}, s);
  assert.deepEqual(Object.keys(loadChallengeBests(s)).sort(), ["gentle-june", "sandy"]);
});

test("nothing odd is kept or read back: bad ids, bad numbers and other people's data are dropped", () => {
  const s = box();
  assert.equal(saveChallengeRun("../x", { stars: 1, finished: true, days: 1 }, {}, s).kept, null);
  assert.equal(saveChallengeRun("ok", { stars: 7, finished: true, days: 1 }, {}, s).kept, null);
  assert.equal(saveChallengeRun("ok", { stars: 1, finished: true, days: Number.NaN }, {}, s).kept, null);
  assert.equal(s.m.size, 0);
  s.setItem(CHALLENGE_BEST_KEY, "{not json");
  assert.deepEqual(loadChallengeBests(s), {});
  const t = tidyBests({ a: { best: { stars: 2, finished: true, days: 5 }, boat: "x".repeat(200), at: "never", tries: -4 }, b: { best: { days: "soon" } }, "<img>": { best: { stars: 1, finished: true, days: 1 } }, c: 4 });
  assert.deepEqual(Object.keys(t), ["a"]);
  assert.equal(t.a.boat.length, 60);
  assert.equal(t.a.at, "");
  assert.equal(t.a.tries, 1);
});

test("with storage off or full, the try still counts for this page and nothing throws", () => {
  const full = { getItem: () => null, setItem: () => { throw new Error("full"); }, removeItem: () => {} };
  const r = saveChallengeRun("spring-gale", { stars: null, finished: false, days: 3.9 }, {}, full);
  assert.equal(r.isBest, true);
  assert.equal(loadChallengeBests(null)["spring-gale"].best.days, 3.9);
});

test("a kept try in plain words", () => {
  assert.equal(starsWord(2), "★★☆");
  assert.equal(starsWord(null), "");
  assert.equal(runWords({ stars: 2, finished: true, days: 6 }), "★★☆ in 6.0 days");
  assert.equal(runWords({ stars: 0, finished: false, days: 3.94 }), "☆☆☆ · lost on day 3.9");
  assert.equal(runWords({ stars: null, finished: true, days: 41.23 }), "Finished in 41.2 days");
  assert.equal(runWords({ stars: null, finished: false, days: 3.9 }), "Lost on day 3.9");
});
