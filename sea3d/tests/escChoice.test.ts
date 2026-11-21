import { test } from "node:test";
import assert from "node:assert/strict";
import { escFoot, escPick } from "../src/helm/escChoice.ts";
import { SLOW_POWER, afterBlow, backWords } from "../src/helm/stormCall.ts";

const opt = (auto = false, keep = false) => ({ auto, keep });

test("#654: Esc on the big-waves card holds course, never 'slow down to 10%'", () => {
  // On the autopilot: hold course (the autopilot's own order), slow down.
  assert.deepEqual(escPick([opt(true, true), opt()]), { index: 0, why: "auto" });
  // With "turn south-east" still on the card.
  assert.deepEqual(escPick([opt(true, true), opt(), opt()]), { index: 0, why: "auto" });
  // Steering yourself: no autopilot option on this card, so Esc changes nothing.
  assert.deepEqual(escPick([opt(false, true), opt(), opt()]), { index: 0, why: "keep" });
});

test("Esc on the other cards: the autopilot's option wherever it sits", () => {
  // Night: ease off, keep the power up, hand her back to the autopilot.
  assert.deepEqual(escPick([opt(), opt(false, true), opt(true)]), { index: 2, why: "auto" });
  // The Gulf Stream: ride it, cut across, let the autopilot decide.
  assert.deepEqual(escPick([opt(), opt(), opt(true)]), { index: 2, why: "auto" });
  // The first chase: bend, or the autopilot.
  assert.deepEqual(escPick([opt(), opt(true)]), { index: 1, why: "auto" });
  // Navigator's check on the autopilot: "Take 095° (about what the autopilot does)" is a heading of
  // your own, not the autopilot, whatever its words; "Stay on the autopilot" is.
  assert.deepEqual(escPick([opt(), opt(true, true)]), { index: 1, why: "auto" });
  // Navigator's check, steering yourself: take it, keep yours, the autopilot.
  assert.deepEqual(escPick([opt(), opt(false, true), opt(true)]), { index: 2, why: "auto" });
  // More power? Steering yourself: push, or keep your power. Nothing changes on Esc.
  assert.deepEqual(escPick([opt(), opt(false, true)]), { index: 1, why: "keep" });
});

test("a card with neither: the first option, never the last; an empty card: none", () => {
  assert.deepEqual(escPick([opt(), opt(), opt()]), { index: 0, why: "first" });
  assert.deepEqual(escPick([]), { index: -1, why: "first" });
});

test("the card's foot names the option Esc picks", () => {
  assert.equal(escFoot(2, { index: 0, why: "auto" }), "Keys 1-2, or Esc for the autopilot (1).");
  assert.equal(escFoot(3, { index: 2, why: "auto" }), "Keys 1-3, or Esc for the autopilot (3).");
  assert.equal(escFoot(2, { index: 1, why: "keep" }), "Keys 1-2, or Esc to carry on as you are (2).");
  assert.equal(escFoot(3, { index: 0, why: "first" }), "Keys 1-3, or Esc for 1.");
  assert.equal(escFoot(0, { index: -1, why: "first" }), "");
});

test("#654: 'ride it out' gives the power back once the blow has passed", () => {
  assert.equal(SLOW_POWER, 0.1);
  // On the autopilot at 25% before: slowed onto the planned route at 10%. Back to the autopilot.
  const auto = { order: "auto" as const, power: 0.25, to: "route" as const };
  assert.deepEqual(afterBlow(auto, "route", 0.1), { order: "auto", power: 0.25 });
  // Steering 095° at 40% before: back to 095° at 40%.
  const own = { order: 95, power: 0.4, to: 95 };
  assert.deepEqual(afterBlow(own, 95, 0.1), { order: 95, power: 0.4 });
  // An order of your own since then stands: a new heading, or a different power.
  assert.equal(afterBlow(auto, 120, 0.1), null);
  assert.equal(afterBlow(auto, "route", 0.3), null);
  assert.equal(afterBlow(auto, "auto", 0.1), null);
  // Held course or dodged: nothing to give back.
  assert.equal(afterBlow(null, "route", 0.1), null);
  assert.equal(backWords({ order: "auto", power: 0.25 }), "She's back on the autopilot, as before.");
  assert.equal(backWords({ order: 95, power: 0.4 }), "Back to 40% power, as before.");
});
