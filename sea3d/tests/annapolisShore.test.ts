import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SEAMARKS, SEAMARK_RANGE, Seamarks, LAMP_M, markFlash, markGeometry } from "../src/land/seamarks";
import { BAY_BRIDGE, BRIDGE_RANGE, BayBridge, deckHeight, roadLamps, spanGeometry } from "../src/land/bayBridge";
import { bearingTo, offsetOf } from "../src/land/landmarks";
import { ANNAPOLIS_COURSE } from "../src/helm/course";
import { REFLECT_FULL_M, reflectFade } from "../src/land/town";

const C = ANNAPOLIS_COURSE;
const from = (m: { lat: number; lon: number }) => {
  const o = offsetOf(m, C.lat, C.lon);
  return { km: Math.hypot(o.x, o.z) / 1000, bearing: bearingTo(m, C.lat, C.lon) };
};

test("the real marks off Annapolis are where the sheet puts them, round the practice course", () => {
  assert.equal(new Set(SEAMARKS.map((m) => m.key)).size, SEAMARKS.length);
  for (const m of SEAMARKS) assert.ok(from(m).km < 7, `${m.name} is ${from(m).km.toFixed(1)} km off`);
  // NOAA's yellow buoy is on the course itself, just north of its middle.
  const an = from(SEAMARKS.find((m) => m.key === "AN")!);
  assert.ok(an.km > 0.25 && an.km < 0.45 && (an.bearing > 350 || an.bearing < 10), `AN ${an.km.toFixed(2)} km at ${an.bearing.toFixed(0)}`);
  // The fixed light off Tolly Point is to the south, Severn River buoy 5 towards the town (north-west).
  const ah = from(SEAMARKS.find((m) => m.key === "1AH")!);
  assert.ok(ah.km > 2.4 && ah.km < 3.2 && ah.bearing > 150 && ah.bearing < 175, `1AH ${ah.km.toFixed(1)} km at ${ah.bearing.toFixed(0)}`);
  const five = from(SEAMARKS.find((m) => m.key === "5")!);
  assert.ok(five.bearing > 300 && five.bearing < 320, `5 at ${five.bearing.toFixed(0)}`);
});

test("green marks are odd and flat-topped or lit, red marks even; each shape stands out of the water", () => {
  for (const m of SEAMARKS) {
    const n = parseInt(m.key.replace(/\D/g, ""), 10);
    if (m.colour === "green") assert.equal(n % 2, 1, m.name);
    if (m.colour === "red") assert.equal(n % 2, 0, m.name);
    if (m.shape === "can") assert.equal(m.colour, "green");
    if (m.shape === "nun") assert.equal(m.colour, "red");
    assert.equal(!!m.period, m.shape === "lit" || m.shape === "post", `${m.name}: lit marks flash, plain ones don't`);
  }
  for (const shape of ["can", "nun", "lit", "post"] as const) {
    const g = markGeometry(shape);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    assert.ok(b.max.y > 1.5 && b.max.y < 6 && b.min.y < 0, `${shape}: ${b.min.y} to ${b.max.y}`);
    if (LAMP_M[shape]) assert.ok(LAMP_M[shape] >= b.max.y - 0.5, `${shape}: the lamp is on top`);
  }
});

test("each lit mark flashes once in its period, and not all together", () => {
  const lit = SEAMARKS.filter((m) => m.period);
  for (const m of lit) {
    let on = 0;
    let rises = 0;
    let last = markFlash(m, 0);
    const N = 2000;
    for (let i = 1; i <= N; i++) {
      const v = markFlash(m, (i / N) * m.period! * 3);
      if (v > 0.5) on++;
      if (v > 0.5 && last <= 0.5) rises++;
      last = v;
    }
    assert.ok(rises === 3 || rises === 2, `${m.name}: ${rises} flashes in three periods`);
    assert.ok(on / N > 0.05 && on / N < 0.4, `${m.name}: on ${(on / N).toFixed(2)} of the time`);
  }
  const four = lit.filter((m) => m.period === 4);
  const firstOn = four.map((m) => {
    for (let t = 0; t < 4; t += 0.05) if (markFlash(m, t) > 0.5) return Math.round(t * 2);
    return -1;
  });
  assert.ok(new Set(firstOn).size > 1, `the 4 s lights are out of step: ${firstOn}`);
});

test("the marks show round the course, float on the sea, and none are built far from Annapolis", () => {
  const far = new Seamarks();
  far.update(38.74, -9.56, 0, 0.5);
  assert.equal(far.count, 0);
  assert.equal(far.root.children.length, 0);
  const s = new Seamarks();
  s.update(C.lat, C.lon, 0, 0.5, () => 0.4);
  assert.equal(s.count, SEAMARKS.length);
  const an = s.root.getObjectByName("seamark-AN")!;
  assert.ok(an.visible && an.position.z < -250 && an.position.z > -450, `AN north of the boat: ${an.position.z}`);
  assert.ok(Math.abs(an.position.y - 0.4) < 0.05, "a buoy rides the water");
  const post = s.root.getObjectByName("seamark-1AH")!;
  assert.ok(post.position.y < 0.05, "a fixed light stands on the bottom, it doesn't ride the waves");
  assert.ok(SEAMARK_RANGE > 7000);
  s.dispose();
  assert.equal(s.root.children.length, 0);
});

test("the Bay Bridge: north-east of the course, its length and heights as built", () => {
  const b = from(BAY_BRIDGE);
  assert.ok(b.km > 6 && b.km < 8.5 && b.bearing > 50 && b.bearing < 75, `${b.km.toFixed(1)} km at ${b.bearing.toFixed(0)}`);
  assert.ok(b.km * 1000 < BRIDGE_RANGE);
  // 56.7 m clear under the main span; low near both shores; the road never steeper than a highway.
  assert.ok(deckHeight(BAY_BRIDGE.main) - 3 >= BAY_BRIDGE.clearance - 0.01);
  assert.ok(deckHeight(-BAY_BRIDGE.length / 2) < 20 && deckHeight(BAY_BRIDGE.length / 2) < 20);
  for (let s = -3200; s < 3200; s += 10) assert.ok(Math.abs(deckHeight(s + 10) - deckHeight(s)) <= 0.31, `grade at ${s}`);
  for (const sp of BAY_BRIDGE.spans) {
    const g = spanGeometry(sp.tower, sp.width);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    assert.ok(Math.abs(box.max.x - box.min.x - BAY_BRIDGE.length) < 60, `length ${box.max.x - box.min.x}`);
    assert.ok(Math.abs(box.max.y - sp.tower) < 3, `tower top ${box.max.y} for ${sp.tower}`);
    assert.ok(g.getAttribute("position").count < 40000, `light enough: ${g.getAttribute("position").count} corners`);
  }
  assert.ok(roadLamps().every((l) => l.y > deckHeight(l.s)));
});

test("the bridge runs from Sandy Point towards Kent Island, and is only drawn near Annapolis", () => {
  const br = new BayBridge();
  br.update(38.74, -9.56, 0.5);
  assert.equal(br.shown, false);
  assert.equal(br.root.children.length, 0);
  br.update(C.lat, C.lon, 0.5);
  assert.equal(br.shown, true);
  br.root.updateMatrixWorld(true);
  // Its eastern end is further east and further south than its western end.
  const w = new THREE.Vector3(-BAY_BRIDGE.length / 2, 0, 0).applyMatrix4(br.root.matrixWorld);
  const e = new THREE.Vector3(BAY_BRIDGE.length / 2, 0, 0).applyMatrix4(br.root.matrixWorld);
  assert.ok(e.x > w.x + 5000 && e.z > w.z + 2500, `west ${w.x.toFixed(0)},${w.z.toFixed(0)} east ${e.x.toFixed(0)},${e.z.toFixed(0)}`);
  // All of it is north of the course.
  assert.ok(w.z < 0 && e.z < 0);
  br.dispose();
});

test("the town's lights on the water: full in the harbour, a faint shimmer from the course", () => {
  assert.equal(reflectFade(300), 1);
  assert.equal(reflectFade(REFLECT_FULL_M), 1);
  assert.ok(Math.abs(reflectFade(3500) - 0.33) < 0.01, `about a third from the course: ${reflectFade(3500)}`);
  assert.ok(reflectFade(20000) >= 0.33);
  for (let d = 100; d < 8000; d += 100) assert.ok(reflectFade(d + 100) <= reflectFade(d));
});
