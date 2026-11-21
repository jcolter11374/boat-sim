import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { putInWater } from "../src/boats/inWater";

// A boat built again from the same loaded model shares its materials with the one before, and a
// material is patched for the water only once. The rebuilt boat must still drive the uniforms that
// material's shader reads: on the sea demo at Low the kayak is rebuilt when the Randolph model
// arrives, and her hull kept the sea plane of that moment, so she went dark (as if under water)
// whenever she rode below it (live check "no boat in view", 18-20 Nov 2026).

type Shader = { uniforms: Record<string, { value: unknown }>; vertexShader: string; fragmentShader: string };
const compiled = (m: THREE.Material): Shader => {
  const sh: Shader = { uniforms: {}, vertexShader: "#include <common>\n#include <project_vertex>", fragmentShader: "#include <common>\n#include <opaque_fragment>" };
  m.onBeforeCompile(sh as never, null as never);
  return sh;
};
const hull = (m: THREE.Material): THREE.Group => new THREE.Group().add(new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.3), m));
const look = (y: number) => ({ wetH: 0.05, foam: 0, light: 1, plane: { x: 1, z: 2, y, gx: 0.1, gz: 0.2 } });

test("a boat rebuilt on the same materials still moves the sea plane their shader reads", () => {
  const shared = new THREE.MeshStandardMaterial();
  const first = putInWater(hull(shared), true);
  first.update(look(0.3));
  const sh = compiled(shared);
  assert.equal(sh.uniforms.uSeaPlaneY.value, 0.3);
  const second = putInWater(hull(shared), true); // the rebuild: same material, a new boat
  second.update(look(-0.6));
  assert.equal(sh.uniforms.uSeaPlaneY.value, -0.6);
  assert.deepEqual((sh.uniforms.uSeaPlane.value as THREE.Vector4).toArray(), [1, 2, 0.1, 0.2]);
});

test("a boat with materials of her own drives only hers", () => {
  const a = new THREE.MeshStandardMaterial(), b = new THREE.MeshStandardMaterial();
  const one = putInWater(hull(a), true), two = putInWater(hull(b), true);
  one.update(look(0.3));
  two.update(look(-0.6));
  assert.equal(compiled(a).uniforms.uSeaPlaneY.value, 0.3);
  assert.equal(compiled(b).uniforms.uSeaPlaneY.value, -0.6);
});
