import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { SAIL_SUN, clotheSails, isSail, setSailLuff, setSailSun } from "../src/boats/sailcloth";

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

test("each sail on a boat gets its own cloth, and the luff flutter reaches it", () => {
  const shared = new THREE.MeshStandardMaterial({ name: "sail", roughness: 0.5 });
  const pivot = new THREE.Group();
  const main = new THREE.Mesh(new THREE.PlaneGeometry(3, 9), shared);
  main.name = "sail_main";
  const jib = new THREE.Mesh(new THREE.PlaneGeometry(3, 8), shared);
  jib.name = "sail_jib";
  pivot.add(main, jib);
  clotheSails(pivot);
  const mm = main.material as THREE.MeshPhysicalMaterial;
  const jm = jib.material as THREE.MeshPhysicalMaterial;
  assert.notEqual(mm, jm);
  assert.notEqual(mm, shared, "the shared template material is left alone");
  assert.ok(mm instanceof THREE.MeshPhysicalMaterial && mm.sheen > 0, "woven sheen");
  clotheSails(pivot); // again: no new materials
  assert.equal(main.material, mm);
  setSailLuff(pivot, 0.5);
  assert.equal(mm.userData.sail.uLuff.value, 0.5);
  assert.ok(Math.abs(jm.userData.sail.uLuff.value - 0.575) < 1e-9, "a jib luffs first");
  setSailLuff(pivot, 0);
  assert.equal(mm.userData.sail.uLuff.value, 0);
  setSailLuff(new THREE.Group(), 1); // nothing to flutter: no error
  assert.ok(Math.abs(mm.userData.sail.uSize.value.y - 9) < 1e-6, "seams spaced from the sail's own height");
});
