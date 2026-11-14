import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ARRIVAL, ARRIVAL_AT, ARRIVAL_S, CABO_DA_ROCA, arrivalShot } from "../src/helm/arrivalShot";
import { bearingTo } from "../src/land/landmarks";
import type { FramingHost } from "../src/framing";

const host = (headingDeg: number, aspect = 16 / 9, len = 3.05, tall = 0): FramingHost => ({
  camera: new THREE.PerspectiveCamera(50, aspect, 0.1, 1e6),
  controls: { target: new THREE.Vector3(0, 0.3, 0) },
  water: () => 0,
  // The boat's heading as scene yaw: bow along (cos yaw, 0, -sin yaw); heading 90 (east) is yaw 0.
  yaw: () => THREE.MathUtils.degToRad(90 - headingDeg),
  length: () => len,
  height: () => tall,
});
const cape = bearingTo(CABO_DA_ROCA, ARRIVAL_AT[0], ARRIVAL_AT[1]);

test("the finish shot: the boat on a third, the cape in the frame on the open side, whatever her heading", () => {
  for (const heading of [0, 45, 90, 135, 180, 225, 270, 315]) {
    for (const aspect of [16 / 9, 4 / 3, 9 / 16]) {
      const s = arrivalShot(host(heading, aspect), cape, 0);
      assert.ok(Math.abs(s.cape) < 0.85, `cape in frame (${heading}, ${aspect.toFixed(2)}): ${s.cape}`);
      assert.ok(Math.abs(s.boat) < 0.75, `boat in frame (${heading}, ${aspect.toFixed(2)}): ${s.boat}`);
      assert.ok(Math.abs(s.cape - s.boat) > 0.25, `the cape beside her, not behind her (${heading}, ${aspect.toFixed(2)}): ${s.cape} ${s.boat}`);
    }
  }
});

test("the finish shot is low, level and long-lensed, and looks towards the cape", () => {
  const s = arrivalShot(host(70), cape, 0);
  assert.equal(s.fov, ARRIVAL.fov);
  assert.ok(s.pos.y > 0.5 && s.pos.y < 2.5, `a chase boat's height: ${s.pos.y}`);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(s.quat);
  const looks = (THREE.MathUtils.radToDeg(Math.atan2(fwd.x, -fwd.z)) + 360) % 360;
  const off = Math.abs(((looks - cape + 540) % 360) - 180);
  assert.ok(off < 20, `looks ${looks.toFixed(0)}, the cape bears ${cape.toFixed(0)}`);
  assert.ok(Math.abs(fwd.y) < 0.1, "nearly level: the horizon and the coast in frame");
});

test("a slow push in: closer by the end, never a jump, and it stops when the scene's time is up", () => {
  const h = host(cape + 90); // side-on to the lens (end-on she is already as close as her bow allows)
  const d = (t: number) => arrivalShot(h, cape, t).pos.length();
  assert.ok(d(ARRIVAL_S) < d(0) * 0.96, `${d(0)} to ${d(ARRIVAL_S)}`);
  for (let t = 0; t < ARRIVAL_S; t += 0.5) assert.ok(Math.abs(d(t + 0.5) - d(t)) < 0.02 * d(0), `step at ${t}`);
  assert.equal(d(ARRIVAL_S + 30), d(ARRIVAL_S));
});

test("a yacht's mast fits: the camera stands back for a tall boat", () => {
  const kayak = arrivalShot(host(70), cape, 0).pos.length();
  const yacht = arrivalShot(host(70, 16 / 9, 9.6, 14), cape, 0).pos.length();
  assert.ok(yacht > 2 * kayak, `${kayak} ${yacht}`);
});
