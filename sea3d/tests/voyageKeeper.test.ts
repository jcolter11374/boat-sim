import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_UNSAVED_H, MIN_ASK_MS, VoyageKeeper, type VoyageState } from "../src/helm/voyageKeeper.ts";
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

// ---- when it saves (Omar's live check, 13 Nov: a 15 s timer lost most of a day at 6 h a second) ----

/** A keeper over a voyage the test moves along by hand; `asked` counts the simulator's codes. */
function rig(start: Partial<VoyageState> = {}) {
  const s = fakeStore();
  const at = { st: { ...under, seen: under.day, orders: "auto", ...start } as VoyageState, asked: 0 };
  const k = new VoyageKeeper(
    () => at.st,
    async () => (at.asked++, CODE),
    s,
  );
  return { s, at, k };
}

test("the first look saves; a look with nothing new does not ask the simulator again", async () => {
  const { at, k } = rig();
  assert.equal(await k.look(0), true);
  assert.equal(await k.look(10_000), false);
  assert.equal(await k.look(600_000), false); // paused for ten minutes: still nothing new
  assert.equal(at.asked, 1);
});

test("pausing the clock saves, and so does carrying on or changing speed", async () => {
  const { s, at, k } = rig();
  await k.look(0);
  at.st = { ...at.st, rate: 0 };
  assert.equal(await k.look(MIN_ASK_MS), true);
  assert.equal(loadVoyage(s)!.rate, 0);
  at.st = { ...at.st, rate: 24 };
  assert.equal(await k.look(2 * MIN_ASK_MS), true);
  assert.equal(loadVoyage(s)!.rate, 24);
  at.st = { ...at.st, rate: REAL_TIME };
  assert.equal(await k.look(3 * MIN_ASK_MS), true);
  assert.equal(loadVoyage(s)!.rate, REAL_TIME);
  assert.equal(at.asked, 4);
});

test("an order that goes is saved", async () => {
  const { at, k } = rig();
  await k.look(0);
  at.st = { ...at.st, orders: "steer 090" };
  assert.equal(await k.look(MIN_ASK_MS), true);
  assert.equal(await k.look(2 * MIN_ASK_MS), false); // the same order: nothing new
  assert.equal(at.asked, 2);
});

test("an hour of the voyage is the most that goes by between saves, when the two-second rule allows", async () => {
  const { s, at, k } = rig({ day: 3 });
  await k.look(0);
  at.st = { ...at.st, day: 3 + (MAX_UNSAVED_H - 0.1) / 24 };
  assert.equal(await k.look(60_000), false); // not an hour yet
  at.st = { ...at.st, day: 3 + MAX_UNSAVED_H / 24 };
  assert.equal(await k.look(120_000), true);
  assert.equal(loadVoyage(s)!.day, Math.round((3 + MAX_UNSAVED_H / 24) * 100) / 100);
});

test("the simulator is never asked more than once every two seconds, at any speed", async () => {
  // Four days a second, looked at twice a second for a minute.
  const { at, k } = rig({ day: 1, rate: 96 });
  for (let ms = 0; ms <= 60_000; ms += 500) {
    at.st = { ...at.st, day: 1 + (96 * ms) / 1000 / 24, orders: `o${ms}` }; // an order every look, too
    await k.look(ms);
  }
  assert.equal(at.asked, 60_000 / MIN_ASK_MS + 1);
});

test("a save that is due too soon is not lost: it goes at the next look that is allowed", async () => {
  const { s, at, k } = rig();
  await k.look(0);
  at.st = { ...at.st, rate: 0 }; // paused half a second after a save
  assert.equal(await k.look(500), false);
  assert.equal(await k.look(MIN_ASK_MS), true);
  assert.equal(loadVoyage(s)!.rate, 0);
});

test("how much can go unsaved: two seconds of play, so within the hour up to an hour a second", async () => {
  for (const [rate, mostHours] of [[1 / 3600, MAX_UNSAVED_H], [1, 2], [6, 12], [24, 48], [96, 192]] as const) {
    const { s, at, k } = rig({ day: 2, rate });
    let worst = 0;
    for (let ms = 0; ms <= 30_000; ms += 500) {
      at.st = { ...at.st, day: 2 + (rate * ms) / 1000 / 24 };
      worst = Math.max(worst, (at.st.day - (loadVoyage(s)?.day ?? 2)) * 24);
      await k.look(ms);
    }
    assert.ok(worst <= mostHours + 0.3, `${rate} h/s: ${worst.toFixed(2)} h unsaved, at most ${mostHours}`); // 0.3: days are kept to two decimals
  }
});

test("leaving the page writes at once, without the simulator: the code held, and the day on the screen", async () => {
  const { s, at, k } = rig({ day: 0.81, seen: 0.8 });
  await k.look(0);
  assert.equal(loadVoyage(s)!.left, 0.8);
  // Sailed on to day 1.56 and paused; the tab closes before the next save can finish.
  at.st = { ...at.st, day: 1.6, seen: 1.56, rate: 0 };
  const asked = at.asked;
  assert.equal(k.leave(), true);
  assert.equal(at.asked, asked); // nothing asked: a closing page doesn't wait
  const v = loadVoyage(s)!;
  assert.equal(v.code, CODE);
  assert.equal(v.day, 0.81); // where the code will come back to
  assert.equal(v.left, 1.56); // where the player was
  assert.equal(v.rate, 0);
});

test("leaving with nothing saved yet writes nothing; leaving an ended voyage clears it", async () => {
  const { s, at, k } = rig();
  assert.equal(k.leave(), false);
  assert.equal(s.data.size, 0);
  await k.look(0);
  at.st = { ...at.st, over: true };
  assert.equal(k.leave(), false);
  assert.equal(s.data.has(VOYAGE_KEY), false);
});

test("a storage that throws doesn't stop a look or a leave", async () => {
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
  const k = new VoyageKeeper(() => ({ ...under, seen: 3.4 }), async () => CODE, broken);
  assert.equal(await k.look(0), true);
  assert.equal(k.leave(), true);
});

test("an order sent in the last moment is written when the page is left, though the code doesn't hold it yet", async () => {
  const auto = { heading: "auto" as const, power: 0.25, sails: null, engine: null };
  const { s, at, k } = rig({ order: auto });
  await k.look(0);
  assert.deepEqual(loadVoyage(s)!.order, auto);
  // "To the finish" is sent; the simulator hasn't answered when the tab closes.
  const finish = { heading: "finish" as const, power: 0.5, sails: null, engine: null };
  at.st = { ...at.st, order: finish, orders: "finish" };
  const asked = at.asked;
  assert.equal(k.leave(), true);
  assert.equal(at.asked, asked);
  const v = loadVoyage(s)!;
  assert.equal(v.code, CODE); // the code as last answered
  assert.deepEqual(v.order, finish); // and the order to give again
});

test("a save made by a look carries the order on the helm then", async () => {
  const steer = { heading: 120, power: 0.5, sails: null, engine: null };
  const { s, k } = rig({ order: steer });
  await k.look(0);
  assert.deepEqual(loadVoyage(s)!.order, steer);
  const none = rig({ order: null }); // from base, or no link: nothing to give again
  await none.k.look(0);
  assert.equal(loadVoyage(none.s)!.order, null);
});
