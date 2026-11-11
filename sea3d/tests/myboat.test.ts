import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MYBOAT_KEY,
  clearMyBoat,
  loadMyBoat,
  myBoatYardLink,
  parseMyBoat,
  saveMyBoat,
  type StorageLike,
} from "../src/myboat.ts";

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
const revc = {
  kind: "yard" as const,
  base: "revc",
  hash: "#base=revc&rudder=single",
  name: "Rev C, one rudder",
  choices: { base: "revc", rudder: "single", sail_area: 1.2 },
};
const now = new Date("2026-11-11T18:00:00Z");

test("save then load gives the same boat, stamped with the time", () => {
  const s = fakeStore();
  clearMyBoat(s);
  assert.equal(loadMyBoat(s), null);
  const saved = saveMyBoat(revc, s, now);
  assert.equal(saved.saved, "2026-11-11T18:00:00.000Z");
  assert.deepEqual(loadMyBoat(s), saved);
  assert.equal(JSON.parse(s.data.get(MYBOAT_KEY)!).v, 1);
});

test("saving copies the choices, so later edits don't leak in", () => {
  const s = fakeStore();
  const choices: Record<string, string | number> = { base: "kayak" };
  saveMyBoat(
    { kind: "yard", base: "kayak", hash: "", name: "Kayak", choices },
    s,
    now,
  );
  choices.base = "revb";
  assert.equal(loadMyBoat(s)!.choices.base, "kayak");
});

test("clear forgets it", () => {
  const s = fakeStore();
  saveMyBoat(revc, s, now);
  clearMyBoat(s);
  assert.equal(loadMyBoat(s), null);
  assert.equal(s.data.has(MYBOAT_KEY), false);
});

test("a browser that won't store keeps the boat for this page, without throwing", () => {
  clearMyBoat(fakeStore());
  const saved = saveMyBoat(revc, broken, now);
  assert.deepEqual(loadMyBoat(broken), saved);
  assert.deepEqual(loadMyBoat(null), saved);
  clearMyBoat(broken);
  assert.equal(loadMyBoat(broken), null);
});

test("unreadable or wrong-version data counts as no boat", () => {
  const good = { v: 1, ...revc, saved: now.toISOString() };
  assert.notEqual(parseMyBoat(JSON.stringify(good)), null);
  for (const bad of [
    "",
    "not json",
    "null",
    "[]",
    JSON.stringify({ ...good, v: 2 }),
    JSON.stringify({ ...good, kind: "spaceship" }),
    JSON.stringify({ ...good, base: "" }),
    JSON.stringify({ ...good, name: 3 }),
    JSON.stringify({ ...good, choices: [] }),
    JSON.stringify({ ...good, choices: { a: { b: 1 } } }),
  ])
    assert.equal(parseMyBoat(bad), null, bad);
});

test("the Boatyard link reopens a design; a stock boat opens the yard as is", () => {
  assert.equal(
    myBoatYardLink({ ...revc, saved: "" }),
    "boatyard.html#base=revc&rudder=single",
  );
  assert.equal(
    myBoatYardLink({
      kind: "stock",
      base: "stock_cruiser31",
      hash: "",
      name: "31 ft cruiser",
      choices: { base: "stock_cruiser31" },
      saved: "",
    }),
    "boatyard.html",
  );
});
