import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SAIL_SUN, clotheSails, isSail, setSailSun } from "../src/boats/sailcloth";

test("the sails, and only the sails, become sailcloth", () => {
  const g = new THREE.Group();
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ name: "sail", roughness: 0.5 }));
  sail.name = "sail_main";
  const hull = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ name: "hull", roughness: 0.3 }));
  g.add(sail, hull);
  clotheSails(g);
  const sm = sail.material as THREE.MeshStandardMaterial;
  assert.ok(sm.userData.sailcloth && sm.side === THREE.DoubleSide && sm.roughness >= 0.8);
  assert.ok(!(hull.material as THREE.MeshStandardMaterial).userData.sailcloth);
  assert.equal((hull.material as THREE.MeshStandardMaterial).roughness, 0.3);
  assert.ok(isSail(new THREE.Object3D(), new THREE.MeshStandardMaterial({ name: "sail_dinghy" })));
});

test("the atmosphere's sun reaches every sail", () => {
  setSailSun(new THREE.Vector3(0, 0.1, -2), new THREE.Color(1, 0.6, 0.3), 0.8);
  assert.ok(Math.abs(SAIL_SUN.dir.value.length() - 1) < 1e-9);
  assert.equal(SAIL_SUN.strength.value, 0.8);
  assert.equal(SAIL_SUN.colour.value.g, 0.6);
});
