// The other ships' models (boats/ships.ts): the right size, afloat on their waterline,
// a bridge that can see over the cargo, and lights by the collision rules for every kind.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { bridgeOf, SHIP_KINDS, SHIP_SIZE, shipGeometry, shipLights } from "../src/boats/ships";
import { GREEN, RED, WHITE } from "../src/boats/navlights";

const bounds = (kind: (typeof SHIP_KINDS)[number]) => {
  const g = shipGeometry(kind);
  g.computeBoundingBox();
  return g.boundingBox!;
};

test("each ship is its stated length and beam, bow at x = 0, with a hull below the waterline", () => {
  for (const kind of SHIP_KINDS) {
    const { length: L, beam: B } = SHIP_SIZE[kind];
    const b = bounds(kind);
    const g = shipGeometry(kind);
    for (const a of ["position", "normal", "color", "aMark"]) assert.ok(g.attributes[a], `${kind}: ${a}`);
    // The stem rakes forward above the waterline (and the bulb below), so the hull starts a little ahead of x = 0.
    assert.ok(b.min.x < 0 && b.min.x > -Math.max(0.06 * L, 3), `${kind}: bow ${b.min.x.toFixed(1)}`);
    assert.ok(Math.abs(b.max.x - L) < 0.02 * L, `${kind}: stern ${b.max.x.toFixed(1)} vs ${L}`);
    assert.ok(b.max.z - b.min.z <= B + 0.8 && b.max.z - b.min.z >= B - 0.5, `${kind}: beam ${(b.max.z - b.min.z).toFixed(1)} vs ${B}`);
    assert.ok(b.min.y < -0.08 * B, `${kind}: draft below the waterline`);
  }
});

test("big ships' lights by the rules, for the bulk carrier too; sidelights at the ship's side", () => {
  for (const kind of ["container", "tanker", "bulk"] as const) {
    const { underway, anchored } = shipLights(kind);
    const mast = underway.filter((l) => l.arcs[0].colour === WHITE && l.arcs[0].from === 247.5);
    assert.equal(mast.length, 2, `${kind}: two masthead lights`);
    const [fwd, aft] = [...mast].sort((a, b) => a.at.x - b.at.x);
    assert.ok(aft.at.y - fwd.at.y >= 4.5, `${kind}: the aft one at least 4.5 m higher (Rule 23)`);
    // Annex I 3(a): the masthead lights at least half the ship's length apart, or 100 m.
    assert.ok(aft.at.x - fwd.at.x >= Math.min(SHIP_SIZE[kind].length / 2, 100), `${kind}: masthead lights far enough apart`);
    const red = underway.find((l) => l.arcs[0].colour === RED)!;
    const green = underway.find((l) => l.arcs[0].colour === GREEN)!;
    assert.ok(red.at.z >= SHIP_SIZE[kind].beam / 2 - 0.5 && green.at.z <= -SHIP_SIZE[kind].beam / 2 + 0.5, `${kind}: sidelights at the side`);
    assert.ok(red.at.x > fwd.at.x, `${kind}: sidelights abaft the forward masthead light (Rule 23 / Annex I 3(b))`);
    assert.equal(anchored.length, 2, `${kind}: two anchor lights`);
  }
});

test("the container ship's bridge sees over its containers", () => {
  // SOLAS V/22: the view of the sea from the bridge, past the bow, isn't blocked for more
  // than two ship lengths (or 500 m). Checked from the bridge windows over the highest box.
  const g = shipGeometry("container");
  const p = g.attributes.position.array as Float32Array;
  const mk = g.attributes.aMark.array as Float32Array;
  const br = bridgeOf("container");
  const eye = new THREE.Vector2(br.x, br.floor + 1.7); // the bridge front, eye height
  const L = SHIP_SIZE.container.length;
  let worst = 0; // the furthest ahead of the bow that a box hides the sea
  for (let i = 0; i < p.length / 3; i++) {
    const [x, y] = [p[i * 3], p[i * 3 + 1]];
    if (mk[i * 3 + 2] < 0.5 || x >= eye.x || y <= 12) continue; // only the cargo and deck gear forward of the bridge
    const slope = (eye.y - y) / (eye.x - x); // the sightline over this corner falls this much per metre
    const reach = eye.y / slope - eye.x; // metres ahead of the bow where it meets the sea
    worst = Math.max(worst, reach);
  }
  assert.ok(worst < Math.min(2 * L, 500), `blind ahead ${worst.toFixed(0)} m`);
});
