// The real buoys and beacons off Annapolis (M5, Hana): the government marks a sailor on the
// practice course actually sees, at their charted spots, in their real colours and shapes, each
// flashing its own rhythm after dark. Drawn in code, a few hundred triangles each. Display only:
// the boat's physics never sees them (she sails through one; real sailors keep clear).
//
// Colours (the US system): green marks have flat tops ("cans") and odd numbers, red marks have
// pointed tops ("nuns") and even numbers; coming in from the sea, red is kept on the right.
// Yellow is a special mark (here NOAA's weather buoy).
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { R_EARTH } from "./shader";
import { nightOf } from "./town";
import { flashAt, glowTexture, offsetOf } from "./landmarks";

export type MarkShape = "can" | "nun" | "lit" | "post";

export interface Seamark {
  key: string;
  /** As the chart names it. */
  name: string;
  lat: number;
  lon: number;
  shape: MarkShape;
  colour: "green" | "red" | "yellow";
  /** Seconds between flashes, when it has a light. */
  period?: number;
}

/**
 * Positions and light rhythms: the government marks listed (with their Coast Guard names) on the
 * 2025 Annapolis racing marks sheet, files.firecrown.com/PDFs/2025-SWRS-Annapolis-Racing-Marks.pdf
 * (read 14 Nov 2026), given there to a hundredth of a minute (about 18 m). Buoys get moved and
 * renumbered; this is that sheet, not a chart to navigate by.
 */
export const SEAMARKS: Seamark[] = [
  { key: "AN", name: "NOAA Lighted Buoy AN", lat: 38.96367, lon: -76.44683, shape: "lit", colour: "yellow", period: 4 },
  { key: "5", name: "Severn River Lighted Buoy 5", lat: 38.97167, lon: -76.462, shape: "lit", colour: "green", period: 4 },
  { key: "14", name: "Severn River Buoy 14", lat: 38.98583, lon: -76.47783, shape: "nun", colour: "red" },
  { key: "1AH", name: "Severn River Light 1AH", lat: 38.93583, lon: -76.43617, shape: "post", colour: "green", period: 4 },
  { key: "2", name: "Severn River Lighted Buoy 2", lat: 38.94167, lon: -76.42467, shape: "lit", colour: "red", period: 2.5 },
  { key: "1", name: "Hackett Point Shoal Buoy 1", lat: 38.97, lon: -76.4145, shape: "can", colour: "green" },
  { key: "91", name: "Chesapeake Channel Lighted Buoy 91", lat: 38.98317, lon: -76.38517, shape: "lit", colour: "green", period: 4 },
  { key: "WR87", name: "Chesapeake Channel Lighted Buoy WR87", lat: 38.93283, lon: -76.3925, shape: "lit", colour: "green", period: 1 }, // "Q": a quick flash, about one a second
];

/** Shown within this of the boat (m): past it a 4 m buoy is under a pixel, and its light is lost in the haze. */
export const SEAMARK_RANGE = 9000;
/** How long each flash lasts (s). GUESS: the sheet gives the rhythm, not the flash's length. */
export const SEAMARK_FLASH = 0.4;
/** The lamp's height above the water (m) for each shape. GUESS from the usual sizes: a lighted buoy's lamp is about 4.5 m up, a small fixed light's about 5 m. */
export const LAMP_M: Record<MarkShape, number> = { can: 0, nun: 0, lit: 4.5, post: 5.2 };

const PAINT = { green: 0x1f7a4a, red: 0xc0392b, yellow: 0xe8c21a };
const LAMP = { green: 0x35ff7a, red: 0xff3a28, yellow: 0xffd84a };

const cyl = (r0: number, r1: number, h: number, y: number, seg = 14) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(0, y + h / 2, 0);

/** One mark's shape (m, the waterline at y = 0). Sizes are a GUESS from the usual ones: a can or nun stands about 1.8 m out of the water, a lighted buoy 4.5 m. */
export function markGeometry(shape: MarkShape): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  if (shape === "can") parts.push(cyl(0.5, 0.55, 2.4, -0.6));
  else if (shape === "nun") parts.push(cyl(0.5, 0.55, 1.5, -0.6), cyl(0.12, 0.5, 0.9, 0.9));
  else if (shape === "lit") {
    // A broad steel float, a four-legged tower on it, a ring for the radar reflector, the lamp on top.
    parts.push(cyl(1.15, 1.2, 1.5, -0.7, 20));
    for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const leg = new THREE.CylinderGeometry(0.05, 0.05, 3.5, 5);
      leg.rotateZ(sx * 0.15).rotateX(-sz * 0.15).translate(sx * 0.42, 2.5, sz * 0.42);
      parts.push(leg);
    }
    parts.push(new THREE.BoxGeometry(0.85, 0.9, 0.85).translate(0, 3.1, 0), cyl(0.22, 0.22, 0.25, 4.2, 8));
  } else {
    // A fixed light: one pile driven into the shoal, a small platform, a square board (green, numbered) each way.
    parts.push(cyl(0.3, 0.3, 6, -1.5, 10), new THREE.BoxGeometry(1.4, 0.12, 1.4).translate(0, 3.6, 0));
    parts.push(new THREE.BoxGeometry(1.2, 1.2, 0.06).translate(0, 4.3, 0.2), new THREE.BoxGeometry(0.06, 1.2, 1.2).translate(0.2, 4.3, 0));
  }
  return mergeGeometries(parts.map((p) => p.toNonIndexed()))!;
}

/** Brightness of a mark's light at t seconds (0 or 1): each starts its rhythm at its own moment, as real ones do. */
export function markFlash(m: Seamark, t: number): number {
  if (!m.period) return 0;
  const phase = ((m.lat * 7919 + m.lon * 104729) % 1) * m.period;
  return flashAt({ period: m.period, flash: Math.min(SEAMARK_FLASH, m.period * 0.35) }, t + Math.abs(phase));
}

interface Shown {
  m: Seamark;
  group: THREE.Group;
  glow: THREE.Sprite | null;
  lamp: THREE.MeshStandardMaterial | null;
}

export class Seamarks {
  readonly root = new THREE.Group();
  private shown: Shown[] = [];
  /** How many are in view (for tests and the page). */
  count = 0;

  constructor(private readonly all: Seamark[] = SEAMARKS) {
    this.root.name = "seamarks";
  }

  private build(): void {
    const geo = new Map<MarkShape, THREE.BufferGeometry>();
    const wet = new THREE.MeshStandardMaterial({ color: 0x1a2420, roughness: 0.4 });
    this.shown = this.all.map((m) => {
      if (!geo.has(m.shape)) geo.set(m.shape, markGeometry(m.shape));
      const group = new THREE.Group();
      group.name = `seamark-${m.key}`;
      const paint = new THREE.MeshStandardMaterial({ color: m.shape === "post" ? 0x6f6a60 : PAINT[m.colour], roughness: 0.7 });
      group.add(new THREE.Mesh(geo.get(m.shape)!, paint));
      if (m.shape === "post") {
        // The boards are the mark's colour; the pile is weathered wood.
        const board = new THREE.MeshStandardMaterial({ color: PAINT[m.colour], roughness: 0.7 });
        group.add(new THREE.Mesh(new THREE.BoxGeometry(1.22, 1.22, 0.08).translate(0, 4.3, 0.2), board), new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.22, 1.22).translate(0.2, 4.3, 0), board));
      } else {
        // Weed and wet at the waterline.
        const r = m.shape === "lit" ? 1.22 : 0.57;
        group.add(new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.3, 16, 1, true).translate(0, 0.05, 0), wet));
      }
      let lamp: THREE.MeshStandardMaterial | null = null;
      let glow: THREE.Sprite | null = null;
      if (m.period) {
        lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: LAMP[m.colour], emissiveIntensity: 0.15 });
        group.add(new THREE.Mesh(cyl(0.12, 0.12, 0.3, LAMP_M[m.shape] - 0.15, 8), lamp));
        const tex = glowTexture();
        if (tex) {
          glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: LAMP[m.colour], sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false, opacity: 0 }));
          glow.position.set(0, LAMP_M[m.shape], 0);
          glow.scale.setScalar(0.022); // a buoy's small lamp: a third of the lighthouse's glow
          glow.renderOrder = 30;
          glow.visible = false;
          group.add(glow);
        }
      }
      group.visible = false;
      this.root.add(group);
      return { m, group, glow, lamp };
    });
  }

  /**
   * Each frame, with the boat at (lat, lon): each mark in range at its spot, floating on the sea
   * (sea: the water's height at a scene spot, when the page has one), its light flashing after dark.
   */
  update(lat: number, lon: number, t: number, sunEl: number, sea?: (x: number, z: number) => number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    // Nothing is built until the boat is near a mark (most pages never are).
    if (!this.shown.length) {
      const near = this.all.some((m) => {
        const o = offsetOf(m, lat, lon);
        return Math.hypot(o.x, o.z) < SEAMARK_RANGE;
      });
      if (!near) return;
      this.build();
    }
    const night = nightOf(sunEl);
    let n = 0;
    for (const s of this.shown) {
      const { x, z } = offsetOf(s.m, lat, lon);
      const d = Math.hypot(x, z);
      s.group.visible = d < SEAMARK_RANGE;
      if (!s.group.visible) continue;
      n++;
      const floats = s.m.shape !== "post";
      const h = floats && sea && d < 1500 ? sea(x, z) : 0;
      s.group.position.set(x, h - (d * d) / (2 * R_EARTH), z);
      if (floats && sea && d < 600) {
        // Lying with the water's slope, as a float does.
        const e = 1;
        s.group.rotation.set(-Math.atan((sea(x, z + e) - sea(x, z - e)) / (2 * e)), 0, Math.atan((sea(x + e, z) - sea(x - e, z)) / (2 * e)));
      } else s.group.rotation.set(0, 0, 0);
      const on = markFlash(s.m, t);
      if (s.lamp) s.lamp.emissiveIntensity = 0.15 + on * (1 + 5 * night);
      if (s.glow) {
        const fade = 1 - THREE.MathUtils.smoothstep(d, 0.6 * SEAMARK_RANGE, SEAMARK_RANGE);
        s.glow.material.opacity = on * night * fade;
        s.glow.visible = s.glow.material.opacity > 0.002;
      }
    }
    this.count = n;
  }

  dispose(): void {
    for (const s of this.shown) {
      this.root.remove(s.group);
      s.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mats = mesh.material;
        for (const m of mats ? (Array.isArray(mats) ? mats : [mats]) : []) m.dispose();
      });
    }
    this.shown = [];
    this.count = 0;
  }
}
