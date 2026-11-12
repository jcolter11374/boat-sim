// Channel marks (boats/buoys.ts): afloat on their waterline at the stated draft, lights
// where Sam hangs them, and piles that stay put.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BUOY_DRAFT, BUOY_FIXED, BUOY_KINDS, BUOY_LIGHT_HEIGHT, buoyGeometry, numberPlace } from "../src/boats/buoys";

test("floating marks go BUOY_DRAFT under; piles go into the bottom and stand still", () => {
  for (const kind of BUOY_KINDS) {
    const g = buoyGeometry(kind);
    g.computeBoundingBox();
    const b = g.boundingBox!;
    for (const a of ["position", "normal", "color"]) assert.ok(g.attributes[a], `${kind}: ${a}`);
    if (BUOY_FIXED.has(kind)) assert.ok(b.min.y < -1, `${kind}: pile reaches the bottom`);
    else assert.ok(Math.abs(b.min.y + BUOY_DRAFT) < 0.01, `${kind}: draft ${(-b.min.y).toFixed(2)}`);
    assert.ok(b.max.y > 1 && b.max.y < 5, `${kind}: height ${b.max.y.toFixed(2)}`);
    assert.ok(g.attributes.position.count < 6000, `${kind}: low poly (${g.attributes.position.count} vertices)`);
  }
  assert.deepEqual([...BUOY_FIXED].sort(), ["daybeacon_green", "daybeacon_red"]);
});

test("lit buoys have a lantern at the top; numbers sit on the mark above the water", () => {
  for (const kind of BUOY_KINDS) {
    const g = buoyGeometry(kind);
    g.computeBoundingBox();
    const h = BUOY_LIGHT_HEIGHT[kind];
    if (kind.startsWith("lit")) assert.ok(h !== null && h <= g.boundingBox!.max.y + 0.01 && h > 3.5, `${kind}: lantern at ${h}`);
    else assert.equal(h, null, `${kind}: unlit`);
    const p = numberPlace(kind);
    assert.ok(p.at.y - p.h / 2 > 0, `${kind}: number above the waterline`);
  }
});
