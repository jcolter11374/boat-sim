import { test } from "node:test";
import assert from "node:assert/strict";
import { chanceFor } from "../src/yard/chance";
import type { GridBuild } from "../src/yard/launch";

const build = (odds: GridBuild["odds"]): GridBuild => ({ id: "k-p25", boat: "kayak", label: "Our kayak", options: {}, odds, replays: [] });
const odds = { voyages: 100, finished: 78, odds: 0.78, low95: 0.69, high95: 0.85, median_days: 72 };
const src = { years: [2012, 2021] as [number, number], months: [6, 4, 5] };

test("a tested build shows its own odds, with the launches behind them", () => {
  const c = chanceFor({ build: build(odds), exact: true }, src);
  assert.deepEqual(c, {
    tested: true,
    value: "78%",
    note: "Likely 69% to 85%. The simulator's autopilot sailed this exact build from 100 launches (Apr to Jun, 2012 to 2021).",
  });
  assert.match(chanceFor({ build: build(odds), exact: true }, { years: [2012, 2021] }).note, /100 launches \(2012 to 2021\)\.$/);
  assert.match(chanceFor({ build: build(odds), exact: true }, null).note, /100 launches\.$/);
});

test("a near miss never borrows the nearest build's odds", () => {
  const c = chanceFor({ build: build(odds), exact: false }, src);
  assert.equal(c.tested, false);
  assert.equal(c.value, "not tested yet");
  assert.equal(c.note, 'Press "Test it" to sail it.');
});

test("no grid, or a tested build without odds: not tested yet", () => {
  assert.equal(chanceFor(null, src).tested, false);
  assert.equal(chanceFor({ build: build(null), exact: true }, src).tested, false);
  assert.equal(chanceFor({ build: build({ ...odds, voyages: 0 }), exact: true }, src).tested, false);
});
