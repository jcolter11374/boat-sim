import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { applyStockFinishes } from "../src/boats/finishes";
import { Wetness } from "../src/boats/wet";

test("a stock hull's clear coat keeps its fairing through rain", () => {
  const hull = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshPhysicalMaterial({ name: "hull", clearcoat: 1, roughness: 0.2 }));
  const sail = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshPhysicalMaterial({ name: "sail", roughness: 0.85 }));
  sail.material.userData.sailcloth = true;
  const g = new THREE.Group();
  g.add(hull, sail);
  applyStockFinishes(g, "stock_pearson31_2");
  const m = hull.material;
  const fair = m.clearcoatNormalMap;
  assert.ok(fair, "fairing in the reflections");
  const wet = new Wetness(g);
  wet.set(0.12); // damp: darker and glossier, no drops yet (those need a canvas)
  assert.ok(m.roughness < 0.2, "a wet hull gets glossier (glTF materials too: emissive intensity 1, black)");
  assert.equal(sail.material.roughness, 0.85, "wet cloth stays matt");
  assert.ok(sail.material.color.r < 1, "and a little darker");
  wet.set(0);
  assert.equal(m.clearcoatNormalMap, fair, "dry again: the fairing is back");
  assert.ok(Math.abs(m.clearcoatNormalScale.x - 0.35) < 1e-6);
});
