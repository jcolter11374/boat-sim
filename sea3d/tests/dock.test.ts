import { test } from "node:test";
import assert from "node:assert/strict";
import { DOCK_RAMP_S, DOCK_WAY, Dock, LANDING_WAY, dockSpeed, leavesFromDock } from "../src/helm/dock";
import { toXY } from "../src/helm/course";

test("tied up: she lies at the pier, pointing along it, not moving", () => {
  const d = new Dock();
  d.advance(5);
  const s = d.state;
  assert.equal(d.castOff, false);
  assert.equal(s.stw, 0);
  assert.equal(s.lat, DOCK_WAY[0].lat);
  assert.equal(s.lon, DOCK_WAY[0].lon);
  assert.ok(s.heading > 100 && s.heading < 160, `along the pier, south-east: ${s.heading}`);
});

test("cast off: she gathers way smoothly to her leaving speed and follows the way out", () => {
  const d = new Dock(DOCK_WAY, 0.87);
  d.leave();
  let last = 0;
  for (let t = 0; t < DOCK_RAMP_S; t += 0.1) {
    d.advance(0.1);
    assert.ok(d.speed >= last, "never slows while gathering way");
    last = d.speed;
  }
  assert.ok(Math.abs(d.speed - dockSpeed(0.87)) < 1e-6);
  // A minute on: off the pier, still inside the harbour (within 150 m of where she lay).
  for (let t = 0; t < 60; t += 0.1) d.advance(0.1);
  const v = toXY(DOCK_WAY[0], d.state);
  const m = Math.hypot(v.x, v.y);
  assert.ok(m > 40 && m < 150, `a minute out: ${m.toFixed(0)} m`);
});

test("the way out is long enough for a slow first load, and she carries on past its end", () => {
  const d = new Dock(DOCK_WAY, 3);
  d.leave();
  for (let t = 0; t < 3600; t += 1) d.advance(1); // an hour: far longer than any load
  const s = d.state;
  assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon) && Number.isFinite(s.heading));
  assert.ok(s.lat < DOCK_WAY[DOCK_WAY.length - 1].lat, "past the end of the channel, still heading down the Bay");
});

test("leaving speed: her own, between a walk and the harbour's 6 knots", () => {
  assert.equal(dockSpeed(0.5), 1.2);
  assert.equal(dockSpeed(2), 2);
  assert.equal(dockSpeed(9), 3.1);
});

test("reset: a start that failed puts her back alongside", () => {
  const d = new Dock();
  d.leave();
  d.advance(10);
  d.reset();
  assert.equal(d.castOff, false);
  assert.equal(d.state.lat, DOCK_WAY[0].lat);
});

test("which starts leave from the dock", () => {
  assert.equal(leavesFromDock("", false), true);
  assert.equal(leavesFromDock("annapolis", false), true);
  assert.equal(leavesFromDock("boston", false), false);
  assert.equal(leavesFromDock("", true), false);
});

test("arriving: she slows for her berth, stops alongside and never overshoots", () => {
  const d = new Dock(LANDING_WAY, 1.5, true);
  d.leave();
  let top = 0;
  let t = 0;
  for (; t < 120 && !d.alongside; t += 1 / 30) {
    d.advance(1 / 30);
    top = Math.max(top, d.speed);
    assert.ok(d.sailed <= d.length + 1e-9, "never past her berth");
  }
  assert.ok(d.alongside, "she gets there");
  assert.ok(t > 15 && t < 45, `in a watchable time: ${t.toFixed(0)} s`);
  assert.ok(top <= dockSpeed(1.5) + 1e-9);
  const s = d.state;
  assert.equal(s.stw, 0);
  const end = LANDING_WAY[LANDING_WAY.length - 1];
  const v = toXY(end, s);
  assert.ok(Math.hypot(v.x, v.y) < 0.01, "at the end of the way");
  assert.ok(s.heading > 35 && s.heading < 55, `along the pontoon, north-east: ${s.heading}`);
  d.advance(10);
  assert.equal(d.state.lat, s.lat);
});
