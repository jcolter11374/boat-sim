// The speed bar at the end of a voyage (src/helm/timebar.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { runOutStep, voyageDone } from "../src/helm/timebar";

const REAL_TIME = 1 / 3600;

test("the speed bar stays while the voyage is still running, whoever steers", () => {
  assert.equal(voyageDone(false, false, 10, 12), false);
  assert.equal(voyageDone(false, true, 10, 12), false);
});

test("when you steer, the bar goes as soon as the simulator says the voyage is over", () => {
  assert.equal(voyageDone(true, false, 10, 12), true);
});

test("in a watched voyage the bar stays until the picture reaches the last row", () => {
  // The watch source hands over the last rows up to 72 h ahead of the picture.
  assert.equal(voyageDone(true, true, 500, 572), false);
  assert.equal(voyageDone(true, true, 571.99, 572), false);
  assert.equal(voyageDone(true, true, 572, 572), true);
  assert.equal(voyageDone(true, true, 572 - 1e-9, 572), true);
});

test("a watched voyage runs out at the chosen speed and lands exactly on the last row", () => {
  assert.ok(Math.abs(runOutStep(REAL_TIME, 1, 571, 572) - (571 + REAL_TIME)) < 1e-9); // Real time stays real time
  assert.equal(runOutStep(24, 0.5, 500, 572), 512);
  assert.ok(Math.abs(runOutStep(96, 0.1, 570, 572) - 570.1) < 1e-9); // an hour a second over the last three hours
  assert.equal(runOutStep(6, 1, 571.5, 572), 572);
  let h = 560;
  for (let i = 0; i < 400 && h < 572; i++) h = runOutStep(24, 0.05, h, 572);
  assert.equal(h, 572);
});
