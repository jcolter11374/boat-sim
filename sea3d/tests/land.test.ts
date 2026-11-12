import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSea } from "../src/land/place";
import { treeSpots, TREE_CLASS, type TreeOptions } from "../src/land/trees";
import { insideRing, nightOf, ringArea } from "../src/land/town";
import { distanceField } from "../src/land/shader";

test("harbour chop: about 0.3 m and 2 s for a 10 m/s breeze over 3 km, growing with wind and fetch", () => {
  const c = fetchSea(10, 3000);
  assert.ok(c.hs > 0.22 && c.hs < 0.35, `hs ${c.hs}`);
  assert.ok(c.tp > 1.6 && c.tp < 2.3, `tp ${c.tp}`);
  assert.ok(fetchSea(15, 3000).hs > c.hs && fetchSea(10, 10000).hs > c.hs);
  // Never more than a fully developed sea, however long the fetch.
  const open = fetchSea(5, 1e9);
  assert.ok(open.hs <= 0.0214 * 25 + 1e-9 && open.tp <= 0.73 * 5 + 1e-9);
  assert.ok(fetchSea(0, 3000).hs > 0, "calm still has a ripple");
});

test("the evening: no lights by day, all on once it's dark", () => {
  assert.equal(nightOf(20), 0);
  assert.equal(nightOf(-10), 1);
  assert.ok(nightOf(0) > 0 && nightOf(0) < 1);
});

test("rings: winding and inside", () => {
  // Anticlockwise seen from above with x east and z south: east side going north first.
  const sq: [number, number][] = [
    [10, 10],
    [10, 0],
    [0, 0],
    [0, 10],
  ];
  assert.ok(ringArea(sq) < 0);
  assert.equal(Math.abs(ringArea(sq)), 100);
  assert.ok(insideRing(sq, 5, 5));
  assert.ok(!insideRing(sq, 15, 5));
});

test("distance field: 0 on the seed, cells away elsewhere", () => {
  const d = distanceField(5, 1, (k) => k === 0);
  assert.deepEqual(Array.from(d), [0, 1, 2, 3, 4]);
});

// A 100 x 100 grid of 10 m cells around the boat: all wood on land, the west half water.
const N = 101;
const lat = 39;
const lon = -76.5;
const mx = 111320 * Math.cos((lat * Math.PI) / 180);
const grid = { nx: N, ny: N, lon0: lon - (50 * 10) / mx, lon1: lon + (50 * 10) / mx, lat0: lat - 500 / 110950, lat1: lat + 500 / 110950 };
const cls = new Uint8Array(N * N).fill(TREE_CLASS);
const hgt = new Int16Array(N * N).map((_, k) => (k % N < 50 ? 0 : 5));
const O: TreeOptions = { radius: 400, max: 5000, near: 1000, perCell: 1, seed: 7 };

test("trees: on the wooded land only, the same every time", () => {
  const a = treeSpots(grid, cls, hgt, { lat, lon }, O);
  const b = treeSpots(grid, cls, hgt, { lat, lon }, O);
  assert.deepEqual(a, b);
  const n = a.length / 5;
  assert.ok(n > 1500 && n < 2600, `${n} trees`); // about half the 400 m circle, one per cell
  for (let k = 0; k < n; k++) {
    assert.ok(a[k * 5] > -12, "none in the water to the west");
    assert.ok(Math.hypot(a[k * 5], a[k * 5 + 2]) < 410);
    assert.ok(a[k * 5 + 3] > 5 && a[k * 5 + 3] < 30, "height");
  }
});

test("trees: thin evenly to the cap, keep out of buildings, add mapped ones off the wood", () => {
  const capped = treeSpots(grid, cls, hgt, { lat, lon }, { ...O, max: 300 });
  const n = capped.length / 5;
  assert.ok(n > 200 && n <= 300, `${n}`);
  let far = 0;
  for (let k = 0; k < n; k++) if (capped[k * 5] > 200) far++;
  assert.ok(far > 50, "thinned across the whole circle, not just stopped");
  const none = treeSpots(grid, cls, hgt, { lat, lon }, O, (x) => x > 0);
  for (let k = 0; k < none.length / 5; k++) assert.ok(none[k * 5] <= 0);
  const bare = new Uint8Array(N * N).fill(2);
  const one = treeSpots(grid, bare, hgt, { lat, lon }, O, undefined, { points: [[lon + 100 / mx, lat, 12]] });
  assert.equal(one.length / 5, 1);
  assert.ok(Math.abs(one[0] - 100) < 0.5 && one[3] === 12);
  const doubled = treeSpots(grid, cls, hgt, { lat, lon }, O, undefined, { points: [[lon + 100 / mx, lat, 12]] });
  assert.equal(doubled.length, treeSpots(grid, cls, hgt, { lat, lon }, O).length, "no extra tree inside a wood");
});

test("trees on the Bay's squares: decimetre heights, more per bigger cell, laid out at a shared latitude", () => {
  // The same land in decimetres (scale 0.1): the same trees, standing on the same ground.
  const dm = new Int16Array(N * N).map((_, k) => (k % N < 50 ? 0 : 50));
  const a = treeSpots(grid, cls, hgt, { lat, lon }, O);
  const b = treeSpots({ ...grid, scale: 0.1 }, cls, dm, { lat, lon }, O);
  assert.deepEqual(a, b);
  // tree_cell 3: about three times the trees from the same cells.
  const big = { ...O, max: 50000 };
  const c = treeSpots({ ...grid, tree_cell: 3 }, cls, hgt, { lat, lon }, big);
  const r = c.length / treeSpots(grid, cls, hgt, { lat, lon }, big).length;
  assert.ok(r > 2.6 && r < 3.4, `${r}`);
  // Laid out at a latitude a little south: about the same trees, a touch wider apart east-west.
  const d = treeSpots(grid, cls, hgt, { lat, lon, mid: lat - 0.05 }, O);
  assert.ok(Math.abs(d.length / a.length - 1) < 0.02);
  assert.notDeepEqual(d, a);
});
