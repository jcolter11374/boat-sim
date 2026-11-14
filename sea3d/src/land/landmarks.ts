// Landmarks seen from the water: single structures at their true spots (a lighthouse
// out on its shoal), loaded when the boat comes within sight and dropped once it's
// well past. Each is a Blender model (blender/build_landmarks.py), with a simple
// drawn-in-code stand-in when the build hasn't made it. A lighthouse's light flashes
// its real pattern after dark, in the colour its sector shows from where you are.
// Display only: the boat's physics never sees them.

import * as THREE from "three";
import { gltfLoader } from "../gltf";
import { reflectable } from "../mirror";
import { R_EARTH, metresPerDegree } from "./shader";
import { nightOf } from "./town";

/** A light's colour over a range of bearings, as the light list gives them: from the boat towards the light, degrees true. */
export interface Sector {
  colour: number;
  from: number;
  to: number;
}

/** A lighthouse's light. */
export interface Light {
  /** Seconds from one flash to the next... */
  period: number;
  /** ...and how long each flash lasts. */
  flash: number;
  /** Height above the water (m). */
  focal: number;
  /** Colour by bearing; white all round when empty. */
  sectors: Sector[];
  /** A group flashing light: this many flashes each period (one when not set)... */
  group?: number;
  /** ...this many seconds from one flash of the group to the next. */
  gap?: number;
}

export interface Landmark {
  key: string;
  name: string;
  lat: number;
  lon: number;
  /** The model's file name in ./models, without ".glb". */
  file: string;
  light?: Light;
  /** The ground it stands on, metres above the sea (a clifftop light); the light's focal height is above this. */
  base?: number;
  /** The drawn stand-in: "tower" for a masonry tower on land; the screwpile house when not set. */
  kind?: "tower";
  /** A major light seen from miles off: its glow is a sharp point with a small soft halo, not the near light's wide one. */
  far?: boolean;
}

export const WHITE = 0xfff6e6;
export const RED = 0xff3a28;

export const LANDMARKS: Landmark[] = [
  {
    // Thomas Point Shoal Light (1875), the screwpile lighthouse off Annapolis.
    // US Lighthouse Society light list: Fl WR 5s, 43 ft; red over 011-051.5 and 096.5-202 degrees.
    key: "thomaspoint",
    name: "Thomas Point Shoal Light",
    lat: 38.8989,
    lon: -76.4358,
    file: "landmark_thomaspoint",
    light: {
      period: 5,
      flash: 0.6, // GUESS: the list gives the period, not the flash's length
      focal: 13,
      sectors: [
        { colour: RED, from: 11, to: 51.5 },
        { colour: WHITE, from: 51.5, to: 96.5 },
        { colour: RED, from: 96.5, to: 202 },
        { colour: WHITE, from: 202, to: 371 }, // through north to 011
      ],
    },
  },
  {
    // Farol do Cabo da Roca (1772), on the cliff at the westernmost point of mainland Europe.
    // NGA List of Lights, as given on Wikipedia's "Cabo da Roca Lighthouse" page (read 14 Nov 2026):
    // Fl(4) W 18s, focal height 165 m, range 26 nautical miles, a 22 m square white tower with a red lantern.
    key: "cabodaroca",
    name: "Cabo da Roca lighthouse",
    lat: 38.782,
    lon: -9.4973,
    file: "landmark_cabodaroca",
    kind: "tower",
    base: 113, // where our land's heights put the ground under it (the real cliff top is about 143 m: our 19 m grid rounds the edge off)
    far: true,
    light: { period: 18, flash: 0.4, group: 4, gap: 2.5, focal: 22, sectors: [] }, // GUESS: the list gives neither the flash's length nor the spacing inside the group
  },
];

/** Load a landmark within this of the boat (km)... */
export const LANDMARK_KM = 16;
/** ...and drop it past this. */
export const LANDMARK_DROP_KM = 22;
/** The light's glow fades out over the last part of this (m): lost in the haze. */
export const LIGHT_RANGE = 25000;

/** Where a landmark sits with the boat at (lat, lon) at the origin: x metres east, z metres south. */
export function offsetOf(lm: Pick<Landmark, "lat" | "lon">, lat: number, lon: number): { x: number; z: number } {
  const { mx, my } = metresPerDegree((lat + lm.lat) / 2);
  return { x: (lm.lon - lon) * mx, z: -(lm.lat - lat) * my };
}

/** Bearing from the boat to the landmark, degrees true (0 north, 90 east). */
export function bearingTo(lm: Pick<Landmark, "lat" | "lon">, lat: number, lon: number): number {
  const { x, z } = offsetOf(lm, lat, lon);
  return ((THREE.MathUtils.radToDeg(Math.atan2(x, -z)) % 360) + 360) % 360;
}

/** The colour a light shows at a bearing towards it (null where it's hidden). */
export function sectorColour(light: Light, bearing: number): number | null {
  if (!light.sectors.length) return WHITE;
  const b = ((bearing % 360) + 360) % 360;
  for (const s of light.sectors) if ((b >= s.from && b < s.to) || (b + 360 >= s.from && b + 360 < s.to)) return s.colour;
  return null;
}

/** How bright the flash is at time t (0..1): on for `flash` seconds every `period`, with a quick rise and fall like a turning lens. */
export function flashAt(light: Pick<Light, "period" | "flash" | "group" | "gap">, t: number): number {
  let p = ((t % light.period) + light.period) % light.period;
  // A group flashing light: the flashes come close together, then the dark for the rest of the period.
  const n = light.group ?? 1;
  const gap = light.gap ?? light.flash * 2;
  if (n > 1) {
    const i = Math.min(n - 1, Math.floor(p / gap));
    p -= i * gap;
  }
  if (p >= light.flash) return 0;
  return Math.sin((Math.PI * p) / light.flash) ** 0.5;
}

/** Which landmarks to load and drop with the boat at (lat, lon). */
export function planLandmarks(all: Landmark[], loaded: Set<string>, lat: number, lon: number): { load: Landmark[]; drop: string[] } {
  const km = (lm: Landmark) => {
    const o = offsetOf(lm, lat, lon);
    return Math.hypot(o.x, o.z) / 1000;
  };
  return {
    load: all.filter((lm) => !loaded.has(lm.key) && km(lm) < LANDMARK_KM),
    drop: [...loaded].filter((k) => {
      const lm = all.find((l) => l.key === k);
      return !lm || km(lm) > LANDMARK_DROP_KM;
    }),
  };
}

let glowTex: THREE.Texture | null = null;
/** The soft round glow lights share (null where there's no page to draw it on). */
export const glowTexture = (): THREE.Texture | null => glow();
function glow(): THREE.Texture | null {
  if (glowTex) return glowTex;
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.1, "rgba(255,255,255,0.95)");
  r.addColorStop(0.3, "rgba(255,255,255,0.25)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  glowTex = new THREE.CanvasTexture(c);
  return glowTex;
}

/** A plain stand-in when the detailed model isn't built: legs, a white hexagonal house, a red roof, a black lantern. */
export function drawnLighthouse(focal: number): THREE.Group {
  const g = new THREE.Group();
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.8 });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, y: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.y = y;
    g.add(mesh);
    return mesh;
  };
  const pile = mat(0x4a3426);
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    const leg = add(new THREE.CylinderGeometry(0.17, 0.17, 5.8, 6), pile, 0.7);
    leg.position.x = 5.2 * Math.cos(a);
    leg.position.z = 5.2 * Math.sin(a);
  }
  add(new THREE.CylinderGeometry(5.7, 5.7, 0.3, 6), mat(0x6b6a66), 3.45);
  add(new THREE.CylinderGeometry(4.3, 4.3, 3.3, 6), mat(0xf2f0ea), 5.25);
  add(new THREE.CylinderGeometry(1.5, 4.85, 2.7, 6), mat(0x9e2b22), 8.25);
  add(new THREE.CylinderGeometry(1.3, 1.5, 2.0, 6), mat(0xf2f0ea), 10.6);
  add(new THREE.BoxGeometry(2.5, 2.4, 2.5), mat(0x1c1e20), focal - 0.2);
  const lamp = add(new THREE.CylinderGeometry(0.3, 0.3, 0.7, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff8e0 }), focal);
  lamp.name = "lamp";
  add(new THREE.ConeGeometry(1.35, 1.2, 8), mat(0x1c1e20), focal + 1.6);
  return g;
}

/** A plain stand-in for a masonry light on land: a square white tower with a red lantern, the keepers' low white house at its foot. */
export function drawnTower(focal: number): THREE.Group {
  const g = new THREE.Group();
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.85 });
  const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number) => {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, 0);
    g.add(mesh);
    return mesh;
  };
  const white = mat(0xf2f0ea);
  add(new THREE.BoxGeometry(34, 6, 12), white, 0, 3); // the house
  add(new THREE.BoxGeometry(35, 1.2, 13), mat(0xa8452f), 0, 6.6); // its tiled roof
  add(new THREE.BoxGeometry(6.5, focal - 2, 6.5), white, 0, (focal - 2) / 2); // the tower
  add(new THREE.BoxGeometry(8, 0.6, 8), mat(0x8f8b84), 0, focal - 2); // the gallery
  add(new THREE.CylinderGeometry(2.2, 2.2, 3.2, 10), mat(0xb5261e), 0, focal); // the red lantern
  const lamp = add(new THREE.CylinderGeometry(0.6, 0.6, 1.2, 12), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff8e0 }), 0, focal);
  lamp.name = "lamp";
  add(new THREE.ConeGeometry(2.4, 1.6, 10), mat(0xb5261e), 0, focal + 2.4);
  return g;
}

/** Inside this (m) a landmark is drawn clear of the haze: the sea's fog is tuned for the horizon,
 * and at 1-2 km it washed a white lighthouse into the sky (a clear day shows it plainly). */
export const CLEAR_M = 4000;

interface Shown {
  near?: boolean;
  lm: Landmark;
  group: THREE.Group;
  glow: THREE.Sprite | null;
  lamp: THREE.MeshStandardMaterial | null;
}

export class Landmarks {
  readonly root = new THREE.Group();
  private readonly shown = new Map<string, Shown>();
  private readonly loading = new Set<string>();
  private gone = false;

  constructor(
    private readonly base = "./models",
    private readonly all: Landmark[] = LANDMARKS,
  ) {
    this.root.name = "landmarks";
  }

  /** How many are in the scene. */
  get count(): number {
    return this.shown.size;
  }

  /** Each frame: load and drop around the boat at (lat, lon), keep each in place, and flash the lights after dark. */
  update(lat: number, lon: number, t: number, sunEl: number): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const p = planLandmarks(this.all, new Set([...this.shown.keys(), ...this.loading]), lat, lon);
    for (const k of p.drop) this.drop(k);
    for (const lm of p.load) void this.load(lm);
    const night = nightOf(sunEl);
    for (const s of this.shown.values()) {
      const { x, z } = offsetOf(s.lm, lat, lon);
      const d2 = x * x + z * z;
      s.group.position.set(x, (s.lm.base ?? 0) - d2 / (2 * R_EARTH), z); // down with the earth's curve, as the land is
      const near = d2 < CLEAR_M * CLEAR_M;
      if (s.near !== near) {
        s.near = near;
        s.group.traverse((o) => {
          const mats = (o as THREE.Mesh).material;
          for (const m of mats ? (Array.isArray(mats) ? mats : [mats]) : []) {
            if (m instanceof THREE.SpriteMaterial) continue; // the glow keeps its own rule
            (m as THREE.Material & { fog?: boolean }).fog = !near;
            m.needsUpdate = true;
          }
        });
      }
      const light = s.lm.light;
      if (!light) continue;
      const colour = sectorColour(light, bearingTo(s.lm, lat, lon));
      const on = colour === null ? 0 : flashAt(light, t);
      if (s.lamp) {
        s.lamp.emissive.setHex(colour ?? WHITE);
        s.lamp.emissiveIntensity = 0.15 + on * (1 + 5 * night);
      }
      if (s.glow) {
        const fade = 1 - THREE.MathUtils.smoothstep(Math.sqrt(d2), 0.6 * LIGHT_RANGE, LIGHT_RANGE);
        s.glow.material.color.setHex(colour ?? WHITE);
        s.glow.material.opacity = on * night * fade;
        s.glow.visible = s.glow.material.opacity > 0.002;
      }
    }
  }

  private async load(lm: Landmark): Promise<void> {
    this.loading.add(lm.key);
    let model: THREE.Group | null = null;
    for (const f of [`${lm.file}.glb`, `${lm.file}.json`]) {
      try {
        model = (await gltfLoader().loadAsync(`${this.base}/${f}`)).scene;
        break;
      } catch {
        // try the next one, then the drawn stand-in
      }
    }
    this.loading.delete(lm.key);
    if (this.gone) return;
    const group = new THREE.Group();
    group.name = `landmark-${lm.key}`;
    group.add(model ?? (lm.kind === "tower" ? drawnTower(lm.light?.focal ?? 20) : drawnLighthouse(lm.light?.focal ?? 13)));
    let lamp: THREE.MeshStandardMaterial | null = null;
    group.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (o.name === "lamp" && m instanceof THREE.MeshStandardMaterial) {
        lamp = m.clone();
        (o as THREE.Mesh).material = lamp;
      }
    });
    let sprite: THREE.Sprite | null = null;
    if (lm.light) {
      const mat = new THREE.SpriteMaterial({ map: glow(), color: WHITE, sizeAttenuation: false, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false, opacity: 0 });
      sprite = new THREE.Sprite(mat);
      sprite.position.set(0, lm.light.focal, 0);
      // Bigger than a yacht's masthead light (0.034), but at 0.09 the halo swamped the house and its tag.
      // A far light is a point (Elena: a few pixels across through the finish scene's long lens).
      sprite.scale.setScalar(lm.far ? 0.014 : 0.07);
      sprite.renderOrder = 30;
      sprite.visible = false;
      group.add(sprite);
    }
    reflectable(group);
    this.root.add(group);
    this.shown.set(lm.key, { lm, group, glow: sprite, lamp });
  }

  private drop(key: string): void {
    const s = this.shown.get(key);
    if (!s) return;
    this.root.remove(s.group);
    s.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
      for (const mat of mats) {
        for (const v of Object.values(mat)) if (v instanceof THREE.Texture && v !== glowTex) v.dispose();
        mat.dispose();
      }
    });
    this.shown.delete(key);
  }

  dispose(): void {
    this.gone = true;
    for (const k of [...this.shown.keys()]) this.drop(k);
  }
}
