import assert from "node:assert/strict";
import { test } from "node:test";
import { optionName, playerWords } from "../src/yard/words";
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
