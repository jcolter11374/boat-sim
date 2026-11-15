import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { cullHiddenFaces, enclosedVolume, isSolidPart } from "../src/boats/cull.ts";

const mat = (name: string) => {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide });
  m.name = name;
  return m;
};
const mesh = (geo: THREE.BufferGeometry, m: THREE.Material, name = "") => {
  const x = new THREE.Mesh(geo, m);
  x.name = name;
  return x;
};

test("a solid part wound outward is drawn front faces only", () => {
  const box = new THREE.BoxGeometry(2, 1, 0.5);
  box.computeBoundingBox();
  assert.ok(Math.abs(enclosedVolume(box) - 1) < 1e-6);
  const root = new THREE.Group();
  const hull = mat("hull");
  root.add(mesh(box, hull, "hull_1"));
  assert.equal(cullHiddenFaces(root), 1);
  assert.equal(hull.side, THREE.FrontSide);
});

test("sails, wire, glass, flat sheets, thin rods and inside-out parts stay two-sided", () => {
  const solid = new THREE.BoxGeometry(1, 1, 1);
  assert.equal(isSolidPart(mesh(solid, mat("cloth"), "sail_main")), false);
  assert.equal(isSolidPart(mesh(solid, mat("wire"))), false);
  assert.equal(isSolidPart(mesh(solid, mat("glass"))), false);
  assert.equal(isSolidPart(mesh(solid, mat("trampoline"))), false);
  assert.equal(isSolidPart(mesh(new THREE.PlaneGeometry(2, 2), mat("deck"))), false);
  assert.equal(isSolidPart(mesh(new THREE.CylinderGeometry(0.005, 0.005, 10), mat("alu"))), false);
  const inside = new THREE.BoxGeometry(1, 1, 1);
  inside.index!.array.reverse(); // faces wound inward
  assert.equal(isSolidPart(mesh(inside, mat("lead"))), false);
});

test("a material shared with a two-sided part stays two-sided", () => {
  const root = new THREE.Group();
  const shared = mat("steel");
  root.add(mesh(new THREE.BoxGeometry(1, 1, 1), shared));
  root.add(mesh(new THREE.PlaneGeometry(1, 1), shared));
  assert.equal(cullHiddenFaces(root), 0);
  assert.equal(shared.side, THREE.DoubleSide);
});
