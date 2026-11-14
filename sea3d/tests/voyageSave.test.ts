import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REAL_TIME,
  VOYAGE_KEY,
  VOYAGE_VERSION,
  clearVoyage,
  continueLink,
  endWords,
  loadVoyage,
  madeBy,
  offerWords,
  welcomeBack,
  packVoyage,
  sameOrder,
  parseVoyage,
  saveVoyage,
  worthSaving,
} from "../src/helm/voyageSave.ts";
import type { StorageLike } from "../src/myboat.ts";

function fakeStore(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}
const broken: StorageLike = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

const CODE = "eNqrVipTslIyUtJRKlayMjTQUcpXsjI01lEqULIyNDI2BQBvqQYd"; // the shape of a simulator code
const WHEN = new Date("2026-11-13T04:00:00Z");
const now = { code: CODE, challenge: "", boat: "Kayak", day: 12.4375, toGoKm: 4100.6, rate: 6, sim: "abc123" };

test("a voyage packs to a versioned record, rounded, with the real time it was saved", () => {
  const v = packVoyage(now, WHEN)!;
  assert.deepEqual(v, {
    v: VOYAGE_VERSION,
    code: CODE,
    challenge: "",
    boat: "Kayak",
    day: 12.44,
    left: null,
    order: null,
    toGoKm: 4101,
    rate: 6,
    sim: "abc123",
    saved: "2026-11-13T04:00:00.000Z",
  });
});

test("the code is the voyage: without a good one there is nothing to save", () => {
  assert.equal(packVoyage({ ...now, code: "" }, WHEN), null);
  assert.equal(packVoyage({ ...now, code: "not a code!" }, WHEN), null);
  assert.equal(packVoyage({ ...now, code: "a".repeat(20001) }, WHEN), null);
  assert.equal(packVoyage({ ...now, day: Number.NaN }, WHEN), null);
  assert.equal(packVoyage({ ...now, day: -1 }, WHEN), null);
});

test("what is only for the offer's words is optional and never blocks a save", () => {
  const v = packVoyage({ code: CODE, day: 3 }, WHEN)!;
  assert.equal(v.boat, "");
  assert.equal(v.toGoKm, null);
  assert.equal(v.rate, 0); // no speed known: it comes back paused
  assert.equal(v.sim, "");
  assert.equal(v.challenge, "");
  assert.equal(packVoyage({ ...now, toGoKm: -5 }, WHEN)!.toGoKm, null);
  assert.equal(packVoyage({ ...now, rate: -1 }, WHEN)!.rate, 0);
  assert.equal(packVoyage({ ...now, challenge: "Not An Id" }, WHEN)!.challenge, "");
  assert.equal(packVoyage({ ...now, challenge: "sandys-shadow" }, WHEN)!.challenge, "sandys-shadow");
});

test("real time is a speed like any other (John's T1) and survives a save", () => {
  const v = packVoyage({ ...now, rate: REAL_TIME }, WHEN)!;
  assert.equal(v.rate, REAL_TIME);
  assert.equal(parseVoyage(JSON.stringify(v))!.rate, REAL_TIME);
});

test("save, load and clear round-trip through storage", () => {
  const s = fakeStore();
  const v = packVoyage(now, WHEN)!;
  assert.equal(loadVoyage(s), null);
  assert.equal(saveVoyage(v, s), true);
  assert.ok(s.data.has(VOYAGE_KEY));
  assert.deepEqual(loadVoyage(s), v);
  clearVoyage(s);
  assert.equal(s.data.has(VOYAGE_KEY), false);
  assert.equal(loadVoyage(s), null);
});

test("one crossing at a time: a new save replaces the old one", () => {
  const s = fakeStore();
  saveVoyage(packVoyage(now, WHEN)!, s);
  saveVoyage(packVoyage({ ...now, day: 20, boat: "Pearson 31-2" }, WHEN)!, s);
  assert.equal(s.data.size, 1);
  assert.equal(loadVoyage(s)!.day, 20);
  assert.equal(loadVoyage(s)!.boat, "Pearson 31-2");
});

test("a browser that won't store anything never throws; the save lives in memory for the page", () => {
  const v = packVoyage(now, WHEN)!;
  assert.equal(saveVoyage(v, broken), false);
  assert.deepEqual(loadVoyage(broken), v);
  assert.equal(saveVoyage(v, null), false);
  assert.deepEqual(loadVoyage(null), v);
  clearVoyage(broken);
  assert.equal(loadVoyage(broken), null);
});

test("a save that can't be used is not offered", () => {
  const v = packVoyage(now, WHEN)!;
  assert.equal(parseVoyage(null), null);
  assert.equal(parseVoyage(""), null);
  assert.equal(parseVoyage("{cut short"), null);
  assert.equal(parseVoyage("[1,2]"), null);
  assert.equal(parseVoyage("null"), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, v: VOYAGE_VERSION + 1 })), null); // a later version's
  assert.equal(parseVoyage(JSON.stringify({ ...v, v: undefined })), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, code: "<script>" })), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, code: 5 })), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, challenge: "../x" })), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, day: "12" })), null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, saved: "yesterday" })), null);
});

test("damaged words don't lose the voyage: only the code, challenge, day and time must be right", () => {
  const v = packVoyage(now, WHEN)!;
  const got = parseVoyage(JSON.stringify({ ...v, boat: 7, toGoKm: "far", rate: "fast", sim: null, extra: "ignored" }))!;
  assert.equal(got.code, CODE);
  assert.equal(got.boat, "");
  assert.equal(got.toGoKm, null);
  assert.equal(got.rate, 0);
  assert.equal(got.sim, "");
  assert.equal("extra" in got, false);
});

test("a voyage is worth saving once under way and until it ends", () => {
  assert.equal(worthSaving(0, false), false); // not sailed yet
  assert.equal(worthSaving(0.25, false), true);
  assert.equal(worthSaving(40, true), false); // over: the results card, not a continue
  assert.equal(worthSaving(null, false), false);
  assert.equal(worthSaving(Number.NaN, false), false);
});

test("a save from another simulator build is told apart; unknown builds are tried", () => {
  const v = packVoyage(now, WHEN)!;
  assert.equal(madeBy(v, "abc123"), true);
  assert.equal(madeBy(v, "def456"), false);
  assert.equal(madeBy(v, ""), true);
  assert.equal(madeBy({ ...v, sim: "" }, "def456"), true);
});

test("the offer says where the voyage stands, in the helm's own day count", () => {
  assert.equal(offerWords(packVoyage(now, WHEN)!), "Day 12 · 4,101 km to go · Kayak");
  assert.equal(offerWords(packVoyage({ ...now, day: 0.4 }, WHEN)!), "The first day · 4,101 km to go · Kayak");
  assert.equal(offerWords(packVoyage({ code: CODE, day: 50.9 }, WHEN)!), "Day 50"); // no words it doesn't have
});

test("the day on the screen when the page was left rides with the save, and an older save without it still loads", () => {
  const v = packVoyage({ ...now, left: 12.3149 }, WHEN)!;
  assert.equal(v.left, 12.31);
  assert.equal(parseVoyage(JSON.stringify(v))!.left, 12.31);
  const old = { ...v } as Record<string, unknown>;
  delete old.left;
  assert.equal(parseVoyage(JSON.stringify(old))!.left, null);
  assert.equal(parseVoyage(JSON.stringify({ ...v, left: "soon" }))!.left, null);
  assert.equal(packVoyage({ ...now, left: -1 }, WHEN)!.left, null);
});

test("the offer names the day the voyage comes back on, not where the simulator had run ahead to", () => {
  // Left with day 11.9 on the screen; the simulator's code was at day 12.44.
  assert.equal(offerWords(packVoyage({ ...now, left: 11.9 }, WHEN)!), "Day 11 · 4,101 km to go · Kayak");
  assert.equal(endWords(packVoyage({ ...now, left: 11.9 }, WHEN)!), "End your voyage on day 11 and start a new one?");
  // A save from before the page was left: it comes back on the save's day.
  assert.equal(offerWords(packVoyage({ ...now, left: 14 }, WHEN)!), "Day 12 · 4,101 km to go · Kayak");
});

test("the order on the helm rides with the save; one that can't be given again is dropped, not the voyage", () => {
  const steer = { heading: 95.5, power: 0.5, sails: null, engine: null };
  const v = packVoyage({ ...now, order: steer }, WHEN)!;
  assert.deepEqual(v.order, steer);
  assert.deepEqual(parseVoyage(JSON.stringify(v))!.order, steer);
  assert.deepEqual(packVoyage({ ...now, order: { heading: "finish", power: 0.25, sails: "reef1", engine: true } }, WHEN)!.order, { heading: "finish", power: 0.25, sails: "reef1", engine: true });
  const old = { ...v } as Record<string, unknown>;
  delete old.order;
  assert.equal(parseVoyage(JSON.stringify(old))!.order, null); // a save from before this
  for (const bad of [{ heading: 400, power: 0.5 }, { heading: "home", power: 0.5 }, { heading: 90, power: 7 }, { heading: 90 }, "steer 090", 5]) {
    const got = parseVoyage(JSON.stringify({ ...v, order: bad }))!;
    assert.equal(got.order, null);
    assert.equal(got.code, CODE);
  }
});

test("the same order isn't given twice; a different heading, power, sails or engine is", () => {
  const a = { heading: 90, power: 0.5, sails: null, engine: null };
  assert.equal(sameOrder(a, { ...a }), true);
  assert.equal(sameOrder(a, { ...a, heading: 90.04 }), true);
  assert.equal(sameOrder(a, { ...a, heading: 91 }), false);
  assert.equal(sameOrder(a, { ...a, heading: "auto" }), false);
  assert.equal(sameOrder({ ...a, heading: "finish" }, { ...a, heading: "finish" }), true);
  assert.equal(sameOrder({ ...a, heading: "finish" }, { ...a, heading: "auto" }), false); // Omar's case
  assert.equal(sameOrder(a, { ...a, power: 0.25 }), false);
  assert.equal(sameOrder(a, { ...a, sails: "reef1" }), false);
  assert.equal(sameOrder(a, { ...a, engine: true }), false);
});

test("welcome back says 'right where you left off' only when that is true", () => {
  // Back on the day it was left, or a little ahead (the simulator runs ahead of the picture).
  assert.equal(welcomeBack(1.56, 1.56), "Welcome back. It's day 1.6, right where you left off. Press play to carry on.");
  assert.equal(welcomeBack(1.8, 1.56), "Welcome back. It's day 1.8, right where you left off. Press play to carry on.");
  // Omar's case: left on day 1.56, the last save was day 0.81.
  assert.equal(welcomeBack(0.81, 1.56), "Welcome back. You left on day 1.6, but the last save was on day 0.8, so that's where you are. Press play to carry on.");
  // Within the hour, or the same day to one decimal: no fuss.
  assert.match(welcomeBack(1.52, 1.56), /right where you left off/);
  // Well ahead of what was on the screen, or a save that doesn't say: just the day.
  assert.equal(welcomeBack(5, 3), "Welcome back. It's day 5.0. Press play to carry on.");
  assert.equal(welcomeBack(5, null), "Welcome back. It's day 5.0. Press play to carry on.");
});

test("the question before a new crossing ends the saved one names its day", () => {
  assert.equal(endWords(packVoyage(now, WHEN)!), "End your voyage on day 12 and start a new one?");
  assert.equal(endWords(packVoyage({ ...now, day: 0.4 }, WHEN)!), "End your voyage on its first day and start a new one?");
});

test("the continue link carries only the code and the challenge, and says it is your own", () => {
  const v = packVoyage(now, WHEN)!;
  assert.equal(continueLink(v), `helm.html?g=${CODE}&continue=1`);
  const ch = packVoyage({ ...now, challenge: "sandys-shadow" }, WHEN)!;
  assert.equal(continueLink(ch, "./helm.html"), `./helm.html?g=${CODE}&c=sandys-shadow&continue=1`);
  // Nothing of the boat's state rides in the link: the simulator sails it again from the code.
  assert.equal(/day|toGo|12\.4|4101/.test(continueLink(v)), false);
});
