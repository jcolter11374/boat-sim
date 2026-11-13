import { test } from "node:test";
import assert from "node:assert/strict";
import { SQUARE_DROP_KM, SQUARE_KM, inside, kmToSquare, plan, squarePlace, type Square } from "../src/land/squares";

// Three squares of the first set (bay_index.json): Annapolis, east of it, and open water.
const town: Square = { key: "3895n7650w", box: [-76.5, -76.45, 38.95, 39.0], kind: "shore" };
const east: Square = { key: "3895n7645w", box: [-76.45, -76.4, 38.95, 39.0], kind: "shore" };
const far: Square = { key: "3885n7655w", box: [-76.55, -76.5, 38.85, 38.9], kind: "shore" };
const open: Square = { key: "3890n7645w", box: [-76.45, -76.4, 38.9, 38.95], kind: "sea" };
const all = [town, east, far, open];

test("distance to a square: zero inside, true kilometres outside", () => {
  assert.equal(kmToSquare(town, 38.97, -76.48), 0);
  assert.ok(Math.abs(kmToSquare(town, 39.1, -76.48) - 11.1) < 0.1);
  assert.ok(SQUARE_KM < SQUARE_DROP_KM, "a margin so squares don't flicker at the edge");
});

test("the squares near the boat load, nearest first; open water and far ones don't", () => {
  const p = plan(all, new Set(), 38.995, -76.47, null);
  assert.deepEqual(p.load.map((s) => s.key), ["3895n7650w", "3895n7645w"]);
  assert.deepEqual(p.drop, []);
});

test("squares behind the boat drop only past the margin", () => {
  // 10 km south of Annapolis's square: out of load range, inside the drop margin.
  const lat = 38.95 - 10 / 110.95;
  const kept = plan(all, new Set([town.key]), lat, -76.47, null);
  assert.deepEqual(kept.drop, []);
  const gone = plan(all, new Set([town.key]), 38.95 - 0.2, -76.47, null);
  assert.deepEqual(gone.drop, [town.key]);
});

test("a square wholly inside a finer place's box isn't loaded at all", () => {
  const hole = { lon0: -76.56, lon1: -76.4, lat0: 38.92, lat1: 39.02 }; // annapolisbay
  assert.ok(inside(town, hole) && inside(east, hole) && !inside(far, hole) && !inside(town, null));
  assert.deepEqual(plan(all, new Set(), 38.995, -76.47, hole).load, []);
});

test("a square's frame is centred on it, with a sheltered shore", () => {
  const p = squarePlace(town);
  assert.equal(p.key, "bay_3895n7650w");
  assert.ok(Math.abs(p.lat - 38.975) < 1e-9 && Math.abs(p.lon + 76.475) < 1e-9);
  assert.equal(p.shore, "plain");
  assert.ok(p.fetch && p.fetch > 0);
});
