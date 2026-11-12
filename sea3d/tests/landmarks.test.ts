import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LANDMARKS,
  LANDMARK_DROP_KM,
  LANDMARK_KM,
  RED,
  WHITE,
  bearingTo,
  drawnLighthouse,
  flashAt,
  offsetOf,
  planLandmarks,
  sectorColour,
} from "../src/land/landmarks";

const tp = LANDMARKS.find((l) => l.key === "thomaspoint")!;

test("Thomas Point Light sits off Thomas Point, inside the first coast squares", () => {
  assert.ok(tp.lat > 38.85 && tp.lat < 39.05 && tp.lon > -76.55 && tp.lon < -76.4);
  assert.equal(tp.light?.focal, 13); // 43 ft
});

test("offset and bearing: 1 km north of the light, it's due south and 1 km off", () => {
  const lat = tp.lat + 1 / 111.0;
  const o = offsetOf(tp, lat, tp.lon);
  assert.ok(Math.abs(o.z - 1000) < 15 && Math.abs(o.x) < 1e-6, `${o.x} ${o.z}`); // +z is south
  assert.ok(Math.abs(bearingTo(tp, lat, tp.lon) - 180) < 1e-6);
  assert.ok(Math.abs(bearingTo(tp, tp.lat, tp.lon - 0.02) - 90) < 0.5); // west of it: look east
});

test("the light's colour follows the light list's sectors", () => {
  const l = tp.light!;
  assert.equal(sectorColour(l, 30), RED);
  assert.equal(sectorColour(l, 70), WHITE);
  assert.equal(sectorColour(l, 150), RED);
  assert.equal(sectorColour(l, 300), WHITE);
  assert.equal(sectorColour(l, 5), WHITE); // the white sector runs through north
  assert.equal(sectorColour(l, 365), WHITE);
});

test("one flash every 5 seconds", () => {
  const l = tp.light!;
  assert.ok(flashAt(l, 0.3) > 0.9);
  assert.equal(flashAt(l, 2), 0);
  assert.ok(flashAt(l, 5.3) > 0.9);
  assert.equal(flashAt(l, 4.99), 0);
  let on = 0;
  for (let t = 0; t < 50; t += 0.01) if (flashAt(l, t) > 0) on++;
  assert.ok(on > 550 && on < 650, `${on}`); // ten flashes of 0.6 s, in 0.01 s steps
});

test("landmarks load within sight and drop past the margin", () => {
  assert.ok(LANDMARK_KM < LANDMARK_DROP_KM);
  // Annapolis harbour, about 9 km north of the light.
  const near = planLandmarks(LANDMARKS, new Set(), 38.975, -76.48);
  assert.deepEqual(near.load.map((l) => l.key), ["thomaspoint"]);
  const loaded = new Set(["thomaspoint"]);
  assert.deepEqual(planLandmarks(LANDMARKS, loaded, 38.975, -76.48).load, []);
  // 19 km south: out of load range but kept; 30 km: dropped.
  assert.deepEqual(planLandmarks(LANDMARKS, loaded, tp.lat - 19 / 111, tp.lon).drop, []);
  assert.deepEqual(planLandmarks(LANDMARKS, loaded, tp.lat - 30 / 111, tp.lon).drop, ["thomaspoint"]);
  // Out at sea, nothing.
  assert.deepEqual(planLandmarks(LANDMARKS, new Set(), 36.65, -74.94).load, []);
});

test("the drawn stand-in has a lamp at the light's height", () => {
  const g = drawnLighthouse(13);
  const lamp = g.getObjectByName("lamp");
  assert.ok(lamp);
  assert.equal(lamp!.position.y, 13);
});
