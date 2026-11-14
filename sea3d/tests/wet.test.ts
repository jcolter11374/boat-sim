import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { Wetness } from "../src/boats/wet";

// The helm's boat gets wet in rain and spray (it was only on the old Watch page). A new paint
// arrives while she sails: the wet look must darken the new colour, not bring the old one back.

const hull = (hex: number) => {
  const m = new THREE.MeshStandardMaterial({ color: hex, roughness: 0.6 });
  const g = new THREE.Group();
  g.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), m));
  return { g, m };
};

test("wet darkens and glosses her; forget() dries her and lets a repaint be the new dry look", () => {
  const { g, m } = hull(0xcc2222);
  const red = m.color.clone();
  const w = new Wetness(g);
  w.set(0.1); // under the beads, so no canvas is needed
  assert.ok(m.color.r < red.r, "darker when wet");
  assert.ok(m.roughness < 0.6, "glossier when wet");
  w.forget();
  assert.ok(m.color.equals(red) && m.roughness === 0.6, "dry again");
  assert.equal(m.userData.dry, undefined, "the kept dry look is dropped");
  m.color.setHex(0x2244cc); // the new paint
  const blue = m.color.clone();
  const w2 = new Wetness(g);
  w2.set(0.1);
  w2.set(0);
  assert.ok(m.color.equals(blue), "dries back to the new paint, not the old");
});
