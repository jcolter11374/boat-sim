// Other ships: generic, made-up designs of the three kinds you meet most at sea, a
// container ship, a crude-oil tanker and a stern trawler (a fishing boat that tows its
// net from a frame at the stern). Each is one merged mesh coloured per vertex, so a
// ship costs one draw call, plus its lights.
//
// Lights, as the international collision rules (COLREGs, 1972) set them:
//   container ship and tanker (powered, 50 m and over) under way (Rule 23(a)):
//     a white masthead light forward and a second, higher one aft, each shining over
//     225 degrees ahead (from dead ahead to 22.5 degrees behind the beam on each side);
//     red and green sidelights (112.5 degrees each); a white sternlight (135 degrees);
//   at anchor (Rule 30(a)): an all-round white light forward and a lower one aft;
//   the trawler, trawling (Rule 26(b)): all-round green over all-round white, plus
//     sidelights and a sternlight while it's making way through the water.
// Builder frame, as for our own boats: x aft from the bow, y up from the waterline,
// z to port. Display only.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { addLanterns, GREEN, RED, WHITE, type Arc, type Lantern } from "./navlights";

export type ShipKind = "container" | "tanker" | "fishing";
export const SHIP_KINDS: ShipKind[] = ["container", "tanker", "fishing"];

/** Length and beam (m) of each kind. */
export const SHIP_SIZE: Record<ShipKind, { length: number; beam: number }> = {
  container: { length: 230, beam: 32 },
  tanker: { length: 180, beam: 32 },
  fishing: { length: 24, beam: 7 },
};

const MASTHEAD: Arc[] = [{ colour: WHITE, from: 247.5, to: 112.5 }];
const STERN: Arc[] = [{ colour: WHITE, from: 112.5, to: 247.5 }];
const STBD: Arc[] = [{ colour: GREEN, from: 0, to: 112.5 }];
const PORT: Arc[] = [{ colour: RED, from: 247.5, to: 360 }];
const ROUND = (colour: number): Arc[] => [{ colour, from: 0, to: 360 }];

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Where each kind's lanterns go, under way and at anchor (builder frame, m). */
export function shipLights(kind: ShipKind): { underway: Lantern[]; anchored: Lantern[] } {
  const { length: L, beam: B } = SHIP_SIZE[kind];
  if (kind === "fishing")
    return {
      underway: [
        { arcs: ROUND(GREEN), at: V(8, 11.5, 0) },
        { arcs: ROUND(WHITE), at: V(8, 9.3, 0) },
        { arcs: STBD, at: V(6, 5.6, -2.5) },
        { arcs: PORT, at: V(6, 5.6, 2.5) },
        { arcs: STERN, at: V(L, 3.4, 0) },
      ],
      anchored: [{ arcs: ROUND(WHITE), at: V(2, 6, 0) }],
    };
  const c = kind === "container";
  const bridge = c ? 182 : 152; // the bridge wings' fore-and-aft place
  const top = c ? 41 : 28; // the bridge roof
  return {
    underway: [
      { arcs: MASTHEAD, at: V(c ? 25 : 20, c ? 24 : 21, 0) },
      { arcs: MASTHEAD, at: V(bridge + 3, top + 9, 0) },
      { arcs: STBD, at: V(bridge, top - 1, -B / 2) },
      { arcs: PORT, at: V(bridge, top - 1, B / 2) },
      { arcs: STERN, at: V(L, c ? 12 : 9, 0) },
    ],
    anchored: [
      { arcs: ROUND(WHITE), at: V(4, c ? 20 : 16, 0) },
      { arcs: ROUND(WHITE), at: V(L - 3, c ? 13 : 10, 0) },
    ],
  };
}

/** A box from (x0, y0, z0) to (x1, y1, z1), in one colour. */
function box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed();
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return paint(g, colour);
}

function paint(g: THREE.BufferGeometry, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  g.deleteAttribute("uv");
  const c = new THREE.Color(colour);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("color", new THREE.BufferAttribute(a, 3));
  return g;
}

/** The hull in plan, a pointed bow easing out to the full beam, a square stern; from y0 to y1. */
function hull(L: number, B: number, bow: number, y0: number, y1: number, colour: THREE.ColorRepresentation): THREE.BufferGeometry {
  const h = B / 2;
  const r = Math.min(3, B / 6);
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.quadraticCurveTo(bow * 0.2, h, bow, h);
  s.lineTo(L - r, h);
  s.quadraticCurveTo(L, h, L, h - r);
  s.lineTo(L, -h + r);
  s.quadraticCurveTo(L, -h, L - r, -h);
  s.lineTo(bow, -h);
  s.quadraticCurveTo(bow * 0.2, -h, 0, 0);
  const g = new THREE.ExtrudeGeometry(s, { depth: y1 - y0, bevelEnabled: false, curveSegments: 8 });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return paint(g.index ? g.toNonIndexed() : g, colour);
}

const BOX_COLOURS = ["#b8382c", "#2c5d8f", "#d69c34", "#3c7c48", "#8b9097", "#dedad0", "#6a3f88", "#1e3c5c", "#c75a22", "#4a8f9a"];

function container(): THREE.BufferGeometry[] {
  const { length: L, beam: B } = SHIP_SIZE.container;
  const deck = 9;
  const parts = [hull(L, B, 34, -3, 1.2, "#7c2a24"), hull(L, B, 34, 1.2, deck, "#1c2a44")];
  // Containers, 12.2 m (40 ft) long, 2.44 m wide, 2.6 m tall, stacked unevenly.
  let s = 31;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let x = 30; x + 12.2 < 176; x += 13.4) {
    const taper = Math.min(1, (x - 18) / 40); // narrower towards the bow
    const rows = Math.max(4, Math.floor(12 * taper));
    for (let r = 0; r < rows; r++) {
      const z = (r - (rows - 1) / 2) * 2.5;
      const tiers = 3 + Math.floor(rnd() * 5);
      for (let k = 0; k < tiers; k++) parts.push(box(x, x + 12.2, deck + k * 2.6, deck + (k + 1) * 2.6 - 0.05, z - 1.2, z + 1.2, BOX_COLOURS[Math.floor(rnd() * BOX_COLOURS.length)]));
    }
  }
  parts.push(
    box(23, 26, deck, 24, -0.6, 0.6, "#d8d6cf"), // foremast
    box(178, 192, deck, 41, -13, 13, "#e8e6df"), // accommodation and bridge
    box(177.8, 192.2, 37, 40, -13.2, 13.2, "#1c232b"), // bridge windows
    box(179, 185, 38, 41, -B / 2, B / 2, "#e8e6df"), // bridge wings
    box(184, 186, 41, 50, -0.5, 0.5, "#d8d6cf"), // mast
    box(198, 208, deck, 34, -4, 4, "#1c2a44"), // funnel
    box(197.9, 208.1, 28, 31, -4.1, 4.1, "#c8a03a"), // funnel band
    box(210, L - 1, deck, deck + 1.2, -B / 2 + 0.3, B / 2 - 0.3, "#5a5f66"), // poop deck gear
  );
  return parts;
}

function tanker(): THREE.BufferGeometry[] {
  const { length: L, beam: B } = SHIP_SIZE.tanker;
  const deck = 6;
  const parts = [hull(L, B, 26, -3, 1.2, "#7c2a24"), hull(L, B, 26, 1.2, deck, "#1b1d21")];
  parts.push(
    box(14, 148, deck + 0.02, deck + 0.3, -B / 2 + 1.5, B / 2 - 1.5, "#6b2b24"), // deck paint
    box(14, 148, deck + 0.3, deck + 2, -1, 1, "#9aa0a6"), // pipe rack
    box(84, 96, deck + 0.3, deck + 3, -B / 2 + 2, B / 2 - 2, "#9aa0a6"), // cargo manifold
    box(30, 34, deck + 0.3, deck + 5, -B / 2 + 3, B / 2 - 3, "#7d8288"), // a hose crane and its walkway
    box(19, 21, deck, 21, -0.6, 0.6, "#d8d6cf"), // foremast
    box(2, 16, deck, deck + 2.5, -B / 2 + 4, B / 2 - 4, "#1b1d21"), // forecastle
    box(150, 168, deck, 28, -12, 12, "#e8e6df"), // accommodation and bridge
    box(149.8, 168.2, 24, 27, -12.2, 12.2, "#1c232b"), // bridge windows
    box(151, 156, 25, 28, -B / 2, B / 2, "#e8e6df"), // bridge wings
    box(154, 156, 28, 37, -0.5, 0.5, "#d8d6cf"), // mast
    box(168, 176, deck, 30, -3.5, 3.5, "#1b1d21"), // funnel
    box(167.9, 176.1, 24, 27, -3.6, 3.6, "#b03a2e"), // funnel band
  );
  return parts;
}

function fishing(): THREE.BufferGeometry[] {
  const { length: L, beam: B } = SHIP_SIZE.fishing;
  const deck = 2.2;
  return [
    hull(L, B, 7, -1, 0.4, "#2a2d31"),
    hull(L, B, 7, 0.4, deck, "#a8322a"),
    box(0.5, 6, deck, deck + 1.2, -B / 2 + 0.8, B / 2 - 0.8, "#a8322a"), // raised bow
    box(5, 11, deck, 6.5, -2.4, 2.4, "#ecebe6"), // wheelhouse
    box(4.9, 11.1, 5, 6, -2.5, 2.5, "#1c232b"), // its windows
    box(7.8, 8.2, 6.5, 12, -0.2, 0.2, "#d8d6cf"), // mast
    box(14, 18, deck, deck + 1.6, -2, 2, "#3a6b4a"), // net drum
    box(21.6, 22.2, deck, 8, 2.6, 3.2, "#e0a028"), // stern gantry (the A-frame the net is towed from)
    box(21.6, 22.2, deck, 8, -3.2, -2.6, "#e0a028"),
    box(21.6, 22.2, 7.4, 8, -3.2, 3.2, "#e0a028"),
  ];
}

const geos = new Map<ShipKind, THREE.BufferGeometry>();
let material: THREE.MeshStandardMaterial | null = null;

/** One kind's merged mesh (built once, shared by every ship of that kind). */
export function shipGeometry(kind: ShipKind): THREE.BufferGeometry {
  let g = geos.get(kind);
  if (!g) {
    const parts = kind === "container" ? container() : kind === "tanker" ? tanker() : fishing();
    g = mergeGeometries(parts)!;
    for (const p of parts) p.dispose();
    g.computeBoundingSphere();
    geos.set(kind, g);
  }
  return g;
}

/** Painted steel; fogged out over a longer distance than the sea (traffic.ts HULL_REACH), since a dark hull shows through haze. */
function shipMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0.05 });
  m.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace("#include <fog_fragment>", "#ifdef USE_FOG\n  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, smoothstep(fogNear, fogFar * 1.8, vFogDepth));\n#endif");
  };
  m.customProgramCacheKey = () => "boatsim-ship-v1";
  return m;
}

const templates = new Map<ShipKind, THREE.Group>();

/**
 * A ship of a kind, ready to place: the hull and its two sets of lights, "underway"
 * and "anchored" (show one). `range` fades the lights out with distance (m).
 */
export function makeShip(kind: ShipKind, range: { value: number }): THREE.Group {
  let t = templates.get(kind);
  if (!t) {
    material ??= shipMaterial();
    t = new THREE.Group();
    t.name = `ship_${kind}`;
    t.add(new THREE.Mesh(shipGeometry(kind), material));
    const l = shipLights(kind);
    addLanterns(t, l.underway, { size: 0.03, range }).name = "underway";
    addLanterns(t, l.anchored, { size: 0.03, range }).name = "anchored";
    templates.set(kind, t);
  }
  const s = t.clone(); // shares the geometry and materials
  s.rotation.order = "YXZ"; // heading, then roll about the keel, then pitch
  return s;
}
