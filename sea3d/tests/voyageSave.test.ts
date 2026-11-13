import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REAL_TIME,
  VOYAGE_KEY,
  VOYAGE_VERSION,
  clearVoyage,
  continueLink,
  loadVoyage,
  madeBy,
  packVoyage,
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

test("the continue link carries only the code and the challenge, and says it is your own", () => {
  const v = packVoyage(now, WHEN)!;
  assert.equal(continueLink(v), `helm.html?g=${CODE}&continue=1`);
  const ch = packVoyage({ ...now, challenge: "sandys-shadow" }, WHEN)!;
  assert.equal(continueLink(ch, "./helm.html"), `./helm.html?g=${CODE}&c=sandys-shadow&continue=1`);
  // Nothing of the boat's state rides in the link: the simulator sails it again from the code.
  assert.equal(/day|toGo|12\.4|4101/.test(continueLink(v)), false);
});
