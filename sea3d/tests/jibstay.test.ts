import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { StockRig } from "../src/boats/stock";

// The Pearson 31-2's rig as blender/build_stock.py builds it (builder frame: x aft from the bow, y up):
// the jib pivot at the stay's foot, a 135% genoa whose clew is well aft of the mast.
const MX = 4.06; // mast, metres aft of the bow
const MAST_R = 0.075;
const BOW = new THREE.Vector3(0.16, 1.1, 0);
const YM = 1.5; // mast foot
const MH = 13.2; // mast height above its foot

function pearsonRig(): { g: THREE.Group; jib: THREE.Mesh } {
  const g = new THREE.Group();
  const pivot = new THREE.Group();
  pivot.name = "jib_pivot";
  pivot.position.copy(BOW);
  g.add(pivot);
  const tack = new THREE.Vector3(0.3, 1.5, 0).sub(BOW);
  const head = new THREE.Vector3(MX - 0.25, YM + MH - 0.9, 0).sub(BOW);
  const clew = new THREE.Vector3(0.16 + 1.35 * 3.9, 1.65, 0).sub(BOW);
  // A flat sheet (no camber: the worst case for the mast), finely divided.
  const pos: number[] = [];
  const n = 40;
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n - i; j++) {
      const p = tack.clone().multiplyScalar(1 - (i + j) / n).addScaledVector(head, i / n).addScaledVector(clew, j / n);
      pos.push(p.x, p.y, p.z);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  const jib = new THREE.Mesh(geo, new THREE.MeshBasicMaterial());
  jib.name = "sail_jib";
  pivot.add(jib);
  return { g, jib };
}

/** Settle the rig with the apparent wind `awaDeg` off the bow, from port (side 1) or starboard (-1). */
function settle(rig: StockRig, awaDeg: number, side: 1 | -1): void {
  const a = THREE.MathUtils.degToRad(awaDeg);
  // The air moves away from where the wind comes from: from port means air moving to starboard (+z).
  const flow = { x: -Math.cos(a) * 6, z: side * Math.sin(a) * 6 };
  for (let i = 0; i < 400; i++) rig.update(0.05, { flow, plan: "full", rudder: 0 });
}

test("the genoa turns about its forestay and passes the mast to leeward on every point of sail", () => {
  for (const side of [1, -1] as const)
    for (const awa of [30, 45, 60, 90, 120, 150, 175]) {
      const { g, jib } = pearsonRig();
      const rig = new StockRig("stock_pearson31_2", g);
      settle(rig, awa, side);
      g.updateMatrixWorld(true);
      const at = jib.geometry.getAttribute("position");
      const v = new THREE.Vector3();
      let topY = -Infinity;
      let head = new THREE.Vector3();
      for (let i = 0; i < at.count; i++) {
        v.fromBufferAttribute(at, i).applyMatrix4(jib.matrixWorld);
        if (v.y > topY) [topY, head] = [v.y, v.clone()];
        const nearMast = Math.hypot(v.x - MX, v.z) < MAST_R && v.y > YM && v.y < YM + MH;
        assert.ok(!nearMast, `awa ${awa} side ${side}: the sail goes through the mast at x ${v.x.toFixed(2)} y ${v.y.toFixed(2)} z ${v.z.toFixed(3)}`);
      }
      // The head stays on the stay: where it was built (not swung off to the side).
      assert.ok(Math.abs(head.z) < 0.02, `awa ${awa}: the head left the forestay (z ${head.z.toFixed(2)} m)`);
      // And the sail is out to leeward: the side the air is going to (builder z is the boat's -z).
      const clew = new THREE.Vector3().fromBufferAttribute(at, 40).applyMatrix4(jib.matrixWorld);
      assert.ok(Math.sign(clew.z) === -side, `awa ${awa}: the clew is to windward`);
    }
});
