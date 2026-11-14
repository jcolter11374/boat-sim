// Town lights along a coast at night (M5, Hana; Elena: "a dark coast with no lights at all reads
// as empty"): a sparse scatter of small warm points where the villages are, standing on the real
// ground, and a faint glow over the one town big enough to light the haze. One draw call, built
// once the land's heights are known; nothing by day. Display only.
import * as THREE from "three";
import { R_EARTH, metresPerDegree } from "./shader";
import { nightOf } from "./town";

/** A village or town: its middle, how far its lights spread (m), how many we draw, and whether it glows. */
export interface LitTown {
  name: string;
  lat: number;
  lon: number;
  spread: number;
  lights: number;
  glow?: boolean;
}

/** The coast between Cabo da Roca and Cascais. GUESS: middles placed from memory of the map to a few hundred metres; the counts are for the look, not a census. */
export const LISBON_COAST: LitTown[] = [
  // The lighthouse's own buildings and the road end beside it: what a boat off the cape sees lit besides the light itself.
  { name: "Cabo da Roca", lat: 38.7815, lon: -9.4955, spread: 220, lights: 7 },
  { name: "Azoia", lat: 38.769, lon: -9.472, spread: 350, lights: 12 },
  { name: "Almocageme", lat: 38.797, lon: -9.468, spread: 450, lights: 14 },
  { name: "Colares", lat: 38.8, lon: -9.447, spread: 450, lights: 12 },
  { name: "Malveira da Serra", lat: 38.75, lon: -9.447, spread: 450, lights: 14 },
  { name: "Areia and Guincho", lat: 38.722, lon: -9.458, spread: 600, lights: 10 },
  { name: "Cascais", lat: 38.697, lon: -9.421, spread: 1400, lights: 70, glow: true },
];

/** The towns to light for a land-data place, by its key. */
export const LIT: Record<string, LitTown[]> = { lisbon: LISBON_COAST };

export interface HeightGrid {
  meta: { nx: number; ny: number; lon0: number; lon1: number; lat0: number; lat1: number };
  hgt: Int16Array;
}

/** The ground's height (m) at a spot, from the land's grid (row 0 north); null outside it. */
export function groundAt(g: HeightGrid, lat: number, lon: number): number | null {
  const { nx, ny, lon0, lon1, lat0, lat1 } = g.meta;
  const fx = (lon - lon0) / (lon1 - lon0);
  const fy = (lat1 - lat) / (lat1 - lat0);
  if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
  const ix = Math.min(nx - 1, Math.floor(fx * nx));
  const iy = Math.min(ny - 1, Math.floor(fy * ny));
  return g.hgt[iy * nx + ix];
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Where each light stands: lat, lon and metres above the sea. Only on land (a spot in the sea is tried again, then left out); the same every time. */
export function lightSpots(towns: LitTown[], g: HeightGrid): { lat: number; lon: number; y: number; town: number }[] {
  const out: { lat: number; lon: number; y: number; town: number }[] = [];
  const rnd = mulberry(20261114);
  towns.forEach((t, ti) => {
    const { mx, my } = metresPerDegree(t.lat);
    for (let i = 0; i < t.lights; i++) {
      for (let tries = 0; tries < 6; tries++) {
        // Thicker towards the middle.
        const r = t.spread * Math.sqrt(rnd()) * (0.4 + 0.6 * rnd());
        const a = rnd() * Math.PI * 2;
        const lat = t.lat + (r * Math.cos(a)) / my;
        const lon = t.lon + (r * Math.sin(a)) / mx;
        const h = groundAt(g, lat, lon);
        if (h !== null && h > 2) {
          out.push({ lat, lon, y: h + 5, town: ti }); // a street lamp or a window, above the ground
          break;
        }
      }
    }
  });
  return out;
}

export const LIGHT_WARM = 0xffc27a;

export class CoastLights {
  readonly root = new THREE.Group();
  private points: THREE.Points | null = null;
  private glows: { sprite: THREE.Sprite; lat: number; lon: number; y: number }[] = [];
  private spots: { lat: number; lon: number; y: number }[] = [];
  private key = "";
  /** How many lights are drawn (for tests). */
  count = 0;

  constructor() {
    this.root.name = "coast-lights";
  }

  /** Each frame: the lights for the land in view (`key`, with its heights), placed round the boat at (lat, lon); out by day. */
  update(key: string, grid: HeightGrid | null, lat: number, lon: number, sunEl: number, glowTex: THREE.Texture | null): void {
    if (key !== this.key) {
      this.clear();
      this.key = key;
      const towns = LIT[key];
      if (towns && grid) this.build(towns, grid, glowTex);
      else this.key = ""; // not ready: ask again next frame
    }
    const night = nightOf(sunEl);
    this.root.visible = !!this.points && night > 0.02;
    if (!this.points || !this.root.visible) return;
    const pos = this.points.geometry.getAttribute("position") as THREE.BufferAttribute;
    const { mx, my } = metresPerDegree(lat);
    const place = (s: { lat: number; lon: number; y: number }, v: THREE.Vector3) => {
      const x = (s.lon - lon) * mx;
      const z = -(s.lat - lat) * my;
      return v.set(x, s.y - (x * x + z * z) / (2 * R_EARTH), z); // down with the earth's curve, as the land is
    };
    const v = new THREE.Vector3();
    this.spots.forEach((s, i) => {
      place(s, v);
      pos.setXYZ(i, v.x, v.y, v.z);
    });
    pos.needsUpdate = true;
    this.points.geometry.computeBoundingSphere();
    (this.points.material as THREE.PointsMaterial).opacity = 0.9 * night;
    for (const g of this.glows) {
      place(g, g.sprite.position);
      g.sprite.material.opacity = 0.16 * night;
    }
  }

  private build(towns: LitTown[], grid: HeightGrid, glowTex: THREE.Texture | null): void {
    this.spots = lightSpots(towns, grid);
    this.count = this.spots.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.spots.length * 3), 3));
    const mat = new THREE.PointsMaterial({ color: LIGHT_WARM, size: 2.2, sizeAttenuation: false, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
    this.points = new THREE.Points(geo, mat);
    this.points.renderOrder = 29;
    this.root.add(this.points);
    for (const t of towns) {
      if (!t.glow || !glowTex) continue;
      const m = new THREE.SpriteMaterial({ map: glowTex, color: LIGHT_WARM, transparent: true, opacity: 0, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false, fog: false });
      const sprite = new THREE.Sprite(m);
      sprite.scale.set(t.spread * 5, t.spread * 1.6, 1); // a low, wide glow in the haze over the town
      sprite.renderOrder = 28;
      this.root.add(sprite);
      this.glows.push({ sprite, lat: t.lat, lon: t.lon, y: (groundAt(grid, t.lat, t.lon) ?? 0) + 120 });
    }
  }

  private clear(): void {
    if (this.points) {
      this.root.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = null;
    }
    for (const g of this.glows) {
      this.root.remove(g.sprite);
      g.sprite.material.dispose();
    }
    this.glows = [];
    this.spots = [];
    this.count = 0;
  }

  dispose(): void {
    this.clear();
  }
}
