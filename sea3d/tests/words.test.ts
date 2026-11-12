import assert from "node:assert/strict";
import { test } from "node:test";
import { optionName, playerWords, sentence, tidyCatalog } from "../src/yard/words";
import { tierOf } from "../src/yard/tier";

// Item 10 (Milo, Ines, 12 Nov): no team shorthand in what a player reads.
test("option names drop (as built): the badge says it", () => {
  assert.equal(optionName("Twin rudders, separate servos (as built)"), "Twin rudders, separate servos");
  assert.equal(optionName("Polyethylene (rotomoulded, as built)"), "Polyethylene (rotomoulded)");
  assert.equal(optionName("Single rudder"), "Single rudder");
});

test("GUESS and 'as modelled' become plain words", () => {
  assert.equal(playerWords("the v4 kayak as modelled"), "As on our kayak.");
  assert.equal(playerWords("box failure rates are GUESSes (Randolph's table)"), "box failure rates are estimates (Randolph's table)");
  assert.equal(playerWords("beacon failure rate is a GUESS"), "beacon failure rate is our estimate");
  assert.equal(playerWords("the other revision's rudder, scaled (GUESS)"), "the other revision's rudder, scaled (our estimate)");
});

test("the odds colour follows the leaderboard's groups", () => {
  const t = new Map([["k-p25", 1], ["k-p25-brain.one-box", 2], ["revc", 3]]);
  assert.equal(tierOf(t, "k-p25"), "best");
  assert.equal(tierOf(t, "k-p25-brain.one-box"), "good");
  assert.equal(tierOf(t, "revc"), "long");
  assert.equal(tierOf(t, "not-on-board"), "");
  assert.equal(tierOf(null, "k-p25"), "");
});

test("descriptions read as sentences (Milo)", () => {
  assert.equal(
    sentence("wing scaled from Randolph's Rev B; size, weight and breakage are GUESSes; no motors, so it tacks upwind"),
    "Wing scaled from the Randolph team's Rev B; size, weight and breakage are estimates. No motors, so it tacks upwind.",
  );
  assert.equal(sentence("Planned. Covers the dome and side decks"), "Covers the dome and side decks.");
  assert.equal(sentence("One rudder and one servo, as on Rev B."), "One rudder and one servo, as on Rev B.");
});

test("the kayak's wing options: one line, the detail behind the i (Ines)", () => {
  const cat = tidyCatalog({ slots: [{ id: "drive", name: "Drive", opts: [{ id: "wing-sail", n: "Wing sail only", d: "wing scaled from Randolph's Rev B", cost: 0, kg: 0 }] }] } as never);
  const o = cat.slots[0].opts[0];
  assert.equal(o.d, "A rigid wing and no motors, so it tacks upwind.");
  assert.equal(o.more, "Scaled from the Randolph team's Rev B. Size, weight and breakage are our estimates.");
});
