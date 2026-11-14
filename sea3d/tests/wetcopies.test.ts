import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyFinishes } from "../src/boats/finishes";
import { copyWithHooks, ownWetMaterials } from "../src/boats/inWater";
import { nightLook } from "../src/boats/nightlook";
import { holdWidth } from "../src/boats/wire";

// The title's boat gets her own copies of the materials at the water (#512). The Rev C5's white
// hull carries our own hooks (night floor and sky shade from the finishes, the night rim from the
// builder), and clone() drops hooks, so before this fix the hull kept the shared material and never
// got the wet band Elena asked for (Lena's review of #512).

function boat(): THREE.Group {
  const g = new THREE.Group();
  for (const [name, y] of [["hull", -0.05], ["teal", -0.02], ["whip", 0.6]] as const) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(1, 0.2, 0.3), new THREE.MeshPhysicalMaterial({ name }));
    m.name = name;
    m.position.y = y;
    g.add(m);
  }
  applyFinishes(g, "randolph"); // as loadDetailedModels does
  nightLook(g); // as the builders do
  return g;
}
const mat = (g: THREE.Group, name: string) => (g.getObjectByName(name) as THREE.Mesh).material as THREE.MeshStandardMaterial;

test("the title boat's hull gets its own copy at the water, with its night and sky hooks put back", () => {
  const g = boat();
  const hull0 = mat(g, "hull");
  assert.ok(hull0.userData.nightFloor && hull0.userData.skyShade && hull0.userData.nightRim, "the hull is hooked, as on the live model");
  const copies = ownWetMaterials(g, 0);
  const hull = mat(g, "hull");
  assert.notEqual(hull, hull0, "the hull has its own copy");
  assert.ok(copies.includes(hull));
  assert.notEqual(hull.onBeforeCompile, THREE.Material.prototype.onBeforeCompile);
  const key = hull.customProgramCacheKey();
  assert.match(key, /\|night-floor/);
  assert.match(key, /\|sky-shade/);
  assert.match(key, /\|boatsim-nightrim-v2(?!c)/);
  assert.equal(key, hull0.customProgramCacheKey(), "the copy draws exactly as the shared one");
  assert.notEqual(mat(g, "teal"), undefined);
});

test("parts away from the water, and materials with hooks we can't put back, stay shared", () => {
  const g = boat();
  const whip0 = mat(g, "whip");
  const teal0 = mat(g, "teal");
  holdWidth(teal0, 0.005); // a hook a copy couldn't have back
  ownWetMaterials(g, 0);
  assert.equal(mat(g, "whip"), whip0, "the whip is 60 cm up: not a wet part");
  assert.equal(mat(g, "teal"), teal0, "a held wire stays shared");
});

test("a copy keeps a sail's warm backlight in its night rim", () => {
  const sail = new THREE.MeshPhysicalMaterial({ name: "sail" });
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.BoxGeometry(), sail);
  m.name = "mainsail";
  g.add(m);
  nightLook(g);
  assert.equal(copyWithHooks(sail).customProgramCacheKey(), sail.customProgramCacheKey());
});
