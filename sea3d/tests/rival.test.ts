import { test } from "node:test";
import assert from "node:assert/strict";
import { RIVAL_CLEAR_M, rivalOffset } from "../src/helm/rival.ts";

test("two boats launched from one spot are drawn side by side, not inside each other", () => {
  const o = rivalOffset([36.65, -74.94], [36.65, -74.94], 90); // heading east: starboard is south
  assert.equal(o.m, 0);
  assert.ok(Math.abs(o.dx) < 1e-6);
  assert.ok(Math.abs(o.dz - RIVAL_CLEAR_M) < 1e-6, "25 m to the south (+z)");
  const n = rivalOffset([36.65, -74.94], [36.65, -74.94], 0); // heading north: starboard is east
  assert.ok(Math.abs(n.dx - RIVAL_CLEAR_M) < 1e-6 && Math.abs(n.dz) < 1e-6);
});

test("once the boats are apart she is drawn where she really is", () => {
  // 0.01 degrees north is about 1.1 km.
  const o = rivalOffset([40, -50], [40.01, -50], 90);
  assert.ok(Math.abs(o.m - 1113.2) < 0.5);
  assert.ok(Math.abs(o.dx) < 1e-6 && Math.abs(o.dz + 1113.2) < 0.5, "north is -z, with no side-step left");
  // East shrinks with latitude.
  const e = rivalOffset([60, 0], [60, 0.01], 0);
  assert.ok(Math.abs(e.dx - 556.6) < 0.5);
});
