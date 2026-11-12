// Other ships: generic, made-up designs of the kinds you meet most at sea, a container
// ship, a crude-oil tanker, a bulk carrier (the commonest cargo ship there is, with its
// own deck cranes) and a stern trawler (a fishing boat that tows its net from a frame at
// the stern). No real company's colours, names or marks.
//
// Each kind is one merged mesh, coloured per vertex, so a ship costs one draw call plus
// its lights. The hull is lofted from its lines (a raked, flared bow over a bulbous
// forefoot, a sheer that rises forward, a flat bottom, a run that sweeps up to an
// overhanging transom), painted as ships are: red antifouling below the waterline, a
// black boot-top band at it, topsides in one plain colour picked per ship, a white
// superstructure. The scale comes from small things at their real size: 1 m windows, a
// bridge with wings out over the side, an orange free-fall lifeboat at the stern, 12.2 m
// containers, crane cabs, anchors in the bow. Light weathering (rust streaks down the
// topsides, rust under the hawse pipes) is drawn in the shader.
//
// Lights, as the international collision rules (COLREGs, 1972) set them:
//   power-driven vessels of 50 m and over under way (Rule 23(a)): a white masthead light
//     forward and a second, higher one aft, each shining over 225 degrees ahead (from dead
//     ahead to 22.5 degrees behind the beam on each side); red and green sidelights
//     (112.5 degrees each); a white sternlight (135 degrees);
//   at anchor (Rule 30(a)): an all-round white light forward and a lower one aft; and a
//     ship of 100 m or more lights up her decks with her working lights too (Rule 30(c));
//   the trawler, trawling (Rule 26(b)): all-round green over all-round white, plus
//     sidelights and a sternlight while it's making way through the water.
// At night the cabins show warm lit windows, some dark; the bridge stays dark (a bridge
// is kept dark at night so the watch can see out).
//
// Builder frame, as for our own boats: x aft from the bow (0 at the stem at the
// waterline), y up from the waterline, z to port. Display only.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { addLanterns, GREEN, NAV_NIGHT, RED, WHITE, type Arc, type Lantern } from "./navlights";
import { seaUniforms } from "../seaSurface";

export type ShipKind = "container" | "tanker" | "bulk" | "fishing";
export const SHIP_KINDS: ShipKind[] = ["container", "tanker", "bulk", "fishing"];

/** Length and beam (m) of each kind. */
export const SHIP_SIZE: Record<ShipKind, { length: number; beam: number }> = {
  container: { length: 294, beam: 32.2 }, // a Panamax box ship, 4,500 or so containers
  tanker: { length: 250, beam: 44 }, // an Aframax crude tanker
  bulk: { length: 200, beam: 32.2 }, // a Supramax bulk carrier with four deck cranes
  fishing: { length: 24, beam: 7 },
};

// ---------- geometry helpers ----------

/** Every part carries: position, normal, color, and aMark (x: window glow, y: paint slot, z: floodlit at anchor). */
interface Mark {
  glow?: number;
  /** 1: the ship's own hull colour (uPaint); 2: its funnel band colour (uBand). */
  paint?: number;
  /** Lit by the deck floodlights at anchor. */
  flood?: number;
}

function finish(g: THREE.BufferGeometry, colour: THREE.ColorRepresentation, m: Mark = {}): THREE.BufferGeometry {
  if (g.index) g = g.toNonIndexed();
  if (!g.attributes.normal) g.computeVertexNormals();
  g.deleteAttribute("uv");
  const c = new THREE.Color(colour);
  const n = g.attributes.position.count;
  const col = new Float32Array(n * 3);
  const mk = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col.set([c.r, c.g, c.b], i * 3);
    mk.set([m.glow ?? 0, m.paint ?? 0, m.flood ?? 0], i * 3);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aMark", new THREE.BufferAttribute(mk, 3));
  return g;
}

/** A box from (x0, y0, z0) to (x1, y1, z1). */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, colour: THREE.ColorRepresentation, m: Mark = {}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return finish(g, colour, m);
}

/** An upright cylinder at (x, z), from y0 to y1. */
function post(x: number, z: number, y0: number, y1: number, r: number, colour: THREE.ColorRepresentation, m: Mark = {}, segs = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, y1 - y0, segs, 1);
  g.translate(x, (y0 + y1) / 2, z);
  return finish(g, colour, m);
}

/** A box of size (lx, ly, lz) turned by `pitch` (radians, nose up towards -x) about z, then placed with its centre at (x, y, z). */
function tilted(lx: number, ly: number, lz: number, pitch: number, x: number, y: number, z: number, colour: THREE.ColorRepresentation, m: Mark = {}): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(lx, ly, lz);
  g.rotateZ(-pitch);
  g.translate(x, y, z);
  return finish(g, colour, m);
}

/** A seeded random stream, the same every build. */
function rng(seed: number): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

// ---------- hulls ----------

interface HullLines {
  L: number;
  B: number;
  /** Draft (m below the waterline to the flat bottom). */
  T: number;
  /** Freeboard amidships (m, waterline to the deck edge). */
  F: number;
  /** How far the stem reaches forward of the waterline at deck height (m). */
  rake: number;
  /** Length of the bow's entrance, stem to full beam (m), and of the run aft (m). */
  entrance: number;
  run: number;
  /** Bottom of the transom above the waterline (m). */
  transom: number;
  bilge: number;
  /** Extra sheer at the bow (m), and a raised forecastle (length, rise, m). */
  sheerFwd: number;
  fcsle: [number, number];
  bulb?: { length: number; r: number; y: number };
  colours: { anti: number; boot: number; deck: number };
  /** The boot-top band, from y0 to y1 (m about the waterline). */
  boot: [number, number];
}

const stemForefoot = (h: HullLines) => h.T * 0.35;

/** Where the stem is at height y (x, m; negative is forward of the waterline stem). */
function stemX(h: HullLines, y: number): number {
  if (y >= 0) return -h.rake * Math.pow(Math.min(y, h.F + h.sheerFwd + h.fcsle[1]) / (h.F + h.sheerFwd + h.fcsle[1]), 1.25);
  const r = stemForefoot(h);
  const yc = -h.T + r;
  if (y > yc) return 0;
  return r - Math.sqrt(Math.max(0, r * r - (yc - y) * (yc - y)));
}

/** The keel line: the lowest point of the hull at x. */
function bottomY(h: HullLines, x: number): number {
  const r = stemForefoot(h);
  if (x < 0) {
    const top = h.F + h.sheerFwd + h.fcsle[1];
    return top * Math.pow(Math.min(1, -x / h.rake), 1 / 1.25);
  }
  if (x < r) return -h.T + r - Math.sqrt(Math.max(0, r * r - (r - x) * (r - x)));
  const a0 = h.L - h.run;
  if (x > a0) return -h.T + (h.T + h.transom) * Math.pow((x - a0) / h.run, 1.9);
  return -h.T;
}

/** Deck edge height at x. */
function sheerY(h: HullLines, x: number): number {
  const fwd = h.sheerFwd * Math.pow(Math.max(0, 1 - Math.max(x, 0) / (0.3 * h.L)), 2);
  const fc = h.fcsle[1] * (1 - THREE.MathUtils.smoothstep(x, h.fcsle[0] - 1, h.fcsle[0] + 1));
  return h.F + fwd + fc;
}

/** Half-breadth (m) of the hull at (x, y), before the bilge is rounded. */
function halfBreadth(h: HullLines, x: number, y: number): number {
  const d = x - stemX(h, y);
  if (d <= 0) return 0;
  const s = Math.min(1, d / h.entrance);
  // Fine at the waterline, fuller (flared) up at the deck.
  const up = THREE.MathUtils.clamp(y / (h.F + h.sheerFwd), 0, 1);
  const p = 2.2 - 0.9 * up;
  let g = 1 - Math.pow(1 - s, p);
  const a = THREE.MathUtils.clamp((x - (h.L - h.run)) / h.run, 0, 1);
  const low = 1 - THREE.MathUtils.smoothstep(y, -h.T * 0.4, h.transom + 1.5);
  g *= 1 - a * a * (0.55 * low + 0.1);
  return (h.B / 2) * g;
}

/** Half-breadth with the bilge rounded off near the keel line. */
function hullZ(h: HullLines, x: number, y: number, yb: number): number {
  const hb = halfBreadth(h, x, y);
  const r = Math.min(h.bilge, hb);
  if (r <= 0 || y >= yb + r) return hb;
  const k = (yb + r - y) / r;
  return hb - r + r * Math.sqrt(Math.max(0, 1 - k * k));
}

/** The lofted hull: sides, bottom, deck and transom, plus the bulbous bow. */
function hull(h: HullLines): THREE.BufferGeometry[] {
  const xFwd = stemX(h, h.F + h.sheerFwd + h.fcsle[1]);
  // Stations: close together at the ends, where the shape changes.
  const N = 64;
  const xs: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N;
    const e = u < 0.5 ? 0.5 * Math.pow(2 * u, 1.6) : 1 - 0.5 * Math.pow(2 - 2 * u, 1.6);
    xs.push(xFwd + 0.001 + e * (h.L - xFwd - 0.001));
  }
  // Rows at fixed heights, so the paint bands are straight lines along the hull.
  const top = h.F + h.sheerFwd + h.fcsle[1];
  const lev = new Set<number>();
  for (let k = 0; k <= 8; k++) lev.add(-h.T + (h.bilge * k) / 8);
  for (let y = -h.T; y < top; y += Math.max(0.8, (h.T + top) / 16)) lev.add(y);
  for (const y of [h.boot[0], h.boot[1], 0, h.F, h.transom, top]) lev.add(y);
  const ys = [...lev].sort((a, b) => a - b);
  const R = ys.length + 1; // the last row is the deck edge itself

  const sides: THREE.BufferGeometry[] = [];
  for (const sign of [1, -1]) {
    const pos: number[] = [];
    const yRow: number[] = [];
    for (const x of xs) {
      const yb = bottomY(h, x);
      const ysh = sheerY(h, x);
      for (let j = 0; j < R; j++) {
        const y = j < R - 1 ? THREE.MathUtils.clamp(ys[j], yb, ysh) : ysh;
        pos.push(x, y, sign * hullZ(h, x, y, yb));
        yRow.push(y);
      }
    }
    const idx: number[] = [];
    for (let i = 0; i < N; i++)
      for (let j = 0; j < R - 1; j++) {
        const a = i * R + j;
        const b = (i + 1) * R + j;
        if (sign > 0) idx.push(a, b, a + 1, b, b + 1, a + 1);
        else idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    let g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    g = g.toNonIndexed();
    // Paint by each triangle's height: antifouling, boot-top, topsides (the ship's own colour).
    const p = g.attributes.position.array as Float32Array;
    const n = p.length / 3;
    const col = new Float32Array(n * 3);
    const mk = new Float32Array(n * 3);
    const anti = new THREE.Color(h.colours.anti);
    const boot = new THREE.Color(h.colours.boot);
    for (let t = 0; t < n; t += 3) {
      const yc = (p[t * 3 + 1] + p[t * 3 + 4] + p[t * 3 + 7]) / 3;
      const c = yc < h.boot[0] ? anti : yc < h.boot[1] ? boot : null;
      for (let v = t; v < t + 3; v++) {
        if (c) col.set([c.r, c.g, c.b], v * 3);
        else mk[v * 3 + 1] = 1;
      }
    }
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aMark", new THREE.BufferAttribute(mk, 3));
    sides.push(g);
  }

  // Bottom, deck and transom: strips between the two sides.
  const zAt = (x: number, y: number) => hullZ(h, x, y, bottomY(h, x));
  const bottom: number[] = [];
  const deck: number[] = [];
  for (let i = 0; i < N; i++) {
    const [x0, x1] = [xs[i], xs[i + 1]];
    const [b0, b1] = [bottomY(h, x0), bottomY(h, x1)];
    const [zb0, zb1] = [zAt(x0, b0), zAt(x1, b1)];
    bottom.push(x0, b0, zb0, x0, b0, -zb0, x1, b1, zb1, x1, b1, zb1, x0, b0, -zb0, x1, b1, -zb1);
    const [s0, s1] = [sheerY(h, x0), sheerY(h, x1)];
    const [zs0, zs1] = [zAt(x0, s0), zAt(x1, s1)];
    deck.push(x0, s0, zs0, x1, s1, zs1, x0, s0, -zs0, x1, s1, zs1, x1, s1, -zs1, x0, s0, -zs0);
  }
  const transom: number[] = [];
  const xT = h.L;
  const yb = bottomY(h, xT);
  const ysh = sheerY(h, xT);
  const tr = ys.filter((y) => y > yb && y < ysh);
  const rows = [yb, ...tr, ysh];
  for (let j = 0; j + 1 < rows.length; j++) {
    const [y0, y1] = [rows[j], rows[j + 1]];
    const [z0, z1] = [hullZ(h, xT, y0, yb), hullZ(h, xT, y1, yb)];
    transom.push(xT, y0, z0, xT, y0, -z0, xT, y1, z1, xT, y1, z1, xT, y0, -z0, xT, y1, -z1);
  }
  const strip = (a: number[], colour: number, m: Mark = {}) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(a, 3));
    g.computeVertexNormals();
    return finish(g, colour, m);
  };
  const parts = [...sides, strip(bottom, h.colours.anti), strip(deck, h.colours.deck, { flood: 1 }), strip(transom, 0, { paint: 1 })];

  if (h.bulb) {
    const { length, r, y } = h.bulb;
    const g = new THREE.SphereGeometry(1, 14, 10);
    g.scale(length + r * 1.5, r, r * 0.85);
    g.translate(-length + r * 1.5, y, 0);
    parts.push(finish(g, h.colours.anti));
  }
  return parts;
}

/** The hull's half-breadth at (x, y), for fitting things to its side. */
function sideZ(h: HullLines, x: number, y: number): number {
  return hullZ(h, x, y, bottomY(h, x));
}

/** A solid bulwark (the hull's side carried up past the deck) from x0 to x1, `height` m tall, both faces. */
function bulwark(h: HullLines, x0: number, x1: number, height: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const n = Math.max(2, Math.ceil((x1 - x0) / 1.2));
  for (const sign of [1, -1])
    for (let i = 0; i < n; i++) {
      const [xa, xb] = [x0 + ((x1 - x0) * i) / n, x0 + ((x1 - x0) * (i + 1)) / n];
      const [ya, yb] = [sheerY(h, xa), sheerY(h, xb)];
      const [za, zb] = [sign * sideZ(h, xa, ya), sign * sideZ(h, xb, yb)];
      const A = [xa, ya, za], B = [xb, yb, zb], C = [xa, ya + height, za], D = [xb, yb + height, zb];
      pos.push(...A, ...B, ...C, ...B, ...D, ...C); // one face
      pos.push(...A, ...C, ...B, ...B, ...C, ...D); // and the other
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return finish(g, 0, { paint: 1 });
}

// ---------- shared superstructure ----------

const WHITE_PAINT = 0xe6e4dc;
const GLASS = 0x1b2229;
const DECKGEAR = 0x5b6066;
const LIFEBOAT = 0xe8621c;

interface House {
  /** Front and back of the accommodation block, half its width, its deck and the bridge floor (m). */
  x0: number;
  x1: number;
  hw: number;
  y0: number;
  bridge: number;
  /** Half-span of the bridge wings (usually the full beam). */
  wing: number;
}

const DECK_H = 2.85; // one deck of cabins, floor to floor

/** The accommodation and bridge: cabin decks with rows of windows, a bridge with a window band and wings. */
function accommodation(H: House, seed: number): THREE.BufferGeometry[] {
  const r = rng(seed);
  const top = H.bridge + 3.2;
  const parts = [
    box(H.x0, H.x1, H.y0, H.bridge, -H.hw, H.hw, WHITE_PAINT),
    box(H.x0 + 0.3, H.x1 - 2, H.bridge, top, -H.hw + 0.3, H.hw - 0.3, WHITE_PAINT), // wheelhouse
    box(H.x0 + 0.2, H.x0 + 6, H.bridge + 2.9, top + 0.15, -H.wing, H.wing, WHITE_PAINT), // bridge roof and wings
    box(H.x0 + 0.5, H.x0 + 5.5, H.bridge - 0.35, H.bridge, -H.wing, H.wing, WHITE_PAINT), // wing decks
    box(H.x0 + 0.1, H.x1 - 2.1, H.bridge + 0.9, H.bridge + 2.6, -H.hw + 0.2, H.hw - 0.2, GLASS, { glow: 0.03 }), // bridge windows all round
    box(H.x0 + 0.1, H.x0 + 0.2, H.bridge + 0.9, H.bridge + 2.6, -H.wing + 0.4, H.wing - 0.4, GLASS, { glow: 0.03 }),
    box(H.x0 + 0.5, H.x0 + 5.5, H.bridge, H.bridge + 1.1, -H.wing, -H.wing + 0.08, 0xcfcdc5), // wing bulwarks
    box(H.x0 + 0.5, H.x0 + 5.5, H.bridge, H.bridge + 1.1, H.wing - 0.08, H.wing, 0xcfcdc5),
  ];
  // Windows on the cabin decks: front, both sides, back. Each one a metre or so across, some lit at night.
  const lit = () => (r() < 0.45 ? 1 : 0);
  for (let y = H.y0 + DECK_H; y + 1.5 < H.bridge; y += DECK_H) {
    const wy0 = y - DECK_H + 1.1;
    const wy1 = wy0 + 1.0;
    for (let z = -H.hw + 1.6; z <= H.hw - 1.6; z += 2.7) {
      parts.push(box(H.x0 - 0.06, H.x0 + 0.02, wy0, wy1, z - 0.6, z + 0.6, GLASS, { glow: lit() }));
      parts.push(box(H.x1 - 0.02, H.x1 + 0.06, wy0, wy1, z - 0.6, z + 0.6, GLASS, { glow: lit() }));
    }
    for (let x = H.x0 + 1.8; x <= H.x1 - 1.8; x += 2.9)
      for (const s of [1, -1]) parts.push(box(x - 0.6, x + 0.6, wy0, wy1, s * H.hw - 0.02, s * H.hw + 0.06 * s, GLASS, { glow: lit() }));
    // A deck edge line: the ledge each deck makes.
    parts.push(box(H.x0 - 0.15, H.x1 + 0.15, y - 0.12, y, -H.hw - 0.15, H.hw + 0.15, 0xd6d3ca));
  }
  return parts;
}

/** A funnel from x0 to x1, its top at y1, with a coloured band (the ship's own) and a black top. */
function funnel(x0: number, x1: number, hw: number, y0: number, y1: number, body: number): THREE.BufferGeometry[] {
  return [
    box(x0, x1, y0, y1 - 4.5, -hw, hw, body),
    box(x0 - 0.05, x1 + 0.05, y1 - 4.5, y1 - 1.6, -hw - 0.05, hw + 0.05, 0, { paint: 2 }),
    box(x0, x1, y1 - 1.6, y1, -hw, hw, 0x16181b),
    post(x0 + 1.4, -hw * 0.4, y1, y1 + 1.6, 0.45, 0x2b2d30),
    post(x0 + 1.4, hw * 0.4, y1, y1 + 1.4, 0.35, 0x2b2d30),
  ];
}

/** A radar mast on the bridge roof: the post, a crosstree, two radar scanners. Returns the masthead's height. */
function radarMast(x: number, roof: number, height: number): THREE.BufferGeometry[] {
  return [
    box(x - 0.5, x + 0.5, roof, roof + height, -0.5, 0.5, 0xd8d6cf),
    box(x - 0.4, x + 0.4, roof + height * 0.6, roof + height * 0.6 + 0.4, -4, 4, 0xd8d6cf),
    box(x - 0.35, x + 0.35, roof + height * 0.6 + 0.6, roof + height * 0.6 + 0.85, -3.6, -0.8, 0x2a2c2f), // radar scanners
    box(x - 0.35, x + 0.35, roof + height * 0.6 + 0.6, roof + height * 0.6 + 0.85, 0.8, 3.6, 0x2a2c2f),
  ];
}

/** An orange free-fall lifeboat on its ramp at the stern, nose down and aft, 8.5 m long. */
function freeFallBoat(xStern: number, deck: number): THREE.BufferGeometry[] {
  const pitch = THREE.MathUtils.degToRad(32);
  const cx = xStern - 6;
  const cy = deck + 5.2;
  return [
    tilted(8.6, 2.6, 3.0, pitch, cx, cy, 0, LIFEBOAT),
    tilted(4.0, 0.9, 2.4, pitch, cx - 1.2, cy + 1.6, 0, LIFEBOAT), // its canopy
    tilted(10, 0.4, 3.6, pitch, cx + 0.3, cy - 1.6, 0, DECKGEAR), // the ramp
    box(cx - 4.2, cx - 3.6, deck, cy + 1.5, -1.9, -1.5, DECKGEAR),
    box(cx - 4.2, cx - 3.6, deck, cy + 1.5, 1.5, 1.9, DECKGEAR),
  ];
}

/** Bow gear: a foremast, anchors at the hawse pipes, mooring winches on the forecastle. */
function bowGear(h: HullLines, mastX: number, mastTop: number): THREE.BufferGeometry[] {
  const d = sheerY(h, mastX);
  const hx = Math.max(3, h.L * 0.03);
  const hy = sheerY(h, hx) - 2.6;
  // A tapered foremast (tall: see fwdMastTop), with a platform for the masthead light.
  const parts = [
    post(mastX, 0, d, d + (mastTop - d) * 0.55, 0.75, 0xd8d6cf, {}, 8),
    post(mastX, 0, d + (mastTop - d) * 0.55, mastTop, 0.42, 0xd8d6cf, {}, 8),
    box(mastX - 1.2, mastX + 1.2, mastTop - 1.6, mastTop - 1.35, -1.2, 1.2, 0xd8d6cf), // platform
    box(mastX - 0.25, mastX + 0.25, d + (mastTop - d) * 0.55, d + (mastTop - d) * 0.55 + 0.3, -2.5, 2.5, 0xd8d6cf), // crosstree
  ];
  for (const s of [1, -1]) {
    const z = sideZ(h, hx, hy);
    parts.push(box(hx - 0.9, hx + 0.9, hy - 1.6, hy + 0.3, s * z - 0.25, s * z + 0.25, 0x222326)); // anchor in its pocket
    parts.push(box(mastX + 3, mastX + 6, d, d + 1.4, s * 2.5 - 1.2, s * 2.5 + 1.2, DECKGEAR, { flood: 1 })); // windlass
  }
  // A bulwark round the forecastle.
  parts.push(bulwark(h, stemX(h, d) + 0.3, h.fcsle[0] - 0.5, 1.2));
  return parts;
}

// ---------- the four kinds ----------

/** Where each kind's lights and house are; the builders and shipLights() read the same numbers. */
const C_HULL: HullLines = {
  L: 294, B: 32.2, T: 12, F: 10, rake: 9, entrance: 70, run: 60, transom: 3, bilge: 2.2, sheerFwd: 1.6, fcsle: [26, 2.6],
  bulb: { length: 6, r: 3.6, y: -7.5 }, colours: { anti: 0x7a2b25, boot: 0x17181a, deck: 0x4c5a55 }, boot: [1.6, 3.0],
};
const C_HOUSE: House = { x0: 222, x1: 238, hw: 10.5, y0: C_HULL.F, bridge: 39.5, wing: C_HULL.B / 2 };
const C_FUNNEL = { x0: 242, x1: 252, top: 46 };

const T_HULL: HullLines = {
  L: 250, B: 44, T: 14.5, F: 7.4, rake: 6.5, entrance: 52, run: 52, transom: 2.5, bilge: 2.6, sheerFwd: 1.2, fcsle: [22, 2.6],
  bulb: { length: 6.5, r: 4.4, y: -9 }, colours: { anti: 0x6e2722, boot: 0x141516, deck: 0x6a3a2c }, boot: [1.2, 2.6],
};
const T_HOUSE: House = { x0: 206, x1: 222, hw: 13, y0: T_HULL.F, bridge: 24.6, wing: T_HULL.B / 2 };
const T_FUNNEL = { x0: 226, x1: 234, top: 35 };

const B_HULL: HullLines = {
  L: 200, B: 32.2, T: 12, F: 7.2, rake: 6, entrance: 44, run: 42, transom: 2.5, bilge: 2.2, sheerFwd: 1.2, fcsle: [18, 2.6],
  bulb: { length: 5, r: 3.4, y: -7.5 }, colours: { anti: 0x732a24, boot: 0x151617, deck: 0x6b6f6a }, boot: [1.2, 2.6],
};
const B_HOUSE: House = { x0: 166, x1: 180, hw: 11, y0: B_HULL.F, bridge: 27.8, wing: B_HULL.B / 2 };
const B_FUNNEL = { x0: 183, x1: 190, top: 37 };

const F_HULL: HullLines = {
  L: 24, B: 7, T: 2.8, F: 2.1, rake: 2.4, entrance: 9, run: 7, transom: 0.4, bilge: 0.7, sheerFwd: 1.6, fcsle: [6, 0.9],
  colours: { anti: 0x2a2d31, boot: 0xe9e7e0, deck: 0x6c6f70 }, boot: [-0.25, 0.25],
};

/** Each kind's hull lines (for the paint: boot-top, sheer, forecastle). */
const LINES: Record<ShipKind, HullLines> = { container: C_HULL, tanker: T_HULL, bulk: B_HULL, fishing: F_HULL };

/** Each big ship's bridge: the front of the wheelhouse (x) and its floor (y), m. */
export function bridgeOf(kind: "container" | "tanker" | "bulk"): { x: number; floor: number } {
  const H = kind === "container" ? C_HOUSE : kind === "tanker" ? T_HOUSE : B_HOUSE;
  return { x: H.x0, floor: H.bridge };
}

/** A kind's waterline in plan, for its bow wave and wake (boatWash.ts): entrance and run (m), transom width over the beam. */
export function shipWaterline(kind: ShipKind): { entrance: number; run: number; transom: number } {
  const h = kind === "container" ? C_HULL : kind === "tanker" ? T_HULL : kind === "bulk" ? B_HULL : F_HULL;
  return { entrance: h.entrance, run: h.run, transom: halfBreadth(h, h.L, 0) / (h.B / 2) };
}

const roofOf = (H: House) => H.bridge + 3.35;
const fwdMastX = (h: HullLines) => h.fcsle[0] - 8;
const sidelightY = (H: House) => H.bridge + 1.2;
/**
 * The forward masthead light's height (m above the waterline). Annex I 2(g): the sidelights
 * no higher above the hull than three-quarters of the forward masthead light, so on these
 * bridge-aft ships the foremast is tall (Sam); half a metre to spare.
 */
function fwdMastTop(h: HullLines, H: House): number {
  return h.F + (sidelightY(H) - h.F) / 0.75 + 0.5;
}
/** The radar mast over the bridge roof: tall enough that the aft masthead light is 4.5 m (and a bit) above the forward one (Annex I 2(a)(ii)). */
function aftMastH(h: HullLines, H: House): number {
  return Math.max(8, fwdMastTop(h, H) + 4.8 - roofOf(H));
}
const MASTHEAD: Arc[] = [{ colour: WHITE, from: 247.5, to: 112.5 }];
const STERN: Arc[] = [{ colour: WHITE, from: 112.5, to: 247.5 }];
const STBD: Arc[] = [{ colour: GREEN, from: 0, to: 112.5 }];
const PORT: Arc[] = [{ colour: RED, from: 247.5, to: 360 }];
const ROUND = (colour: number): Arc[] => [{ colour, from: 0, to: 360 }];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Where each kind's lanterns go, under way and at anchor (builder frame, m). */
export function shipLights(kind: ShipKind): { underway: Lantern[]; anchored: Lantern[] } {
  if (kind === "fishing")
    return {
      underway: [
        { arcs: ROUND(GREEN), at: V(7.5, 11.6, 0) },
        { arcs: ROUND(WHITE), at: V(7.5, 9.6, 0) },
        { arcs: STBD, at: V(6.6, 5.6, -2.7) },
        { arcs: PORT, at: V(6.6, 5.6, 2.7) },
        { arcs: STERN, at: V(F_HULL.L - 0.3, F_HULL.F + 1.4, 0) },
      ],
      anchored: [{ arcs: ROUND(WHITE), at: V(2, 6, 0) }],
    };
  const [h, H] = kind === "container" ? [C_HULL, C_HOUSE] : kind === "tanker" ? [T_HULL, T_HOUSE] : [B_HULL, B_HOUSE];
  const fx = fwdMastX(h);
  const top = fwdMastTop(h, H);
  return {
    underway: [
      { arcs: MASTHEAD, at: V(fx, top + 0.3, 0) },
      { arcs: MASTHEAD, at: V(H.x0 + 3, roofOf(H) + aftMastH(h, H) + 0.3, 0) },
      { arcs: STBD, at: V(H.x0 + 1.5, sidelightY(H), -H.wing - 0.2) },
      { arcs: PORT, at: V(H.x0 + 1.5, sidelightY(H), H.wing + 0.2) },
      { arcs: STERN, at: V(h.L + 0.2, sheerY(h, h.L) + 1.8, 0) },
    ],
    anchored: [
      { arcs: ROUND(WHITE), at: V(fx, top - 3, 0) },
      { arcs: ROUND(WHITE), at: V(h.L - 1, sheerY(h, h.L) + 4.5, 0) },
    ],
  };
}

/** Working lights that light the decks at anchor (Rule 30(c)): lamps on the masts and along the house front. */
function floodLamps(kind: ShipKind): Lantern[] {
  if (kind === "fishing") return [{ arcs: ROUND(0xffe2b0), at: V(14, 7.2, 0) }];
  const [h, H] = kind === "container" ? [C_HULL, C_HOUSE] : kind === "tanker" ? [T_HULL, T_HOUSE] : [B_HULL, B_HOUSE];
  const out: Lantern[] = [];
  for (let z = -H.hw + 2; z <= H.hw - 2; z += (2 * H.hw - 4) / 3) out.push({ arcs: ROUND(0xffd59a), at: V(H.x0 - 0.4, H.bridge - 1.5, z) });
  for (let x = fwdMastX(h) + 30; x < H.x0 - 20; x += 45) out.push({ arcs: ROUND(0xffd59a), at: V(x, h.F + (kind === "container" ? 24 : 10), 0) });
  return out;
}

// Containers in muted, mixed colours (Elena: "not a rainbow").
// The first few are the commonest (as a few big lines' boxes dominate any ship); neighbours often match.
const BOXES = [0x2f4258, 0x7a3a2f, 0x5d6168, 0x3a5a5c, 0xa79c84, 0x2f4a3a, 0x58302c, 0x8a7448, 0x667685, 0xb9b6ae];
const BOX_WEIGHTS = [5, 4, 4, 3, 2, 2, 2, 1, 2, 1];

function containerShip(): THREE.BufferGeometry[] {
  const h = C_HULL;
  const H = C_HOUSE;
  const r = rng(31);
  const parts = hull(h);
  const deck = h.F;
  const cover = deck + 1.9; // hatch coaming and covers
  const rows = 13;
  const pitchZ = 2.5;
  const c = new THREE.Color();
  const total = BOX_WEIGHTS.reduce((a, b) => a + b, 0);
  const pick = (u: number) => {
    let w = u * total;
    for (let i = 0; i < BOX_WEIGHTS.length; i++) if ((w -= BOX_WEIGHTS[i]) < 0) return i;
    return 0;
  };
  const below = new Map<string, number>(); // the colour in each tier of the stack just done
  // Bays of 40 ft containers (12.2 m) with lashing bridges between, forward of the house and abaft the funnel.
  const bays: number[] = [];
  for (let x = h.fcsle[0] + 3; x + 12.2 < H.x0 - 2; x += 13.5) bays.push(x);
  for (let x = C_FUNNEL.x1 + 2; x + 12.2 < h.L - 16; x += 13.5) bays.push(x);
  for (const x of bays) {
    const zHalf = Math.min(sideZ(h, x, deck), sideZ(h, x + 12.2, deck)) - 0.6;
    const n = Math.min(rows, Math.floor((2 * zHalf) / pitchZ));
    const fwd = THREE.MathUtils.clamp((x - h.fcsle[0]) / 70, 0, 1); // lower towards the bow (the bridge must see over them)
    const maxT = Math.round(5 + 3 * fwd);
    parts.push(box(x - 0.4, x + 12.6, deck, cover, -n * pitchZ * 0.5 - 0.2, n * pitchZ * 0.5 + 0.2, 0x3e4a47, { flood: 1 })); // hatch cover
    if (x < H.x0 && x > h.fcsle[0] + 10) parts.push(box(x - 1.15, x - 0.45, cover, cover + 2 * 2.6, -n * pitchZ * 0.5, n * pitchZ * 0.5, 0x8b8a78, { flood: 1 })); // lashing bridge
    let lastCol = -1;
    for (let k = 0; k < n; k++) {
      const z = (k - (n - 1) / 2) * pitchZ;
      const edge = Math.abs(k - (n - 1) / 2) / ((n - 1) / 2);
      let tiers = maxT - (r() < 0.25 ? 1 : 0) - (r() < 0.08 ? 2 : 0) - (edge > 0.9 && r() < 0.4 ? 1 : 0);
      if (r() < 0.03) tiers = 1 + Math.floor(r() * 3); // a stack left short
      for (let t = 0; t < tiers; t++) {
        // Often the same as the box below or the one beside it (loaded by port and line).
        const key = `${t}`;
        let ci = r() < 0.45 && below.has(key) ? below.get(key)! : r() < 0.3 && t > 0 && lastCol >= 0 ? lastCol : pick(r());
        below.set(key, ci);
        lastCol = ci;
        c.setHex(BOXES[ci]).multiplyScalar(0.92 + 0.14 * r());
        parts.push(box(x, x + 12.2, cover + t * 2.6, cover + (t + 1) * 2.6 - 0.04, z - 1.21, z + 1.21, c, { flood: 1 }));
      }
    }
  }
  parts.push(...accommodation(H, 7));
  parts.push(...funnel(C_FUNNEL.x0, C_FUNNEL.x1, 4.2, deck, C_FUNNEL.top, 0x22303f));
  parts.push(box(H.x1, C_FUNNEL.x1 + 1, deck, deck + 9, -8, 8, WHITE_PAINT)); // engine casing round the funnel
  parts.push(...radarMast(H.x0 + 3, roofOf(H), aftMastH(h, H)));
  parts.push(...bowGear(h, fwdMastX(h), fwdMastTop(h, H)));
  parts.push(...freeFallBoat(h.L - 1, sheerY(h, h.L)));
  parts.push(box(H.x0 + 4, H.x0 + 10, H.y0 + 2 * DECK_H, H.y0 + 2 * DECK_H + 2.2, -H.hw - 2.4, -H.hw - 0.2, LIFEBOAT)); // rescue boat on its davit
  for (const s of [1, -1]) parts.push(box(h.L - 12, h.L - 7, sheerY(h, h.L), sheerY(h, h.L) + 1.4, s * 9 - 1.3, s * 9 + 1.3, DECKGEAR)); // mooring winches aft
  return parts;
}

function tanker(): THREE.BufferGeometry[] {
  const h = T_HULL;
  const H = T_HOUSE;
  const r = rng(53);
  const parts = hull(h);
  const deck = h.F;
  const x0 = h.fcsle[0] + 1;
  const x1 = H.x0 - 2;
  parts.push(
    box(x0, x1, deck + 1.6, deck + 1.9, -0.7, 0.7, 0x9aa0a6, { flood: 1 }), // the catwalk, fore and aft
    box(x0, x1, deck + 0.15, deck + 1.1, 1.0, 4.2, 0x8c9297, { flood: 1 }), // pipe runs
    box(x0, x1, deck + 0.15, deck + 0.8, -3.6, -1.0, 0x7e858a, { flood: 1 }),
    box(118, 132, deck, deck + 3.2, -h.B / 2 + 2, h.B / 2 - 2, 0x8f969c, { flood: 1 }), // cargo manifold
    box(x0, x0 + 6, deck, deck + 3.4, -h.B / 2 + 4, h.B / 2 - 4, WHITE_PAINT), // forward deckhouse
  );
  for (let x = x0 + 4; x < x1; x += 4) parts.push(box(x, x + 0.3, deck, deck + 1.6, -0.4, 0.4, 0x8a9096)); // catwalk legs
  for (let x = x0 + 10; x < x1 - 6; x += 15.5)
    for (const s of [1, -1]) parts.push(box(x, x + 2.4, deck, deck + 1.0, s * 9 - 1.2, s * 9 + 1.2, 0x7a3f2f, { flood: 1 })); // tank hatches
  for (const s of [1, -1]) {
    const cx = 125;
    const cz = s * (h.B / 2 - 6);
    parts.push(post(cx, cz, deck, deck + 9, 0.7, 0xd9d6cc));
    parts.push(tilted(16, 0.9, 0.9, 0.62, cx - 6.4, deck + 13.2, cz, 0xd9d6cc)); // hose crane jib
  }
  void r;
  parts.push(...accommodation(H, 11));
  parts.push(...funnel(T_FUNNEL.x0, T_FUNNEL.x1, 3.8, deck, T_FUNNEL.top, 0x16181b));
  parts.push(box(H.x1, T_FUNNEL.x1 + 1, deck, deck + 6, -9, 9, WHITE_PAINT));
  parts.push(...radarMast(H.x0 + 3, roofOf(H), aftMastH(h, H)));
  parts.push(...bowGear(h, fwdMastX(h), fwdMastTop(h, H)));
  parts.push(...freeFallBoat(h.L - 1, sheerY(h, h.L)));
  for (const s of [1, -1]) parts.push(box(H.x0 - 6, H.x0 - 1, deck, deck + 2.2, s * (H.hw + 3) - 1.2, s * (H.hw + 3) + 1.2, LIFEBOAT)); // rescue boat
  return parts;
}

function bulkCarrier(): THREE.BufferGeometry[] {
  const h = B_HULL;
  const H = B_HOUSE;
  const parts = hull(h);
  const deck = h.F;
  // Five holds with side-rolling hatch covers; a crane between each pair.
  const x0 = h.fcsle[0] + 4;
  const hold = (H.x0 - 6 - x0) / 5;
  for (let i = 0; i < 5; i++) {
    const a = x0 + i * hold + 3.2;
    const b = a + hold - 6.4;
    parts.push(box(a - 0.6, b + 0.6, deck, deck + 2.1, -10.4, 10.4, 0x7a7f7a, { flood: 1 })); // coaming
    parts.push(box(a, (a + b) / 2 - 0.05, deck + 2.1, deck + 3.2, -10, 10, 0x5f6a63, { flood: 1 })); // covers, in two halves
    parts.push(box((a + b) / 2 + 0.05, b, deck + 2.1, deck + 3.2, -10, 10, 0x5f6a63, { flood: 1 }));
    parts.push(box(a, b, deck + 3.2, deck + 3.5, -7, 7, 0x58625c, { flood: 1 }));
  }
  for (let i = 1; i < 5; i++) {
    const cx = x0 + i * hold;
    const cz = i % 2 ? -3.5 : 3.5;
    const pTop = deck + 10;
    parts.push(post(cx, cz, deck, pTop, 1.6, 0xd8cf9e, { flood: 1 }, 12)); // pedestal
    parts.push(box(cx - 2.6, cx + 2.6, pTop, pTop + 3.4, cz - 2.0, cz + 2.0, 0xd8cf9e, { flood: 1 })); // crane house
    parts.push(box(cx - 2.65, cx - 1.5, pTop + 1.7, pTop + 3.0, cz - 1.6, cz + 1.6, GLASS)); // cab windows
    // The jib, stowed sloping down over the next hatch onto its rest.
    const len = 26;
    const ang = THREE.MathUtils.degToRad(9);
    const dir = i % 2 ? -1 : 1;
    parts.push(tilted(len, 1.2, 1.3, -ang * dir, cx - dir * (len / 2) * Math.cos(ang), pTop + 2 - (len / 2) * Math.sin(ang), cz, 0xd8cf9e, { flood: 1 }));
    parts.push(box(cx - dir * (len - 2) - 0.4, cx - dir * (len - 2) + 0.4, deck + 3.5, pTop + 2 - len * Math.sin(ang) - 0.6, cz - 0.4, cz + 0.4, 0xd8cf9e)); // jib rest
  }
  parts.push(...accommodation(H, 17));
  parts.push(...funnel(B_FUNNEL.x0, B_FUNNEL.x1, 3.4, deck, B_FUNNEL.top, 0x7a2a22));
  parts.push(box(H.x1, B_FUNNEL.x1 + 1, deck, deck + 6, -8, 8, WHITE_PAINT));
  parts.push(...radarMast(H.x0 + 3, roofOf(H), aftMastH(h, H)));
  parts.push(...bowGear(h, fwdMastX(h), fwdMastTop(h, H)));
  parts.push(...freeFallBoat(h.L - 1, sheerY(h, h.L)));
  return parts;
}

function trawler(): THREE.BufferGeometry[] {
  const h = F_HULL;
  const parts = hull(h);
  const deck = h.F;
  parts.push(
    box(3.2, 10.5, deck + 0.9, deck + 3.4, -2.6, 2.6, 0xc9c6bb, { flood: 1 }), // deckhouse, salt-stained
    box(4.5, 10.2, deck + 3.4, deck + 5.6, -2.3, 2.3, 0xd2cfc5, { flood: 1 }), // wheelhouse
    box(4.45, 9.6, deck + 4.2, deck + 5.2, -2.35, 2.35, GLASS, { glow: 0.5 }), // its windows, lit at night
    box(4.4, 4.5, deck + 4.2, deck + 5.2, -2.1, 2.1, GLASS, { glow: 0.5 }),
    post(7.5, 0, deck + 5.6, 12, 0.14, 0xd8d6cf, {}, 6), // mast
    box(7.4, 7.6, 8.4, 8.6, -1.4, 1.4, 0xd8d6cf), // crosstree
    box(13, 17, deck, deck + 1.9, -1.9, 1.9, 0x3a6b4a, { flood: 1 }), // net drum
    box(12.2, 13, deck, deck + 2.4, -2.8, -2.0, DECKGEAR), // trawl winches
    box(12.2, 13, deck, deck + 2.4, 2.0, 2.8, DECKGEAR),
    box(22.2, 22.8, deck, deck + 6, 2.5, 3.1, 0xa8792e, { flood: 1 }), // stern gantry (the A-frame the net is towed from), worn
    box(22.2, 22.8, deck, deck + 6, -3.1, -2.5, 0xa8792e, { flood: 1 }),
    box(22.2, 22.8, deck + 5.4, deck + 6, -3.1, 3.1, 0xa8792e, { flood: 1 }),
    box(22.0, 23.0, deck + 4.6, deck + 5.4, -2.2, -1.4, 0x2a2b2d), // towing blocks
    box(22.0, 23.0, deck + 4.6, deck + 5.4, 1.4, 2.2, 0x2a2b2d),
    box(17.5, 22.2, deck + 0.02, deck + 0.45, -1.8, 1.8, 0x3f4a3f, { flood: 1 }), // the net, heaped on the stern ramp
    box(13.2, 16.8, deck + 0.2, deck + 1.7, -1.95, 1.95, 0x5a6a4a, { flood: 1 }), // net wound on the drum
  );
  // Warps from the winches up to the gantry blocks, and stays from the gantry top down to the deck.
  const wire = (a: THREE.Vector3, b: THREE.Vector3) => {
    const len = a.distanceTo(b);
    const g = new THREE.CylinderGeometry(0.03, 0.03, len, 4, 1);
    g.translate(0, len / 2, 0);
    g.applyMatrix4(new THREE.Matrix4().lookAt(a, b, new THREE.Vector3(0, 0, 1)).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2)));
    g.translate(a.x, a.y, a.z);
    return finish(g, 0x2b2b2b);
  };
  for (const s of [1, -1]) {
    parts.push(wire(new THREE.Vector3(12.6, deck + 2.4, s * 2.4), new THREE.Vector3(22.5, deck + 4.8, s * 1.8)));
    parts.push(wire(new THREE.Vector3(22.5, deck + 6, s * 2.8), new THREE.Vector3(19.5, deck, s * 3.2)));
    // Outrigger booms, raised, from the mast's foot; and their stays to the masthead.
    const foot = new THREE.Vector3(8.6, deck + 5.6, s * 1.0);
    const tip = new THREE.Vector3(9.4, deck + 5.6 + 7.5 * Math.cos(0.5), s * (1.0 + 7.5 * Math.sin(0.5)));
    parts.push(wire(foot, tip), wire(foot.clone().setZ(s * 1.05), tip.clone().setZ(tip.z + s * 0.05)));
    parts.push(wire(tip, new THREE.Vector3(7.5, 12, 0)));
  }
  parts.push(bulwark(h, stemX(h, sheerY(h, 0)) + 0.1, h.L - 0.2, 0.8));
  return parts;
}

const geos = new Map<ShipKind, THREE.BufferGeometry>();

/** One kind's merged mesh (built once, shared by every ship of that kind). */
export function shipGeometry(kind: ShipKind): THREE.BufferGeometry {
  let g = geos.get(kind);
  if (!g) {
    const parts = kind === "container" ? containerShip() : kind === "tanker" ? tanker() : kind === "bulk" ? bulkCarrier() : trawler();
    g = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    g.computeBoundingSphere();
    geos.set(kind, g);
  }
  return g;
}

// ---------- paint and materials ----------

/** Plain hull colours (topsides), picked per ship so a busy lane doesn't look cloned. */
export const HULL_COLOURS: Record<ShipKind, number[]> = {
  container: [0x1d2b47, 0x23402f, 0x5e2620, 0x46505b, 0x18191b, 0x34506a],
  tanker: [0x18191b, 0x4e1f1d, 0x1d2a44, 0x3b3f44],
  bulk: [0x18191b, 0x5a2420, 0x1f2f4c, 0x27412f, 0x40464d],
  fishing: [0x7a2620, 0x22344f, 0x26402f, 0x1e2022, 0x5a2a1f],
};
/** Funnel bands: invented, plain colours, no company marks. */
const BANDS = [0xc8a03a, 0xe8e6df, 0x2f7f86, 0xb03a2e, 0x2d5fa0, 0x6e8b3d];

/** Painted steel, one per ship (they share one shader program; only the paint differs). */
function shipMaterial(kind: ShipKind): THREE.MeshStandardMaterial {
  // Painted steel: a satin paint (the env reflection is what shows the curve of the bow), roughness set per plate below.
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.72, metalness: 0.0, envMapIntensity: 0.6 });
  const u = {
    uPaint: { value: new THREE.Color(HULL_COLOURS[kind][0]) },
    uBand: { value: new THREE.Color(BANDS[0]) },
    uFlood: { value: 0 },
    uNight: NAV_NIGHT,
    uHawse: { value: new THREE.Vector2(SHIP_SIZE[kind].length * 0.03, kind === "fishing" ? -9 : hawseY(kind)) },
    uBoot: { value: new THREE.Vector2(...LINES[kind].boot) },
    uPlate: { value: kind === "fishing" ? new THREE.Vector2(3, 1.2) : new THREE.Vector2(10.5, 2.6) },
    uSheer: { value: new THREE.Vector3(LINES[kind].F, LINES[kind].fcsle[0], LINES[kind].fcsle[1] + LINES[kind].sheerFwd) },
    /** The bow wave's height at the stem (m; 0 at anchor) and the ship's length (m). */
    uBow: { value: new THREE.Vector3(0, SHIP_SIZE[kind].length, 0) },
    uSeaTime: seaUniforms.uSeaTime,
  };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "attribute vec3 aMark;\nvarying vec3 vMark;\nvarying vec3 vLocal;\nvoid main() {\n  vMark = aMark;\n  vLocal = position;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "void main() {",
        `uniform vec3 uPaint;
uniform vec3 uBand;
uniform float uFlood;
uniform float uNight;
uniform vec2 uHawse;
uniform vec2 uBoot; // antifouling top, boot-top top (m about the marks)
uniform vec2 uPlate; // shell plate length and strake height (m)
uniform vec3 uSheer; // deck edge height amidships, forecastle length, its extra rise (m)
uniform vec3 uBow; // bow wave height at the stem, ship length, how far she floats above her marks (ballast), m: the sea is at vLocal.y = -uBow.z
uniform float uSeaTime;
varying vec3 vMark;
varying vec3 vLocal;
float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1, 0)), u.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), u.x), u.y);
}
void main() {`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
  // Painted steel, weathered (Yuki, Lighting & Materials; Elena's "reads as plastic" note,
  // 12 Nov). Sizes are real metres (vLocal: x aft of the stem, y above the loaded marks).
  float shipRough = 0.0; // 0 = keep the material's own
  bool hullSkin = vMark.x < 0.01 && vMark.z < 0.5 && ((vMark.y > 0.5 && vMark.y < 1.5) || vLocal.y < uBoot.y + 0.05);
  // Shell plating: strakes uPlate.y tall, butts every uPlate.x, staggered strake to strake.
  vec2 pl = vLocal.xy / uPlate;
  pl.x += 0.5 * mod(floor(pl.y), 2.0);
  vec2 pc = floor(pl), pf = fract(pl);
  float tone = sHash(pc + 17.0) - 0.5; // each plate a slightly different age of paint
  vec2 fw = fwidth(pl);
  vec2 bead = vec2(0.035) / uPlate; // weld beads about 3.5 cm
  vec2 on = 1.0 - smoothstep(bead, bead + 1.5 * fw, min(pf, 1.0 - pf));
  float seam = max(on.x, on.y) * (1.0 - smoothstep(0.04, 0.12, fw.y)); // gone once smaller than a pixel
  float seaN = sNoise(vLocal.xy * vec2(0.07, 0.45));
  if (hullSkin && vMark.y > 0.5) {
    // Topsides: the ship's colour, plate by plate, chalkier high up where the sun works on it.
    vec3 paint = uPaint * (1.0 + 0.09 * tone) * (0.93 + 0.12 * seaN);
    paint = mix(paint, vec3(dot(paint, vec3(0.3, 0.59, 0.11))) * 1.25 + 0.01, 0.08 * smoothstep(2.0, 9.0, vLocal.y));
    paint *= 1.0 - 0.07 * seam;
    // Rust weeping from the deck edge and its scuppers: thin runs, some long, most short.
    float top = uSheer.x + uSheer.z * (1.0 - smoothstep(uSheer.y - 2.0, uSheer.y + 2.0, vLocal.x));
    float cx = vLocal.x / 1.9;
    float ci = floor(cx);
    float wid = 0.06 + 0.12 * sHash(vec2(ci, 7.7));
    float inCol = 1.0 - smoothstep(wid * 0.35, wid, abs(fract(cx) - 0.3 - 0.4 * sHash(vec2(ci, 2.9))));
    float down = top - 0.2 - vLocal.y;
    float len = mix(1.2, 8.0, pow(sHash(vec2(ci, 1.3)), 2.0));
    float run = inCol * step(0.72, sHash(vec2(ci, 3.1))) * (1.0 - smoothstep(0.0, len, down)) * step(-0.4, down);
    run *= 0.55 + 0.45 * sNoise(vec2(vLocal.x * 5.0, vLocal.y * 0.5));
    // Heavy rust under the hawse pipes, where the anchor chain scrapes.
    float hx = abs(vLocal.x - uHawse.x);
    float below = uHawse.y - vLocal.y;
    float hawse = (1.0 - smoothstep(0.6 + below * 0.08, 1.6 + below * 0.14, hx)) * step(-0.3, below) * (1.0 - smoothstep(3.0, 12.0, below));
    hawse *= 0.75 + 0.25 * sNoise(vec2(vLocal.x * 3.0, vLocal.y * 0.4));
    vec3 rustHi = vec3(0.17, 0.06, 0.022);
    vec3 rustLo = vec3(0.08, 0.04, 0.025);
    float rust = clamp(run * 0.5 + 0.85 * hawse, 0.0, 0.85);
    paint = mix(paint, mix(rustLo, rustHi, smoothstep(0.0, 4.0, vLocal.y - (top - 6.0))), rust);
    diffuseColor.rgb = paint;
    shipRough = mix(0.52 + 0.12 * tone, 0.85, rust);
  } else if (vMark.y > 1.5) {
    diffuseColor.rgb = uBand;
  } else if (hullSkin) {
    // Boot-top and antifouling: flatter paints; the red bleaches pink near the top, with weed at the old waterlines.
    bool anti = vLocal.y < uBoot.x;
    diffuseColor.rgb *= (1.0 + 0.07 * tone) * (0.92 + 0.14 * seaN) * (1.0 - 0.07 * seam);
    if (anti) diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.3 + vec3(0.02, 0.012, 0.01), 0.5 * smoothstep(uBoot.x - 4.0, uBoot.x, vLocal.y));
    float weed = smoothstep(0.5, 0.85, sNoise(vec2(vLocal.x * 0.6, vLocal.y * 2.5))) * (1.0 - smoothstep(0.0, 1.2, abs(vLocal.y - uBoot.x + 0.4)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.06, 0.03), weed * 0.6);
    shipRough = anti ? 0.82 : 0.55 + 0.1 * tone;
  }
  if (hullSkin) {
    // A brown salt-and-grime line where she usually floats, and the curve of the hull
    // shading towards the water: faces turned to the sky paler, the bilge and under the flare darker.
    float line = 1.0 - smoothstep(0.0, 0.9 + 0.6 * seaN, abs(vLocal.y - 0.3));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.07, 0.06, 0.04), 0.45 * line);
    vec3 nW = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
    diffuseColor.rgb *= 0.66 + 0.42 * smoothstep(-0.6, 0.55, nW.y);
  }
  if (vMark.z > 0.5) {
    // Boxes, hatches and deck: grime and a little rust, so no two read as clean plastic.
    float g = sNoise(vLocal.xz * 0.35 + vLocal.y * 0.2) * 0.6 + sNoise(vec2(vLocal.x * 1.7, vLocal.y * 0.4 + vLocal.z * 1.7)) * 0.4;
    diffuseColor.rgb *= 0.84 + 0.24 * g;
    float rs = smoothstep(0.72, 0.95, sNoise(vec2(vLocal.x * 2.1 + vLocal.z * 2.1, vLocal.y * 0.3)));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.08, 0.04), rs * 0.35);
  }
  // Hull steel darkens towards the water (wet, salt-stained, and in the shade of the flare).
  if (vMark.x < 0.01 && vMark.z < 0.5) diffuseColor.rgb *= mix(0.8, 1.0, smoothstep(-uBow.z - 1.0, -uBow.z + 7.0, vLocal.y));
  if (uBow.x > 0.0 && vLocal.y > -uBow.z - 0.6) {
    // Under way: the bow wave climbing the stem and breaking white down the bow, a
    // lower, broken wash along the sides (the same foam the sea draws, boatWash.ts).
    float xs = max(vLocal.x, 0.0);
    float top = uBow.x * exp(-pow(xs / (0.11 * uBow.y), 1.5)) + 0.45 * min(uBow.x, 1.2) * (1.0 - smoothstep(0.7 * uBow.y, uBow.y, xs));
    float n = sNoise(vec2(vLocal.x * 0.9 + uSeaTime * 2.0, vLocal.y * 2.2)) * 0.6 + sNoise(vec2(vLocal.x * 2.7 - uSeaTime * 3.0, vLocal.y * 5.0)) * 0.4;
    float edge = top * (0.65 + 0.5 * n);
    // Solid white where it heaps up against the stem, breaking into lace further aft.
    float solid = exp(-xs / (0.09 * uBow.y));
    float foam = (1.0 - smoothstep(edge * 0.8, edge, vLocal.y + uBow.z)) * mix(smoothstep(0.3, 0.6, n), 0.85 + 0.15 * n, solid * smoothstep(0.35, 0.6, n));
    // The stem itself, up to the crest, is all white: nothing dark pokes through where the two sides meet.
    foam = max(foam, (1.0 - smoothstep(2.0, 5.0, vLocal.x)) * (1.0 - smoothstep(top * 0.85, top, vLocal.y + uBow.z)) * step(0.15, uBow.x) * (0.88 + 0.12 * n));
    // Right at the waterline forward the hull is buried in white water: no dark boot-top showing through.
    foam = max(foam, (1.0 - smoothstep(0.5, 1.4, vLocal.y + uBow.z)) * exp(-xs / (0.18 * uBow.y)) * smoothstep(0.1, 0.6, uBow.x) * (0.85 + 0.15 * n));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.9, 0.93, 0.95), foam * 0.95);
  }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\n  if (shipRough > 0.0) roughnessFactor = shipRough;",
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
  // Lit cabin windows after dark, and the decks under the working lights at anchor.
  totalEmissiveRadiance += vec3(1.0, 0.72, 0.42) * vMark.x * uNight * 2.2;
  totalEmissiveRadiance += diffuseColor.rgb * vec3(1.0, 0.82, 0.55) * vMark.z * uFlood * uNight * 0.55;`,
      )
      // Fogged out over a longer distance than the sea (traffic.ts HULL_REACH), since a dark hull shows through haze.
      .replace("#include <fog_fragment>", "#ifdef USE_FOG\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 0.85 * smoothstep(fogNear, fogFar * 2.2, vFogDepth));\n#endif");
  };
  m.customProgramCacheKey = () => "boatsim-ship-v4-steel";
  return m;
}

function hawseY(kind: ShipKind): number {
  const h = kind === "container" ? C_HULL : kind === "tanker" ? T_HULL : B_HULL;
  return sheerY(h, h.L * 0.03) - 2.6;
}

/**
 * How high a ship's bow wave climbs her stem (m): GUESS, 0.8 of the stagnation head v^2 / 2g,
 * scaled by how much of a wave her Froude number makes (boatWash.ts shipFoam); a box ship at
 * 18 knots about 2.3 m, a slow tanker about 1 m, a ship at anchor none.
 */
/**
 * How much white water a ship of this length makes at this speed, 0..1, from its Froude
 * number Fr = v / sqrt(g L) (Theo): a slow coaster or a ship at anchor makes none; a box
 * ship at 18 knots (Fr 0.17) a white bow wave and a churned lane; a trawler at 6 knots
 * (Fr 0.2) a full one. GUESS, tuned by eye.
 */
export function shipFoam(speed: number, length: number): number {
  const fr = speed / Math.sqrt(9.81 * Math.max(length, 1));
  return THREE.MathUtils.clamp((fr - 0.07) / 0.14, 0, 1);
}

export function bowWaveOnStem(speed: number, length: number): number {
  return ((1.1 * speed * speed) / (2 * 9.81)) * Math.sqrt(shipFoam(speed, length));
}

/**
 * A ship of a kind, ready to place: the hull and its lights, "underway" and "anchored"
 * (show one; dressShip() does), and "floods", the deck lights at anchor. `range` fades the
 * lights out with distance (m).
 */

// ---------- the bow wave ----------
// A real curl of white water: on each side a sheet that climbs the stem to the bow-wave
// height, rolls over at a lip and falls outward to the sea, peeling aft along the hull and
// breaking into foam a third of the way down her length. Built at unit height and width;
// the shader scales it by uBowH (the wave's height at the stem, m) so one mesh serves every speed.

const BOW_ALONG = 48; // sections from the stem aft
const BOW_ACROSS = 10; // from the hull out to the sea

function bowWaveGeometry(kind: ShipKind): THREE.BufferGeometry {
  const h = kind === "container" ? C_HULL : kind === "tanker" ? T_HULL : kind === "bulk" ? B_HULL : F_HULL;
  const len = 0.34 * h.L;
  const pos: number[] = [];
  const uv: number[] = [];
  const side: number[] = [];
  const idx: number[] = [];
  for (const sgn of [1, -1]) {
    const base = pos.length / 3;
    for (let i = 0; i <= BOW_ALONG; i++) {
      const u = i / BOW_ALONG;
      const x = Math.pow(u, 1.3) * len; // closer sections near the stem, where it's busiest
      const hb = halfBreadth(h, Math.max(x, 0.2), 0);
      for (let j = 0; j <= BOW_ACROSS; j++) {
        const t = j / BOW_ACROSS;
        // Cross-section, in units of the stem height: up the hull (t 0..0.35), over the
        // lip (0.35..0.55), down the face to the sea (0.55..1). y is height, w is out from the hull.
        const lip = 0.45;
        const y = t < lip ? 0.15 + 0.85 * Math.sin((t / lip) * Math.PI * 0.5) : Math.cos(((t - lip) / (1 - lip)) * Math.PI * 0.5) - 0.12;
        const w = t < lip ? 0.25 * (t / lip) : 0.25 + 1.6 * Math.pow((t - lip) / (1 - lip), 1.4);
        const rake = stemX(h, 4) * Math.exp(-x / 6); // the stem rakes forward above the water: start the sheet on it
        pos.push(x + rake + 0.6 * w * u, y, sgn * (hb + 0.15 * Math.min(1, x / 3))); // z gets the outward width in the shader
        uv.push(u, t);
        side.push(sgn * w);
      }
    }
    for (let i = 0; i < BOW_ALONG; i++)
      for (let j = 0; j < BOW_ACROSS; j++) {
        const a = base + i * (BOW_ACROSS + 1) + j;
        const b = a + BOW_ACROSS + 1;
        idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute("aOut", new THREE.Float32BufferAttribute(side, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function bowWaveMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xf4f7f8, roughness: 0.9, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  const u = { uBowH: { value: 0 }, uSeaTime: seaUniforms.uSeaTime };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace(
        "void main() {",
        `uniform float uBowH;
uniform float uSeaTime;
attribute float aOut;
varying vec2 vBw;
void main() {
  vBw = uv;`,
      )
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  // Height falls off aft of the stem; the sheet spreads wider as it peels away.
  float hk = uBowH * (0.25 + 0.75 * exp(-uv.x * 3.2)) * (1.0 + 0.08 * sin(uSeaTime * 3.0 + uv.x * 17.0));
  // A lumpy, torn crest: the lip rises and falls along the hull and over time.
  float lump = sin(uv.x * 61.0 + uSeaTime * 2.3) * 0.5 + sin(uv.x * 23.0 - uSeaTime * 1.7 + 1.3) * 0.5;
  float atLip = exp(-pow((uv.y - 0.45) / 0.15, 2.0));
  transformed.y *= hk * (1.0 + 0.22 * lump * atLip);
  transformed.z += aOut * hk * (1.0 + 2.5 * uv.x);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "void main() {",
        `uniform float uSeaTime;
varying vec2 vBw;
float bwHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float bwNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 q = f * f * (3.0 - 2.0 * f);
  return mix(mix(bwHash(i), bwHash(i + vec2(1, 0)), q.x), mix(bwHash(i + vec2(0, 1)), bwHash(i + vec2(1, 1)), q.x), q.y);
}
void main() {`,
      )
      .replace(
        "#include <alphamap_fragment>",
        `#include <alphamap_fragment>
  {
    // White where it climbs the hull and along the lip, solid at the stem and lace aft; under
    // the lip the face of the wave is dark, glassy water falling back to the sea (Elena).
    vec2 q = vec2(vBw.x * 38.0 - uSeaTime * 1.6, vBw.y * 5.0 + uSeaTime * 0.7);
    float n = bwNoise(q) * 0.6 + bwNoise(q * 2.7 + 3.1) * 0.4;
    float solid = (1.0 - smoothstep(0.05, 0.55, vBw.x)) * smoothstep(0.18, 0.36, vBw.y + 0.25 * n) * (1.0 - smoothstep(0.5, 0.66, vBw.y)); // the lip
    float lace = smoothstep(0.42, 0.62, n + 0.3 * solid);
    float white = mix(lace * (1.0 - smoothstep(0.55, 0.8, vBw.y)) * (0.55 + 0.45 * n), 0.95, solid * 0.85);
    // Streaks of foam running down the dark face.
    float streak = smoothstep(0.6, 0.85, bwNoise(vec2(vBw.x * 70.0, vBw.y * 1.5 - uSeaTime * 0.9))) * smoothstep(0.5, 0.7, vBw.y) * 0.7;
    white = max(white, streak);
    float face = smoothstep(0.42, 0.6, vBw.y) * (1.0 - smoothstep(0.85, 1.0, vBw.y)) * 0.9;
    // Right at the stem it's all churned white, no glassy face yet.
    white = max(white, (1.0 - smoothstep(0.04, 0.2, vBw.x)) * (0.7 + 0.3 * smoothstep(0.3, 0.6, n)));
    // Dense where it climbs the hull near the stem: the hull's dark boot-top mustn't show through.
    white = max(white, (1.0 - smoothstep(0.3, 0.48, vBw.y)) * (1.0 - smoothstep(0.2, 0.5, vBw.x)) * (0.82 + 0.18 * n));
    float a = max(white, face);
    a *= 1.0 - smoothstep(0.7, 1.0, vBw.x);          // dies out aft
    a *= smoothstep(0.0, 0.08, vBw.y);               // into the hull
    // Glassy and dark under the lip aft; churned pale with air close to the stem.
    vec3 water = mix(vec3(0.52, 0.66, 0.7), vec3(0.035, 0.12, 0.15), smoothstep(0.06, 0.3, vBw.x)) * (0.8 + 0.4 * n);
    diffuseColor.rgb = mix(water, diffuseColor.rgb * (0.86 + 0.14 * n), clamp(white / max(a, 1e-3), 0.0, 1.0));
    // Volume: lit on top of the roll, shadowed under it, a thin blue-green edge where the lip
    // thins and the light comes through; torn into lumps along the crest.
    float under = smoothstep(0.44, 0.52, vBw.y) * (1.0 - smoothstep(0.58, 0.8, vBw.y));
    float lit = 1.0 - smoothstep(0.3, 0.45, vBw.y);
    float edge = exp(-pow((vBw.y - 0.47) / 0.035, 2.0)) * smoothstep(0.04, 0.15, vBw.x);
    diffuseColor.rgb *= mix(1.0, 0.5, under) * (1.0 + 0.18 * lit);
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.26, 0.6, 0.58), edge * 0.7);
    float tear = bwNoise(vec2(vBw.x * 95.0 - uSeaTime * 2.0, vBw.y * 14.0 + uSeaTime));
    a *= 1.0 - exp(-pow((vBw.y - 0.42) / 0.06, 2.0)) * smoothstep(0.55, 0.75, tear) * smoothstep(0.03, 0.12, vBw.x);
    diffuseColor.a *= a;
    if (diffuseColor.a < 0.02) discard;
  }`,
      );
  };
  m.customProgramCacheKey = () => "boatsim-bowwave-v1";
  return m;
}

/** Spray thrown off the top of the bow wave: specks rising and falling out from the lip. */
function bowSprayPoints(kind: ShipKind): THREE.Points {
  const h = kind === "container" ? C_HULL : kind === "tanker" ? T_HULL : kind === "bulk" ? B_HULL : F_HULL;
  const len = 0.34 * h.L;
  const N = 1400;
  const pos: number[] = [];
  const seed: number[] = [];
  let r = 12345;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < N; k++) {
    const sgn = k % 2 ? 1 : -1;
    const u = Math.pow(rnd(), 2.0) * 0.4; // mostly near the stem
    const x = Math.pow(u, 1.3) * len;
    const hb = halfBreadth(h, Math.max(x, 0.2), 0);
    pos.push(x, 1, sgn * (hb + 0.15 * Math.min(1, x / 3)));
    seed.push(u, rnd(), sgn, 0.5 + rnd());
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aSpray", new THREE.Float32BufferAttribute(seed, 4));
  const m = new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: true, transparent: true, depthWrite: false, fog: false });
  const u = { uBowH: { value: 0 }, uSeaTime: seaUniforms.uSeaTime, uNight: NAV_NIGHT, uFogAmt: { value: 0 } };
  m.userData.u = u;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace("void main() {", "uniform float uBowH;\nuniform float uSeaTime;\nuniform float uNight;\nuniform float uFogAmt;\nattribute vec4 aSpray;\nvarying float vSpray;\nvoid main() {")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
  float ph = fract(uSeaTime * 0.7 * aSpray.w + aSpray.y);
  float hk = uBowH * (0.25 + 0.75 * exp(-aSpray.x * 3.2));
  transformed.y = hk * (0.95 + 1.2 * ph * (1.0 - ph) * aSpray.w);  // up and back down
  transformed.z += aSpray.z * hk * (0.3 + 1.4 * ph) * smoothstep(0.0, 0.12, aSpray.x); // thrown outward (not across the stem)
  transformed.x += 3.0 * ph;                                         // left behind as she goes on
  vSpray = (1.0 - ph) * (1.0 - ph) * smoothstep(0.0, 0.08, ph) * (0.6 + 0.4 * step(0.93, fract(aSpray.y * 37.0))) * (1.0 - 0.6 * smoothstep(0.0, 0.25, uFogAmt)) * (1.0 - uNight) * step(0.15, uBowH);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("void main() {", "varying float vSpray;\nvoid main() {")
      .replace("#include <color_fragment>", "#include <color_fragment>\n  diffuseColor.a *= vSpray * 0.75 * (1.0 - smoothstep(0.1, 0.5, length(gl_PointCoord - 0.5)));\n  if (diffuseColor.a < 0.02) discard;");
  };
  m.customProgramCacheKey = () => "boatsim-bowspray-v1";
  const p = new THREE.Points(g, m);
  p.name = "bowSpray";
  p.frustumCulled = false;
  return p;
}

export function makeShip(kind: ShipKind, range: { value: number }): THREE.Group {
  const s = new THREE.Group();
  s.name = `ship_${kind}`;
  const hull = new THREE.Mesh(shipGeometry(kind), shipMaterial(kind));
  hull.name = "hull";
  s.add(hull);
  const bow = new THREE.Mesh(bowWaveGeometry(kind), bowWaveMaterial());
  bow.name = "bowWave";
  bow.visible = false;
  bow.renderOrder = 2; // over the sea's foam
  s.add(bow);
  const spray = bowSprayPoints(kind);
  spray.visible = false;
  spray.renderOrder = 3;
  bow.add(spray);
  const l = shipLights(kind);
  // Big ships' lanterns are bigger and brighter than a yacht's: they carry 6 nautical miles.
  const size = kind === "fishing" ? 0.026 : 0.034;
  addLanterns(s, l.underway, { size, range }).name = "underway";
  addLanterns(s, l.anchored, { size, range }).name = "anchored";
  addLanterns(s, floodLamps(kind), { size: size * 0.6, range }).name = "floods";
  s.rotation.order = "YXZ"; // heading, then roll about the keel, then pitch
  return s;
}

/** Paint a ship and set its lights for a sighting: `seed` in 0..1 picks the colours. */
/** How far a ship floats above her loaded marks when empty (m): tankers and bulk carriers run home in ballast. */
export const BALLAST_LIFT: Record<ShipKind, number> = { container: 1.5, tanker: 6, bulk: 5, fishing: 0 };

/**
 * Paint a ship and set her lights and trim for a sighting: `seed` in 0..1 picks the colours
 * and whether she is in ballast (empty, riding high with her red bottom showing). Her lift
 * (m) is left in userData.lift for whoever places her.
 */
export function dressShip(s: THREE.Group, kind: ShipKind, seed: number, anchored: boolean, speed = 0): void {
  const hull = s.getObjectByName("hull") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  const u = hull.material.userData.u;
  const cols = HULL_COLOURS[kind];
  u.uPaint.value.setHex(cols[Math.floor(seed * 7919) % cols.length]);
  u.uBand.value.setHex(BANDS[Math.floor(seed * 104729) % BANDS.length]);
  u.uFlood.value = anchored ? 1 : 0;
  u.uBow.value.x = anchored ? 0 : bowWaveOnStem(speed, SHIP_SIZE[kind].length);
  const ballast = kind !== "fishing" && (Math.floor(seed * 3571) % 100) / 100 < (kind === "container" ? 0.2 : 0.45);
  s.userData.lift = ballast ? BALLAST_LIFT[kind] : 0;
  u.uBow.value.z = s.userData.lift;
  s.getObjectByName("underway")!.visible = !anchored;
  s.getObjectByName("anchored")!.visible = anchored;
  const bow = s.getObjectByName("bowWave") as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  bow.material.userData.u.uBowH.value = u.uBow.value.x;
  bow.visible = u.uBow.value.x > 0.15;
  const spray = bow.getObjectByName("bowSpray") as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  spray.material.userData.u.uBowH.value = u.uBow.value.x;
  spray.visible = bow.visible;
  bow.position.y = -s.userData.lift; // she rides higher in ballast; the wave stays on the sea
  s.getObjectByName("floods")!.visible = anchored && kind !== "fishing";
}
