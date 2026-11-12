import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ANNAPOLIS_COURSE, LEG_M, LIGHT_STONES_M, THOMAS_POINT, lightGate, harbourExit, toLatLon, toTheLight, toXY, triangle } from "../src/helm/course.ts";
import { depthState, sampleGrid } from "../src/land/depth.ts";
import { CRUISER_HANDLING, crosses, Wheel, type TrimTable } from "../src/helm/wheel.ts";
import { aside } from "../src/helm/wheelSession.ts";

const T: TrimTable = JSON.parse(readFileSync(new URL("../../configs/polars/cruiser31_trim.json", import.meta.url), "utf8"));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const bearing = (a: { x: number; y: number }, b: { x: number; y: number }) => (Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI;

test("metres and degrees go there and back", () => {
  const p = toLatLon(ANNAPOLIS_COURSE, { x: 1234, y: -567 });
  const q = toXY(ANNAPOLIS_COURSE, p);
  assert.ok(Math.abs(q.x - 1234) < 1e-6 && Math.abs(q.y + 567) < 1e-6);
});

test("the triangle is laid to the wind: a beat, a broad reach, a reach, 800 m each", () => {
  for (const from of [0, 90, 200, 315]) {
    const c = triangle(from);
    const pts = [c.start, ...c.marks].map((m) => toXY(c.start, m));
    const legs = [0, 1, 2].map((i) => Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    for (const l of legs) assert.ok(Math.abs(l - LEG_M) < 1, `leg ${l}`);
    const off = [0, 1, 2].map((i) => Math.abs(wrap180(bearing(pts[i], pts[i + 1]) - from)));
    assert.ok(off[0] < 40, `first leg is upwind: ${off[0]}`);
    assert.ok(off[1] > 120, `second leg is downwind: ${off[1]}`);
    assert.ok(off[2] > 70 && off[2] < 110, `third leg is across the wind: ${off[2]}`);
    assert.deepEqual(pts[3], pts[0], "the finish is where you started");
    assert.ok(Math.abs(wrap180(c.heading - from)) >= 40, "starts close-hauled, not in irons");
  }
});

test("the run to the light is about 7 km and starts pointing at it", () => {
  const c = toTheLight();
  const v = toXY(c.start, THOMAS_POINT);
  const km = Math.hypot(v.x, v.y) / 1000;
  assert.ok(km > 6 && km < 8, `${km} km`);
  assert.ok(Math.abs(wrap180(bearing({ x: 0, y: 0 }, v) - c.heading)) < 1);
});

test("depth from a square: blended between points, north row first, null outside", () => {
  // 2 x 2 grid in decimetres: north row -100, -100; south row -10, 30.
  const g = { meta: { nx: 2, ny: 2, lon0: 0, lon1: 1, lat0: 0, lat1: 1, scale: 0.1 }, hgt: Int16Array.from([-100, -100, -10, 30]) };
  assert.equal(sampleGrid(g, 1, 0), -10);
  assert.equal(sampleGrid(g, 0, 1), 3);
  assert.ok(Math.abs(sampleGrid(g, 0.5, 0.5)! - -4.5) < 1e-9);
  assert.equal(sampleGrid(g, 1.1, 0.5), null);
});

test("shallow water has a margin, and an unknown depth never runs her aground", () => {
  assert.equal(depthState(null, 1.9), "unknown");
  assert.equal(depthState(-10, 1.9), "deep");
  assert.equal(depthState(-2.5, 1.9), "shallow");
  assert.equal(depthState(-1.7, 1.9), "shallow", "a near miss in the data isn't a grounding");
  assert.equal(depthState(-1.4, 1.9), "aground");
  assert.equal(depthState(2, 1.9), "aground", "dry land");
});

test("a course: marks reached in order, timed, and the spell ends at the finish", () => {
  const marks = [
    { x: 0, y: 300 },
    { x: 300, y: 300 },
    { x: 0, y: 0 },
  ];
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 270 }, { heading: 0, autoTrim: true }, { markM: 0, markBearing: 0, marks, markRadiusM: 40 });
  const steer = () => {
    const rel = wrap180(w.markBearing() - w.s.heading);
    return { helm: Math.max(-1, Math.min(1, rel / 20)), sheet: 0 };
  };
  for (let t = 0; t < 900 && !w.s.done; t += 1 / 30) w.step(1 / 30, steer());
  assert.equal(w.s.done, true);
  assert.equal(w.s.aground, false);
  assert.equal(w.s.markTimes.length, 3);
  assert.ok(w.s.markTimes[0] < w.s.markTimes[1] && w.s.markTimes[1] < w.s.markTimes[2]);
});

test("running aground ends the spell where she is", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 270 }, { heading: 0 }, { markM: 800, markBearing: 0 });
  for (let t = 0; t < 5; t += 1 / 30) w.step(1 / 30, { helm: 0, sheet: 0 });
  const y = w.s.y;
  w.ground();
  w.step(1, { helm: 0, sheet: 0 });
  assert.equal(w.s.done, true);
  assert.equal(w.s.aground, true);
  assert.equal(w.s.y, y);
});

test("where the mark is, in words", () => {
  assert.equal(aside(5), "dead ahead");
  assert.equal(aside(40), "ahead to the right");
  assert.equal(aside(-90), "to the left");
  assert.equal(aside(200), "behind you to the left");
  assert.equal(aside(180), "behind you");
});

test("the way out of the harbour: four marks down the channel to the open Bay, about 4 km", () => {
  const c = harbourExit();
  assert.equal(c.marks.length, 4);
  assert.deepEqual({ lat: c.marks[3].lat, lon: c.marks[3].lon }, ANNAPOLIS_COURSE);
  let m = 0;
  let p = toXY(c.start, c.start);
  for (const k of c.marks) {
    const q = toXY(c.start, k);
    m += Math.hypot(q.x - p.x, q.y - p.y);
    p = q;
  }
  assert.ok(m > 3500 && m < 4500, `${m} m`);
});

test("the finish gate off Thomas Point Light lies due east of it, clear of its stones, and is the run's finish", () => {
  const [a, b] = lightGate().map((g) => toXY(THOMAS_POINT, g));
  assert.ok(Math.abs(a.y) < 1);
  assert.ok(a.x > LIGHT_STONES_M + 50);
  assert.ok(b.x > a.x + 200);
  assert.ok(toTheLight().marks.at(-1)?.gate);
});

test("the gate counts a crossing either way, and not one outside it or west of the light", () => {
  const g0 = { x: 250, y: 0 };
  const g1 = { x: 650, y: 0 };
  assert.equal(crosses({ x: 400, y: 5 }, { x: 400, y: -5 }, g0, g1), true);
  assert.equal(crosses({ x: 400, y: -5 }, { x: 400, y: 5 }, g0, g1), true);
  assert.equal(crosses({ x: 800, y: 5 }, { x: 800, y: -5 }, g0, g1), false);
  assert.equal(crosses({ x: -300, y: 5 }, { x: -300, y: -5 }, g0, g1), false);
  assert.equal(crosses({ x: 400, y: 5 }, { x: 400, y: 1 }, g0, g1), false);
});
