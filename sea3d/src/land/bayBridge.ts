// The Chesapeake Bay Bridge on the horizon north-east of the practice course (M5, Hana): the
// landmark every Annapolis sailor steers by. Two spans side by side, 6.5 km shore to shore, each
// climbing to a suspension section over the ship channel with towers over 100 m tall, and a
// smaller truss over the eastern channel. Drawn in code as one merged shape per span (a few
// thousand triangles), with the road's lights and the towers' red lights after dark. Display only.
//
// From Wikipedia's "Chesapeake Bay Bridge" page (read 14 Nov 2026): middle at 38.99167 N,
// 76.37222 W; 6,484 m (the 1952 span) and 6,415 m (1973); towers 107.9 m and 115.5 m; a 975 m
// suspension section with a 488 m main span, 56.7 m clear above the water; a 210 m through truss
// over the eastern channel; decks 8.5 m and 11.6 m wide.
// GUESS (not in that page; from memory of the chart): the line it runs on, where along it the two
// channels cross, the low trestle's height, the eastern truss's height, how far apart the two
// spans stand, the piers' spacing. The curve at its western end is left out.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { R_EARTH } from "./shader";
import { nightOf } from "./town";
import { offsetOf } from "./landmarks";

export const BAY_BRIDGE = {
  lat: 38.99167,
  lon: -76.37222,
  /** Which way it runs, west end to east end (degrees true). GUESS: Sandy Point to Kent Island. */
  bearing: 119,
  length: 6450,
  /** The suspension section's middle and the eastern truss's, metres along from the bridge's middle (+ east). GUESS: the ship channel's green buoy 91 lies south of the first. */
  main: -1250,
  east: 1350,
  mainSpan: 488,
  suspended: 975,
  clearance: 56.7,
  /** The two spans: tower height, deck width, and how far across from the middle line (m; GUESS about 140 m apart). */
  spans: [
    { tower: 107.9, width: 8.5, across: 70 }, // 1952, the southern one
    { tower: 115.5, width: 11.6, across: -70 }, // 1973
  ],
};

/** The bridge's colour as drawn. */
export const BRIDGE_GREY = 0x525c64;
/** Drawn within this of the boat (m): past it the haze has it. */
export const BRIDGE_RANGE = 22000;
const LOW = 10; // the trestle near the shores (m above the water). GUESS
const GRADE = 0.03; // how steeply the road climbs to the high spans. GUESS: about what a highway allows
const EAST_DECK = 20; // the eastern truss's road (m above the water). GUESS
const DECK = 3; // the road and its girders, top to bottom (m)

/** The road's height above the water (m) at s metres along from the middle. */
export function deckHeight(s: number): number {
  const B = BAY_BRIDGE;
  const main = B.clearance + DECK - GRADE * Math.max(0, Math.abs(s - B.main) - B.mainSpan / 2);
  const east = EAST_DECK - GRADE * Math.max(0, Math.abs(s - B.east) - 105);
  return Math.max(LOW, main, east);
}

/** A beam from (s0, y0) to (s1, y1) in the bridge's own upright plane, t thick and w across, at z across. */
function beam(s0: number, y0: number, s1: number, y1: number, t: number, w: number, z = 0): THREE.BufferGeometry {
  const len = Math.hypot(s1 - s0, y1 - y0);
  const g = new THREE.BoxGeometry(len, t, w);
  g.rotateZ(Math.atan2(y1 - y0, s1 - s0));
  g.translate((s0 + s1) / 2, (y0 + y1) / 2, z);
  return g;
}

/** One span's shape: x along the bridge from its middle (+ east), y up from the water, z across. */
export function spanGeometry(tower: number, width: number): THREE.BufferGeometry {
  const B = BAY_BRIDGE;
  const parts: THREE.BufferGeometry[] = [];
  const half = B.length / 2;
  const t0 = B.main - B.mainSpan / 2;
  const t1 = B.main + B.mainSpan / 2;
  const a0 = B.main - B.suspended / 2;
  const a1 = B.main + B.suspended / 2;
  // The road, in 50 m lengths following its grade; deeper girders where it is carried high.
  for (let s = -half; s < half; s += 50) {
    const y0 = deckHeight(s);
    const y1 = deckHeight(Math.min(half, s + 50));
    const deep = Math.max(y0, y1) > 25 ? 7 : DECK;
    parts.push(beam(s, y0 - deep / 2, Math.min(half, s + 50), y1 - deep / 2, deep, width));
  }
  // Piers: close together under the low trestle, further apart under the high spans; none in the channels.
  for (let s = -half; s <= half; ) {
    const h = deckHeight(s);
    const inMain = s > a0 + 10 && s < a1 - 10;
    const inEast = Math.abs(s - B.east) < 100;
    if (!inMain && !inEast) parts.push(new THREE.BoxGeometry(h > 25 ? 5 : 2.5, h, width * 0.8).translate(s, h / 2 - 2, 0));
    s += h > 25 ? 120 : 60;
  }
  // The suspension section: two towers, the main cables from anchor to tower to tower to anchor.
  for (const s of [t0, t1]) {
    for (const z of [-width / 2 - 1, width / 2 + 1]) parts.push(new THREE.BoxGeometry(5, tower + 2, 2.5).translate(s, tower / 2 - 1, z));
    for (const y of [tower - 2, tower * 0.78, deckHeight(s) + 14]) parts.push(new THREE.BoxGeometry(4, 3, width + 2).translate(s, y, 0));
  }
  const sag = (s: number) => {
    // The cable's height: a parabola between the towers, nearly down to the road at mid-span; straight-ish runs down to the anchors.
    if (s >= t0 && s <= t1) {
      const u = (s - B.main) / (B.mainSpan / 2);
      const low = deckHeight(B.main) + 4;
      return low + (tower - low) * u * u;
    }
    const end = s < t0 ? a0 : a1;
    const top = s < t0 ? t0 : t1;
    const u = (s - end) / (top - end);
    const low = deckHeight(end) + 1;
    return low + (tower - low) * (0.75 * u + 0.25 * u * u);
  };
  for (const z of [-width / 2 - 1, width / 2 + 1]) {
    for (let s = a0; s < a1 - 1; s += (a1 - a0) / 40) parts.push(beam(s, sag(s), s + (a1 - a0) / 40, sag(s + (a1 - a0) / 40), 1.4, 1.4, z));
  }
  // The eastern channel's through truss: a humped frame over the road.
  const e0 = B.east - 105;
  const top = (s: number) => deckHeight(s) + 8 + 22 * Math.max(0, 1 - ((s - B.east) / 105) ** 2);
  for (const z of [-width / 2, width / 2]) {
    for (let k = 0; k < 10; k++) {
      const s = e0 + k * 21;
      parts.push(beam(s, top(s), s + 21, top(s + 21), 1.6, 1.2, z)); // the top chord
      parts.push(beam(s, deckHeight(s), s, top(s), 1, 1, z)); // a post
      parts.push(k % 2 ? beam(s, top(s), s + 21, deckHeight(s + 21), 0.8, 0.8, z) : beam(s, deckHeight(s), s + 21, top(s + 21), 0.8, 0.8, z)); // a brace
    }
    parts.push(beam(e0 + 210, deckHeight(e0 + 210), e0 + 210, top(e0 + 210), 1, 1, z));
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
}

/** Where the road's lamps stand along one span (m along, m up): one every 80 m. GUESS */
export function roadLamps(): { s: number; y: number }[] {
  const out: { s: number; y: number }[] = [];
  for (let s = -BAY_BRIDGE.length / 2 + 40; s < BAY_BRIDGE.length / 2; s += 80) out.push({ s, y: deckHeight(s) + 9 });
  return out;
}

export class BayBridge {
  readonly root = new THREE.Group();
  private built = false;
  private lamps: THREE.PointsMaterial | null = null;
  private reds: THREE.PointsMaterial | null = null;
  /** True while it is in the scene (for tests and the page). */
  shown = false;

  constructor() {
    this.root.name = "bay-bridge";
    this.root.visible = false;
    // The bridge's own x runs along it: turned so that points along its true bearing (scene x east, z south).
    this.root.rotation.y = THREE.MathUtils.degToRad(90 - BAY_BRIDGE.bearing);
  }

  private build(): void {
    this.built = true;
    // Painted steel and concrete, seen grey through the haze. Darker than the paint really is: at 7 km a pale
    // bridge vanished into the sky (Elena, 14 Nov: the deck a thin grey line, the two main towers standing up
    // from it, still softened by haze, not darker than the far shore).
    const steel = new THREE.MeshStandardMaterial({ color: BRIDGE_GREY, roughness: 0.9, metalness: 0 });
    const lamp: number[] = [];
    const red: number[] = [];
    for (const sp of BAY_BRIDGE.spans) {
      const mesh = new THREE.Mesh(spanGeometry(sp.tower, sp.width), steel);
      mesh.position.z = sp.across;
      this.root.add(mesh);
      for (const l of roadLamps()) lamp.push(l.s, l.y, sp.across);
      // A red light on each tower top, to warn aircraft.
      for (const s of [BAY_BRIDGE.main - BAY_BRIDGE.mainSpan / 2, BAY_BRIDGE.main + BAY_BRIDGE.mainSpan / 2]) red.push(s, sp.tower + 2, sp.across);
    }
    const points = (xyz: number[], colour: number, size: number) => {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(xyz), 3));
      const mat = new THREE.PointsMaterial({ color: colour, size, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
      const p = new THREE.Points(geo, mat);
      p.renderOrder = 29;
      this.root.add(p);
      return mat;
    };
    this.lamps = points(lamp, 0xffc27a, 1.6);
    this.reds = points(red, 0xff3a28, 2.6);
  }

  /** Each frame, with the boat at (lat, lon): in place on the horizon, its lights on after dark. */
  update(lat: number, lon: number, sunEl: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const { x, z } = offsetOf(BAY_BRIDGE, lat, lon);
    const d = Math.hypot(x, z);
    this.shown = d < BRIDGE_RANGE;
    this.root.visible = this.shown;
    if (!this.shown) return;
    if (!this.built) this.build();
    this.root.position.set(x, -(d * d) / (2 * R_EARTH), z); // down with the earth's curve, as the land is
    const night = nightOf(sunEl);
    if (this.lamps) this.lamps.opacity = 0.85 * night;
    if (this.reds) this.reds.opacity = night;
  }

  dispose(): void {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = m.material;
      for (const x of mats ? (Array.isArray(mats) ? mats : [mats]) : []) x.dispose();
    });
    this.root.clear();
    this.built = false;
    this.shown = false;
  }
}
