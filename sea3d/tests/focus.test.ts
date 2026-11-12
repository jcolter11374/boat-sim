// The camera moment (src/focus.ts): eases in, holds, eases back to where it was, or hands over.
import assert from "node:assert/strict";
import { test } from "node:test";
import * as THREE from "three";
import { focusBoat } from "../src/focus";

function cam(): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(45, 1.5, 0.1, 1000);
  c.position.set(0, 6, 20);
  c.lookAt(0, 0, 0);
  return c;
}
const run = (f: { update(dt: number): boolean }, s: number) => {
  let on = true;
  for (let t = 0; t < s && on; t += 0.05) on = f.update(0.05);
  return on;
};

test("it comes in closer, holds, then goes back to the same view", async () => {
  const c = cam();
  const start = c.position.clone();
  const boat = new THREE.Vector3();
  const f = focusBoat(c, () => boat, { holdMs: 2000, easeMs: 800 });
  assert.equal(run(f, 0.85), true);
  const close = c.position.distanceTo(boat);
  assert.ok(close < start.distanceTo(boat) * 0.75, `came in to ${close.toFixed(1)} m`);
  assert.equal(run(f, 1.5), true, "still holding");
  assert.equal(run(f, 2), false, "finished");
  assert.ok(c.position.distanceTo(start) < 1e-6, "back where it started");
  await f.done;
});

test("returnTo none stops on the framing; cancel ends it at once", async () => {
  const c = cam();
  const boat = new THREE.Vector3();
  const pos = new THREE.Vector3(3, 2, 3);
  const framing = (t: THREE.Vector3) => ({ pos: t.clone().add(pos), quat: new THREE.Quaternion(), fov: 30 });
  const f = focusBoat(c, () => boat, { holdMs: 500, easeMs: 400, framing, returnTo: "none" });
  assert.equal(run(f, 2), false);
  assert.ok(c.position.distanceTo(pos) < 1e-6);
  assert.equal(c.fov, 30);
  await f.done;
  const g = focusBoat(cam(), () => boat);
  g.cancel();
  assert.equal(g.update(0.05), false);
  await g.done;
});
