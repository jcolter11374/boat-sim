// The real buoys and beacons off Annapolis (M5, Hana): the government marks a sailor on the
// practice course actually sees, at their charted spots, in their real colours and shapes, each
// flashing its own rhythm after dark. Drawn with the detailed channel-mark models (boats/buoys.ts;
// Elena, 14 Nov: this file's chart, that file's models, this file's lights). Display only:
// the boat's physics never sees them (she sails through one; real sailors keep clear).
//
// Colours (the US system): green marks have flat tops ("cans") and odd numbers, red marks have
// pointed tops ("nuns") and even numbers; coming in from the sea, red is kept on the right.
// Yellow is a special mark (here NOAA's weather buoy).
import * as THREE from "three";
import { R_EARTH } from "./shader";
import { Reflections, nightOf } from "./town";
import { flashAt, glowTexture, offsetOf } from "./landmarks";
import { BUOY_FIXED, BUOY_LIGHT_HEIGHT, makeBuoy, type BuoyKind } from "../boats/buoys";

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
/**
 * How each charted mark is drawn: with the detailed channel-mark models (boats/buoys.ts, rust, weed and
 * numbers), Elena's ruling of 14 Nov: this file keeps the chart (where, which, what rhythm), buoys.ts the
 * look. A "post" is a lighted daybeacon: a pile with its board.
 */
export function kindOf(m: Seamark): BuoyKind {
  if (m.shape === "can") return "can";
  if (m.shape === "nun") return "nun";
  if (m.shape === "post") return m.colour === "red" ? "daybeacon_red" : "daybeacon_green";
  return m.colour === "red" ? "lit_red" : m.colour === "green" ? "lit_green" : "lit_yellow";
}
/** Pile top on a daybeacon (buoys.ts): a lighted one carries its lamp on it. */
const PILE_TOP_M = 4.25;
/** The lamp's height above the water (m) for each kind: the lit buoys' own lantern (buoys.ts), a daybeacon's on its pile top. */
export function lampHeight(kind: BuoyKind): number {
  return BUOY_LIGHT_HEIGHT[kind] ?? PILE_TOP_M + 0.15;
}

const LAMP = { green: 0x35ff7a, red: 0xff3a28, yellow: 0xffd84a };

const cyl = (r0: number, r1: number, h: number, y: number, seg = 14) => new THREE.CylinderGeometry(r0, r1, h, seg).translate(0, y + h / 2, 0);

/** Brightness of a mark's light at t seconds (0 or 1): each starts its rhythm at its own moment, as real ones do. */
export function markFlash(m: Seamark, t: number): number {
  if (!m.period) return 0;
  const phase = ((m.lat * 7919 + m.lon * 104729) % 1) * m.period;
  return flashAt({ period: m.period, flash: Math.min(SEAMARK_FLASH, m.period * 0.35) }, t + Math.abs(phase));
}

/** The soft glow round a lit mark's lantern after dark (m across): a lantern's, not a lighthouse's (Elena, 14 Nov). */
export const SEAMARK_HALO_M = 1.6;
/** How bright its broken reflection on the water is against the town's lights (Elena: kept small). */
export const SEAMARK_REFLECT = 0.45;

interface Shown {
  m: Seamark;
  group: THREE.Group;
  glow: THREE.Sprite | null;
  halo: THREE.Sprite | null;
  reflect: Reflections | null;
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
    this.shown = this.all.map((m) => {
      const kind = kindOf(m);
      const group = new THREE.Group();
      group.name = `seamark-${m.key}`;
      const mark = makeBuoy(kind, m.key); // shared body and material; its own number plates
      // Each faces its own way, as moored marks swing and piles are driven: the number isn't always square on.
      mark.rotation.y = ((m.lat * 7919 + m.lon * 104729) % 1) * Math.PI * 2;
      group.add(mark);
      let lamp: THREE.MeshStandardMaterial | null = null;
      let glow: THREE.Sprite | null = null;
      let halo: THREE.Sprite | null = null;
      let reflect: Reflections | null = null;
      if (m.period) {
        const at = lampHeight(kind);
        // The lantern itself glows on its flash (over the model's own white lantern); the glow is seen from afar after dark.
        lamp = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: LAMP[m.colour], emissiveIntensity: 0.15 });
        group.add(new THREE.Mesh(cyl(0.12, 0.12, 0.3, at - 0.15, 8), lamp));
        const tex = glowTexture();
        if (tex) {
          glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: LAMP[m.colour], sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false, opacity: 0 }));
          glow.position.set(0, at, 0);
          glow.scale.setScalar(0.022); // a buoy's small lamp: a third of the lighthouse's glow
          glow.renderOrder = 30;
          glow.visible = false;
          group.add(glow);
          // Near to, a faint soft glow round the lantern, sized in metres so it stays a lantern's.
          halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: LAMP[m.colour], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, opacity: 0 }));
          halo.position.set(0, at, 0);
          halo.scale.setScalar(SEAMARK_HALO_M);
          halo.renderOrder = 29;
          halo.visible = false;
          group.add(halo);
        }
        // A short broken streak on the water under it, as the town's lights throw (town.ts), on with each flash.
        reflect = new Reflections([{ x: 0, z: 0, height: at, width: 0.12, color: new THREE.Color(LAMP[m.colour]) }]);
        reflect.mesh.name = "seamark-reflection";
        group.add(reflect.mesh);
      }
      group.visible = false;
      this.root.add(group);
      return { m, group, glow, halo, reflect, lamp };
    });
  }

  /**
   * Each frame, with the boat at (lat, lon): each mark in range at its spot, floating on the sea
   * (sea: the water's height at a scene spot, when the page has one), its light flashing after dark.
   */
  update(lat: number, lon: number, t: number, sunEl: number, sea?: (x: number, z: number) => number, hs = 0.3): void {
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
      const floats = !BUOY_FIXED.has(kindOf(s.m));
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
      if (s.halo) {
        s.halo.material.opacity = 0.35 * on * night;
        s.halo.visible = s.halo.material.opacity > 0.002;
      }
      s.reflect?.update(t, SEAMARK_REFLECT * on * night, hs);
    }
    this.count = n;
  }

  dispose(): void {
    for (const s of this.shown) {
      this.root.remove(s.group);
      s.group.traverse((o) => {
        // The marks' bodies share one geometry per kind and one material (buoys.ts): those stay for the next copy.
        if (o.name === "body") return;
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
