import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { PropWash, washStrength } from "../src/boats/propwash";

test("a motor's trail: full at cruising, none from a stopped propeller or a standing boat, thinner in a rough sea", () => {
  assert.ok(washStrength(29, 1) > 0.95, "cruising");
  assert.equal(washStrength(0, 1), 0, "a dead motor leaves none");
  assert.equal(washStrength(29, 0), 0, "a boat standing still leaves none");
  assert.ok(washStrength(29, 1, 5) < 0.5 && washStrength(29, 1, 5) > 0.2, "a gale breaks most of it up, not all");
  // A propeller running down: the trail dies with it, never jumps.
  let last = 1;
  for (let spin = 29; spin >= 0; spin -= 1) {
    const s = washStrength(spin, 1);
    assert.ok(s <= last + 1e-9 && last - s < 0.06, `spin ${spin}`);
    last = s;
  }
});

test("two motors, one dead: only the live motor's trail is drawn, and it runs astern on the water", () => {
  const w = new PropWash(2);
  w.surface = () => 0.4;
  const props = [new THREE.Vector3(-1.4, -0.1, 0.2), new THREE.Vector3(-1.4, -0.1, -0.2)];
  w.update(1, props, -1, 0, [29, 0], 1, 1, 0, 1);
  assert.deepEqual(w.shown.strength, [1, 0]);
  const k = w.mesh.material.uniforms.uK.value as THREE.Vector4;
  assert.equal(k.x, 1);
  assert.equal(k.y, 0);
  const pos = w.mesh.geometry.attributes.position.array as Float32Array;
  for (let i = 0; i < pos.length; i += 3) {
    assert.ok(pos[i] < -1.4 - 0.19, "astern of the propeller");
    assert.ok(Math.abs(pos[i + 1] - 0.43) < 1e-6, "on the water");
    assert.ok(Math.abs(Math.abs(pos[i + 2]) - 0.2) < 0.24, "behind its own motor");
  }
  w.dispose();
});
