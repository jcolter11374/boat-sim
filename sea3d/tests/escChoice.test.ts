import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // On the autopilot at 25% before; the slow order was the 7th order of the voyage and still the last.
  const auto = { order: "auto" as const, power: 0.25, seq: 7 };
  assert.deepEqual(afterBlow(auto, 7), { order: "auto", power: 0.25 });
  // Steering 095° at 40% before: back to 095° at 40%.
  assert.deepEqual(afterBlow({ order: 95, power: 0.4, seq: 3 }, 3), { order: 95, power: 0.4 });
  // Any order since then stands: a new heading, another power, a night card's "ease off" (10% too).
  assert.equal(afterBlow(auto, 8), null);
  // Held course or dodged: nothing to give back.
  assert.equal(afterBlow(null, 7), null);
  assert.equal(backWords({ order: "auto", power: 0.25 }), "She's back on the autopilot, as before.");
  assert.equal(backWords({ order: 95, power: 0.4 }), "Back to 40% power, as before.");
});

// The rules above are pure; these pin how the page uses them, so a change in helm.ts that brings
// #654 back fails here and not only in tools/qa/esc-on-cards.mjs (review of #656).
test("the page's wiring: Esc goes by what an option does, and the cards mark their options", () => {
  const helm = readFileSync(new URL("../src/helm.ts", import.meta.url), "utf8");
  const key = helm.slice(helm.indexOf("function decisionKey("), helm.indexOf("/** Things to say once the picture reaches a voyage hour"));
  assert.match(key, /btns\[escOption\.index\]\?\.click\(\)/, "Esc presses the option escPick chose");
  assert.doesNotMatch(key, /autopilot\/i|\.at\(-1\)/, "Esc no longer reads the button's words or falls back to the last button");
  assert.match(helm, /escOption = escPick\(d\.choices\.map\(\(c\) => \(\{ auto: c\.esc === "auto" \|\| c\.order\?\.heading === "auto", keep: c\.esc === "keep" \}\)\)\)/);
  const line = (start: string) => helm.split("\n").find((l) => l.includes(start)) ?? "";
  assert.match(line('label: "Hold course: fastest'), /esc: "keep"/, "storm card: hold course changes nothing");
  assert.match(line('label: "Hand her back to the autopilot (same as the ghost)"'), /esc: "auto"/, "night card");
  assert.match(line("label: words.stay"), /esc: "keep"/, "more-power card");
  assert.match(line('"Stay on the autopilot (same as the ghost)" : `Keep ${orderWords(order)}`'), /esc: "keep"/, "route card");
  assert.match(line("const carryOn: Choice"), /esc: "keep"/);
  // Ride it out: the slow order is stamped, and the "passed" note gives the order back.
  assert.match(helm, /spell\.back = \{ \.\.\.before, seq: orderSeq \}/);
  assert.match(helm, /const back = afterBlow\(spell\.back \?\? null, orderSeq\);/);
  assert.match(helm, /void setOrder\(back\.order, back\.power\);/);
});
