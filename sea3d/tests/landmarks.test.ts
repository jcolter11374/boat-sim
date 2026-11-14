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
  drawnTower,
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

const roca = LANDMARKS.find((l) => l.key === "cabodaroca")!;

test("Cabo da Roca light stands on its cliff, in sight of the finish scene", async () => {
  const { ARRIVAL_AT, CABO_DA_ROCA } = await import("../src/helm/arrivalShot");
  assert.deepEqual([roca.lat, roca.lon], [CABO_DA_ROCA.lat, CABO_DA_ROCA.lon]);
  assert.ok((roca.base ?? 0) + roca.light!.focal > 125 && (roca.base ?? 0) + roca.light!.focal < 170, "on the cliff top, well above the sea");
  const o = offsetOf(roca, ARRIVAL_AT[0], ARRIVAL_AT[1]);
  const km = Math.hypot(o.x, o.z) / 1000;
  assert.ok(km > 5 && km < 9, `${km} km: near enough for the cliff to stand up, far enough to be on the horizon`);
  assert.ok(km < LANDMARK_KM, "so the light is loaded");
  const b = bearingTo(roca, ARRIVAL_AT[0], ARRIVAL_AT[1]);
  assert.ok(b > 30 && b < 70, `to the north-east, as for a boat coming in from the Atlantic (${b})`);
  // The stand-in: a tower with its lamp at the focal height.
  let lamp = -1;
  drawnTower(roca.light!.focal).traverse((x) => {
    if (x.name === "lamp") lamp = x.position.y;
  });
  assert.equal(lamp, roca.light!.focal);
});

test("a group flashing light: four flashes close together, then dark until the period ends", () => {
  const l = roca.light!;
  assert.equal(l.group, 4);
  let flashes = 0;
  let was = false;
  for (let t = 0; t < l.period; t += 0.01) {
    const on = flashAt(l, t) > 0;
    if (on && !was) flashes++;
    was = on;
  }
  assert.equal(flashes, 4);
  assert.equal(flashAt(l, 3 * l.gap! + l.flash + 0.5), 0, "dark after the fourth");
  assert.equal(flashAt(l, l.period - 0.5), 0);
  assert.ok(flashAt(l, l.period + 0.25) > 0.9, "and round again");
});

test("coast lights stand on the land, near their towns, the same every time", async () => {
  const { LISBON_COAST, groundAt, lightSpots } = await import("../src/land/coastLights");
  // A grid over the Lisbon box: sea in the west third, land rising to the east.
  const meta = { nx: 200, ny: 100, lon0: -9.52, lon1: -9.08, lat0: 38.62, lat1: 38.82 };
  const hgt = new Int16Array(meta.nx * meta.ny);
  for (let y = 0; y < meta.ny; y++) for (let x = 0; x < meta.nx; x++) hgt[y * meta.nx + x] = x < 18 ? -20 : x;
  const g = { meta, hgt };
  assert.equal(groundAt(g, 38.7, -9.6), null);
  assert.equal(groundAt(g, 38.819, -9.519), -20);
  assert.ok(groundAt(g, 38.7, -9.2)! > 100);
  const a = lightSpots(LISBON_COAST, g);
  assert.deepEqual(a, lightSpots(LISBON_COAST, g));
  const want = LISBON_COAST.reduce((n, t) => n + t.lights, 0);
  assert.ok(a.length > 0.8 * want && a.length <= want, `${a.length} of ${want}`);
  for (const s of a) {
    const t = LISBON_COAST[s.town];
    assert.ok(groundAt(g, s.lat, s.lon)! > 2, "on land");
    assert.ok(Math.hypot((s.lat - t.lat) * 111000, (s.lon - t.lon) * 86700) <= t.spread * 1.02, `${t.name}`);
    assert.ok(s.y > groundAt(g, s.lat, s.lon)!, "above the ground");
  }
  assert.ok(LISBON_COAST.reduce((n, t) => n + t.lights, 0) < 200, "sparse");
});
