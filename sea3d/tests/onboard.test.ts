import { test } from "node:test";
import assert from "node:assert/strict";
import { CREWED_M, LOOK, dragLook, eyeFor } from "../src/helm/onboard";
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
    assert.equal(e.kind, b.length >= CREWED_M ? "helm" : "mast");
  }
});

test("our kayak and the Randolph drone are unmanned: a camera on the stern mast", () => {
  assert.equal(eyeFor(KAYAK).kind, "mast");
  assert.equal(eyeFor(RANDOLPH).kind, "mast");
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
