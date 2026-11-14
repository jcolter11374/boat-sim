import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StockRig } from "../src/boats/stock";
import { idleGear } from "../src/boats/gear";

/** A Blender-named rig: a main and a genoa on their pivots. */
function rigged() {
  const g = new THREE.Group();
  const sail = (name: string) => new THREE.Mesh(new THREE.BufferGeometry().setAttribute("position", new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0.3], 3)), new THREE.MeshBasicMaterial());
  const main = new THREE.Group();
  main.name = "main_pivot";
  const m = sail("sail_main");
  m.name = "sail_main";
  main.add(m);
  const jib = new THREE.Group();
  jib.name = "jib_pivot";
  const j = sail("sail_jib");
  j.name = "sail_jib";
  jib.add(j);
  g.add(main, jib);
  return { rig: new StockRig("stock_pearson31_2", g), main, jib };
}

test("head to the title's light breeze, the sails stay on one side of the mast (no flip as the boom flogs)", () => {
  const { rig, main, jib } = rigged();
  let flips = 0;
  let was = 0;
  for (let i = 0; i < 60 * 40; i++) {
    const t = 3 + i / 60;
    rig.update(1 / 60, { flow: idleGear(t).flow, plan: "full", rudder: 0 });
    if (was && main.scale.z !== was) flips++;
    was = main.scale.z;
    assert.equal(jib.scale.z, main.scale.z, "main and genoa belly the same way");
  }
  assert.equal(flips, 0, "the mirror never flipped in 40 s (it flipped every half second)");
});

test("a real tack: once the wind fills on the other side, the sails cross once and the boom follows", () => {
  const { rig, main } = rigged();
  const flow = (deg: number) => {
    const a = THREE.MathUtils.degToRad(deg); // wind from deg off the bow, + from port
    return { x: -5 * Math.cos(a), z: 5 * Math.sin(a) };
  };
  for (let i = 0; i < 300; i++) rig.update(1 / 60, { flow: flow(45), plan: "full", rudder: 0 });
  const before = main.scale.z;
  assert.ok(rig.shown.boom > 0, "wind from port: boom out to starboard");
  let flips = 0;
  let was = before;
  for (let deg = 45; deg >= -45; deg -= 0.5) {
    rig.update(1 / 60, { flow: flow(deg), plan: "full", rudder: 0 });
    if (main.scale.z !== was) flips++;
    was = main.scale.z;
  }
  for (let i = 0; i < 600; i++) rig.update(1 / 60, { flow: flow(-45), plan: "full", rudder: 0 });
  assert.equal(flips, 1, "one crossing");
  assert.equal(main.scale.z, -before);
  assert.ok(rig.shown.boom < 0, "boom out to port on the new tack");
});
