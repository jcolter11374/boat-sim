// The speed bar at the end of a voyage (src/helm/timebar.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { drainStep, inStretch, runOutStep, stopStretch, voyageDone } from "../src/helm/timebar";

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

test("a stop with no call: the picture's last three hours play at an hour a second, whatever the speed", () => {
  const s = stopStretch(100);
  assert.deepEqual(s, { from: 97, h: 100 });
  assert.equal(inStretch(s, 96.9), false);
  assert.equal(inStretch(s, 97), true);
  assert.equal(inStretch(s, 99.99), true);
  assert.equal(inStretch(s, 100), false, "at the stop itself the stretch is over");
  assert.equal(inStretch(null, 50), false);
  // At four days a second the clock ran 72 h ahead: the picture covers 69 of them in under a
  // second, then takes three seconds over the last three hours.
  for (const rate of [6, 24, 96]) {
    let hour = 28, secs = 0, slowSecs = 0;
    const dt = 1 / 60;
    while (hour < 100 - 1e-9) {
      const slow = inStretch(s, hour);
      hour = drainStep(rate, dt, hour, 100, slow, s.from);
      secs += dt;
      if (slow) slowSecs += dt;
    }
    assert.ok(Math.abs(slowSecs - 3) < 0.1, `${rate} h/s: ${slowSecs.toFixed(2)} s over the last three hours`);
    assert.ok(secs < 3 + 69 / rate + 0.2);
    assert.ok(hour <= 100 && hour > 100 - 1e-6, "and it stops at the stop, never past it");
  }
  // Real time is never sped up to "an hour a second".
  assert.ok(drainStep(1 / 3600, 1, 98, 100, true) - 98 < 0.001);
});
