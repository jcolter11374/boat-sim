import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { RIM, RIM_DARK, RIM_MOON, addCockpitLight, COCKPIT_CD, nightLook, setNightLook } from "../src/boats/nightlook";

test("every boat material gets the night rim, once", () => {
  const g = new THREE.Group();
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ name: "sail" }));
  const hull = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ name: "hull" }));
  g.add(sail, hull);
  nightLook(g);
  nightLook(g);
  const sm = sail.material as THREE.MeshStandardMaterial;
  assert.ok(sm.userData.nightRim);
  assert.ok((hull.material as THREE.MeshStandardMaterial).userData.nightRim);
  assert.match(sm.customProgramCacheKey(), /nightrim/);
});

test("the rim and the cockpit lamp come up after dark, more under a moon", () => {
  const scene = new THREE.Scene();
  const boat = new THREE.Group();
  scene.add(boat);
  const lamp = addCockpitLight(boat, new THREE.Vector3(7, 1.5, 0), 4);
  setNightLook(0, 1);
  assert.equal(RIM.strength.value, 0);
  assert.equal(lamp.intensity, 0);
  setNightLook(1, 0);
  assert.ok(Math.abs(RIM.strength.value - RIM_DARK) < 1e-9, "a moonless night still shows the boat's edges");
  assert.equal(lamp.intensity, COCKPIT_CD);
  setNightLook(1, 1);
  assert.ok(Math.abs(RIM.strength.value - (RIM_DARK + RIM_MOON)) < 1e-9);
});
