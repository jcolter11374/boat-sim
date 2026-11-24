import { test } from "node:test";
import assert from "node:assert/strict";
import { LOOK, crewed, dragLook, eyeFor, lensAfterWheel } from "../src/helm/onboard";
import { KAYAK, RANDOLPH, STOCK } from "../src/boats/specs";

test("the eye is on the boat: between her bow and stern, above the water, on every boat", () => {
  for (const b of [KAYAK, RANDOLPH, ...Object.values(STOCK)]) {
    const e = eyeFor(b);
    const bow = b.cgX;
    const stern = b.cgX - b.length;
    assert.ok(e.x < bow && e.x > stern, `${b.key}: between bow and stern (${e.x.toFixed(2)})`);
    assert.ok(e.x < bow - b.length / 2, `${b.key}: aft of the middle, her deck ahead`);
    const above = e.y - b.cgBelowWaterline;
    assert.ok(above > 0.5 && above < 3, `${b.key}: ${above.toFixed(2)} m above the water`);
    assert.equal(e.kind, crewed(b) ? "helm" : "mast");
  }
});

test("the unmanned boats, whatever their length, get a camera on the stern mast, not a helm", () => {
  assert.equal(eyeFor(KAYAK).kind, "mast");
  assert.equal(eyeFor(RANDOLPH).kind, "mast");
  const drone = eyeFor(STOCK.stock_sail_drone7);
  assert.equal(drone.kind, "mast");
  assert.ok(drone.y - STOCK.stock_sail_drone7.cgBelowWaterline <= 1.6, "no higher than a mast camera would be");
  assert.equal(eyeFor(STOCK.stock_cruiser31).kind, "helm");
});

test("a rower's eye is a seated one, lower than a yacht's helm", () => {
  const r = STOCK.stock_ocean_rower45;
  assert.ok(eyeFor(r).y - r.cgBelowWaterline < 1.5);
});

test("the lens: a wheel notch is a few degrees, a trackpad's small steps are small, and it stops at its limits", () => {
  assert.ok(Math.abs(lensAfterWheel(60, 100) - 63) < 1e-9);
  assert.ok(Math.abs(lensAfterWheel(60, 4) - 60.12) < 1e-9);
  assert.equal(lensAfterWheel(79.9, 1000), LOOK.fovMax);
  assert.equal(lensAfterWheel(40.1, -1000), LOOK.fovMin);
});

test("dragging looks around, within what a neck allows", () => {
  let v = dragLook(0, 0, -100, 0, 800, LOOK.fov);
  assert.ok(v.yaw > 0 && v.pitch === 0, "dragging left turns the view right, as on the other cameras");
  v = dragLook(0, 0, 1e6, 1e6, 800, LOOK.fov);
  assert.equal(v.yaw, -LOOK.yaw);
  assert.equal(v.pitch, LOOK.up);
  v = dragLook(0, 0, 0, -1e6, 800, LOOK.fov);
  assert.equal(v.pitch, -LOOK.down);
});
