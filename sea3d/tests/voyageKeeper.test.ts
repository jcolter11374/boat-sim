import { test } from "node:test";
import assert from "node:assert/strict";
import { VoyageKeeper, type VoyageState } from "../src/helm/voyageKeeper.ts";
import { REAL_TIME, VOYAGE_KEY, loadVoyage, packVoyage, saveVoyage } from "../src/helm/voyageSave.ts";
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

const CODE = "eNqrVipTslIyUtJRKlayMjTQUcpXsjI01lEqULIyNDI2BQBvqQYd";
const under: VoyageState = { day: 3.5, over: false, boat: "Kayak", toGoKm: 4800, rate: 6, challenge: "" };

test("a voyage under way is saved with the simulator's code and the page's words", async () => {
  const s = fakeStore();
  const k = new VoyageKeeper(() => under, async () => CODE, s);
  assert.equal(await k.keep(), true);
  const v = loadVoyage(s)!;
  assert.equal(v.code, CODE);
  assert.equal(v.day, 3.5);
  assert.equal(v.boat, "Kayak");
  assert.equal(v.toGoKm, 4800);
  assert.equal(v.rate, 6);
  assert.deepEqual(k.last, v);
});

test("real time is kept as the speed it was (John's T1)", async () => {
  const s = fakeStore();
  const k = new VoyageKeeper(() => ({ ...under, rate: REAL_TIME }), async () => CODE, s);
  await k.keep();
  assert.equal(loadVoyage(s)!.rate, REAL_TIME);
});

test("nothing is saved before a voyage is on the screen, or before it has sailed", async () => {
  const s = fakeStore();
  let asked = 0;
  const code = async () => (asked++, CODE);
  assert.equal(await new VoyageKeeper(() => null, code, s).keep(), false);
  assert.equal(await new VoyageKeeper(() => ({ ...under, day: 0 }), code, s).keep(), false);
  assert.equal(asked, 0); // the simulator isn't even asked
  assert.equal(s.data.size, 0);
});

test("a voyage that ends clears its save, and an ended voyage is never saved", async () => {
  const s = fakeStore();
  let st = under;
  const k = new VoyageKeeper(() => st, async () => CODE, s);
  await k.keep();
  assert.ok(s.data.has(VOYAGE_KEY));
  st = { ...under, day: 40, over: true };
  assert.equal(await k.keep(), false);
  assert.equal(s.data.has(VOYAGE_KEY), false);
  assert.equal(k.last, null);
});

test("an ended voyage clears once: a crossing saved later by another tab is left alone", async () => {
  const s = fakeStore();
  const k = new VoyageKeeper(() => ({ ...under, over: true }), async () => CODE, s);
  await k.keep();
  saveVoyage(packVoyage({ ...under, code: CODE, day: 9 })!, s); // another tab's new crossing
  await k.keep();
  assert.equal(loadVoyage(s)!.day, 9);
});

test("a voyage that ends while the code is being made is not saved", async () => {
  const s = fakeStore();
  let st = under;
  const k = new VoyageKeeper(
    () => st,
    async () => {
      st = { ...under, over: true };
      return CODE;
    },
    s,
  );
  assert.equal(await k.keep(), false);
  assert.equal(s.data.size, 0);
});

test("the words are for the moment the code came back", async () => {
  const s = fakeStore();
  let st = under;
  const k = new VoyageKeeper(
    () => st,
    async () => {
      st = { ...under, day: 3.75, toGoKm: 4760 };
      return CODE;
    },
    s,
  );
  await k.keep();
  assert.equal(loadVoyage(s)!.day, 3.75);
  assert.equal(loadVoyage(s)!.toGoKm, 4760);
});

test("a simulator that can't answer loses nothing: the last save stands, and nothing throws", async () => {
  const s = fakeStore();
  let fail = false;
  const k = new VoyageKeeper(
    () => under,
    async () => {
      if (fail) throw new Error("worker gone");
      return CODE;
    },
    s,
  );
  await k.keep();
  fail = true;
  assert.equal(await k.keep(), false);
  assert.equal(loadVoyage(s)!.code, CODE);
  // A code that isn't one of the simulator's is not written over a good save either.
  const bad = new VoyageKeeper(() => under, async () => "not a code!", s);
  assert.equal(await bad.keep(), false);
  assert.equal(loadVoyage(s)!.code, CODE);
});

test("one question at a time: a save still waiting on the simulator isn't asked twice", async () => {
  const s = fakeStore();
  let asked = 0;
  let answer!: (c: string) => void;
  const k = new VoyageKeeper(
    () => under,
    () => (asked++, new Promise<string>((r) => (answer = r))),
    s,
  );
  const first = k.keep();
  assert.equal(await k.keep(), false);
  assert.equal(asked, 1);
  answer(CODE);
  assert.equal(await first, true);
  void k.keep(); // and it can ask again afterwards
  assert.equal(asked, 2);
});
