import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DROP_KM, LOAD_KM, kmToBox, landPlaces, nearestTile, placeOffset, type Tile } from "../src/land/nearby";
import { PLACES } from "../src/land/place";

// The boxes the land-data release covers (each <land>_meta.json).
const BOX: Record<string, [number, number, number, number]> = {
  pico: [38.36, 38.66, -28.86, -28.0],
  baymouth: [36.88, 37.12, -76.12, -75.88],
  lisbon: [38.62, 38.82, -9.52, -9.08],
  annapolis: [38.92, 39.02, -76.56, -76.4],
};
const tiles: Tile[] = landPlaces().map((place) => {
  const [lat0, lat1, lon0, lon1] = BOX[place.key];
  return { place, lat0, lat1, lon0, lon1 };
});

test("one place per set of land files: Horta shares Pico's, Annapolis has its own", () => {
  assert.deepEqual(landPlaces().map((p) => p.key).sort(), ["annapolis", "baymouth", "lisbon", "pico"]);
  assert.ok(LOAD_KM < DROP_KM, "a margin so the land doesn't flicker at the edge");
});

test("distance to a land box: zero inside, true kilometres outside", () => {
  const b = BOX.baymouth;
  const box = { lat0: b[0], lat1: b[1], lon0: b[2], lon1: b[3] };
  assert.equal(kmToBox(box, 37, -76), 0);
  assert.ok(Math.abs(kmToBox(box, 37.12 + 0.1, -76) - 11.1) < 0.1, "0.1 degree north");
  assert.ok(Math.abs(kmToBox(box, 37, -75.88 + 0.1) - 8.9) < 0.1, "0.1 degree east at 37N");
});

test("the Bay-mouth ports' launch point brings Cape Henry into view; the usual drop is too far out", () => {
  const ports = JSON.parse(readFileSync(new URL("../public/ports.json", import.meta.url), "utf8")).ports as { id: string; launch_lat: number; launch_lon: number }[];
  const norfolk = ports.find((p) => p.id === "norfolk")!;
  const n = nearestTile(tiles, norfolk.launch_lat, norfolk.launch_lon)!;
  assert.equal(n.tile.place.key, "baymouth");
  assert.ok(n.km < LOAD_KM, `${n.km} km`);
  const drop = nearestTile(tiles, 36.65, -74.94)!;
  assert.ok(drop.km > LOAD_KM, `the drop ${drop.km} km`);
});

test("a place's frame sits east and south of the boat in metres", () => {
  const p = PLACES.baymouth;
  const o = placeOffset(p, p.lat - 0.1, p.lon - 0.1);
  assert.ok(o.x > 8800 && o.x < 9000, `east ${o.x}`);
  assert.ok(o.z < -11000 && o.z > -11200, `north is -z: ${o.z}`);
  const at = placeOffset(p, p.lat, p.lon);
  assert.equal(at.x, 0);
  assert.equal(Math.abs(at.z), 0);
});
