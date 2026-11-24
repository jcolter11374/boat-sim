// The player's last crossing and how Results and the leaderboard name their boat (src/myCrossing.ts, #653).
import assert from "node:assert/strict";
import { test } from "node:test";
import { CROSSING_KEY, loadMyCrossing, parseMyCrossing, resultsBoatName, resultsRowLabel, saveMyCrossing, yourRow } from "../src/myCrossing";
import { leaves } from "../src/helm/story";

function mem() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
}
const built = { boat: "Check Boat 21", build: "k-p25-sol.solar-300", finished: true, days: 55.31, day: "2020-04-23" };

test("a crossing is kept and read back; rubbish is dropped", () => {
  const s = mem();
  assert.equal(loadMyCrossing(s), null);
  const kept = saveMyCrossing(built, s, new Date("2026-11-21T08:00:00Z"));
  assert.deepEqual(loadMyCrossing(s), { ...built, at: "2026-11-21T08:00:00.000Z" });
  assert.deepEqual(kept, loadMyCrossing(s));
  for (const bad of ["", "{", "[]", '{"v":2}', JSON.stringify({ v: 1, ...built, boat: "  " }), JSON.stringify({ v: 1, ...built, days: "55" }), JSON.stringify({ v: 1, ...built, build: "" })]) {
    s.setItem(CROSSING_KEY, bad);
    assert.equal(loadMyCrossing(s), null, bad);
  }
  assert.equal(parseMyCrossing(JSON.stringify({ v: 1, ...built, boat: "x".repeat(200) }))!.boat.length, 60);
});

test("Results names the boat that sailed, not our kayak (#653)", () => {
  assert.equal(resultsBoatName("Check Boat 21"), "Check Boat 21");
  assert.equal(resultsBoatName("Our kayak"), "Our kayak");
  assert.equal(resultsBoatName(""), "This build");
  assert.equal(resultsBoatName(null), "This build");
  assert.equal(resultsRowLabel("Check Boat 21"), "Check Boat 21 (you)");
  assert.equal(resultsRowLabel("Our kayak"), "You");
  assert.equal(resultsRowLabel(""), "You");
  // The sentence the live check caught: "Our kayak finishes 84% of launches" for a boat built in the Boatyard.
  const card = { boat: { outcome: "arrived" } } as Parameters<typeof leaves>[0];
  assert.equal(leaves(card, 0.84, resultsBoatName("Check Boat 21")), "Check Boat 21 finishes 84% of launches. This was one of them.");
});

test("the leaderboard lists a built boat under her name, with the Boatyard's odds and her crossing, and no place", () => {
  const c = { ...built, at: "" };
  const y = yourRow(c, ["k-p25", "revc"], [{ id: "k-p25-sol.solar-300", odds: { voyages: 100, odds: 0.84 } }])!;
  assert.equal(y.name, "Check Boat 21");
  assert.equal(y.onBoard, false);
  assert.deepEqual(y.odds, { rate: 0.84, words: "Boatyard odds, over 100 launch days" });
  assert.equal(y.crossing, "Your crossing: finished in 55.3 days (launched 23 Apr 2020).");
  assert.match(y.why, /^The boat you last sailed across\. Not ranked/);
});

test("a build our servers haven't tested gets no odds; one the board ranks marks that row", () => {
  const lost = yourRow({ ...built, finished: false, days: 12, day: "", at: "" }, [], null)!;
  assert.equal(lost.odds, null);
  assert.equal(lost.crossing, "Your crossing: didn't finish (12.0 days at sea).");
  assert.equal(yourRow({ ...built, build: "k-p25", at: "" }, ["k-p25"], [])!.onBoard, true);
  assert.equal(yourRow(null, ["k-p25"], []), null);
});
