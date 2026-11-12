// The Chesapeake Bay as coast squares (landtiles.py: bay_index.json and bay_<key>_*):
// the first real coastline. The squares near the boat are loaded as it sails and
// dropped behind it. Each is an Island laid out at one shared latitude, so
// neighbours meet without a seam. Where a land-data place with its own finer
// ground is loaded (Annapolis), the squares leave a hole for it.
// Display only: the boat's physics never sees the land.

import * as THREE from "three";
import type { Quality } from "../boats/parts";
import { reflectable } from "../mirror";
import { Island } from "./island";
import type { Place } from "./place";
import { metresPerDegree } from "./shader";
import { Trees, type TreeOptions } from "./trees";

/** Load the squares within this of the boat (km)... */
export const SQUARE_KM = 9;
/** ...and drop them past this. */
export const SQUARE_DROP_KM = 13;
/** At most this many loading at once, so a first look doesn't stall the page. */
const AT_ONCE = 2;

/**
 * Trees on a square: evenly over the whole square (its frame is centred on the
 * square, not the boat, so no thinning with distance), and fewer than a place
 * draws, as several squares are in at once.
 */
export const SQUARE_TREES: Record<Quality, Partial<TreeOptions>> = {
  high: { radius: 4000, near: 4000, max: 14000 },
  low: { radius: 4000, near: 4000, max: 4500 },
};

export const SQUARE_CREDIT = "Land: NOAA CUDEM; contains modified Copernicus Sentinel data 2023-24";

export interface Square {
  key: string;
  box: [number, number, number, number]; // lon0, lon1, lat0, lat1
  kind: "shore" | "sea" | "land";
}

/** A box a finer place covers, in degrees. */
export interface Hole {
  lon0: number;
  lon1: number;
  lat0: number;
  lat1: number;
}

/** Kilometres from (lat, lon) to the nearest point of a square (0 inside). */
export function kmToSquare(sq: Square, lat: number, lon: number): number {
  const [lon0, lon1, lat0, lat1] = sq.box;
  const la = Math.min(Math.max(lat, lat0), lat1);
  const lo = Math.min(Math.max(lon, lon0), lon1);
  const { mx, my } = metresPerDegree((lat + la) / 2);
  return Math.hypot((lo - lon) * mx, (la - lat) * my) / 1000;
}

/** True when the square lies wholly inside the hole: nothing of it would be drawn. */
export function inside(sq: Square, h: Hole | null): boolean {
  if (!h) return false;
  const [lon0, lon1, lat0, lat1] = sq.box;
  return lon0 >= h.lon0 && lon1 <= h.lon1 && lat0 >= h.lat0 && lat1 <= h.lat1;
}

/** What to load and drop with the boat at (lat, lon). Open water ("sea": under 2% land) is left out: nothing to see yet. */
export function plan(all: Square[], loaded: Set<string>, lat: number, lon: number, hole: Hole | null): { load: Square[]; drop: string[] } {
  const shown = (s: Square, km: number) => s.kind !== "sea" && !inside(s, hole) && kmToSquare(s, lat, lon) < km;
  const want = all.filter((s) => shown(s, SQUARE_KM));
  const keep = new Set(all.filter((s) => shown(s, SQUARE_DROP_KM)).map((s) => s.key));
  const load = want.filter((s) => !loaded.has(s.key)).sort((a, b) => kmToSquare(a, lat, lon) - kmToSquare(b, lat, lon));
  return { load, drop: [...loaded].filter((k) => !keep.has(k)) };
}

/** A square as a Place for Island: its frame's origin at the middle of the square. */
export function squarePlace(sq: Square): Place {
  const [lon0, lon1, lat0, lat1] = sq.box;
  return {
    key: `bay_${sq.key}`,
    name: "Chesapeake Bay",
    lat: (lat0 + lat1) / 2,
    lon: (lon0 + lon1) / 2,
    look: 0,
    credit: SQUARE_CREDIT,
    shore: "plain",
    fetch: 10000, // a sheltered bay: a short wash at the shore, not ocean surf
  };
}

const sameHole = (a: Hole | null, b: Hole | null) =>
  a === b || (!!a && !!b && a.lon0 === b.lon0 && a.lon1 === b.lon1 && a.lat0 === b.lat0 && a.lat1 === b.lat1);

export class CoastSquares {
  readonly root = new THREE.Group();
  private all: Square[] = [];
  /** One latitude for every square's layout (the middle of them all). */
  private mid = 0;
  private loaded = new Map<string, { sq: Square; island: Island; trees: Trees | null }>();
  private loading = new Set<string>();
  private hole: Hole | null = null;
  private gone = false;

  private constructor(
    private readonly quality: Quality,
    private readonly base: string,
  ) {
    this.root.name = "coast-squares";
  }

  /** Read the squares' index; none published means no squares. */
  static async create(quality: Quality, base = "./land"): Promise<CoastSquares> {
    const c = new CoastSquares(quality, base);
    try {
      const r = await fetch(`${base}/bay_index.json`);
      if (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")) {
        const j = (await r.json()) as { tiles?: Square[] };
        c.all = (j.tiles ?? []).filter((s) => typeof s.key === "string" && s.box?.length === 4 && s.box.every(Number.isFinite));
      }
    } catch {
      c.all = [];
    }
    if (c.all.length) {
      const lats = c.all.flatMap((s) => [s.box[2], s.box[3]]);
      c.mid = (Math.min(...lats) + Math.max(...lats)) / 2;
    }
    return c;
  }

  get known(): number {
    return this.all.length;
  }

  /** How many squares are in the scene. */
  get count(): number {
    return this.loaded.size;
  }

  /**
   * Each frame: load and drop squares around the boat, keep them in place, run
   * their light and surf. hole: the box of a finer place now loaded, or null.
   */
  update(lat: number, lon: number, hole: Hole | null, t: number, a: { haze: THREE.Color; light: number; hs: number; storm: number; wu: number; wv: number }): void {
    if (!this.all.length || !Number.isFinite(lat) || !Number.isFinite(lon)) return;
    if (!sameHole(hole, this.hole)) {
      // A finer place came or went: lay the squares out again around it.
      this.hole = hole ? { ...hole } : null;
      for (const k of [...this.loaded.keys()]) this.drop(k);
    }
    const p = plan(this.all, new Set([...this.loaded.keys(), ...this.loading]), lat, lon, this.hole);
    for (const k of p.drop) this.drop(k);
    for (const sq of p.load) {
      if (this.loading.size >= AT_ONCE) break;
      void this.load(sq);
    }
    const { mx, my } = metresPerDegree(this.mid);
    const wind = Math.hypot(a.wu, a.wv);
    for (const { sq, island, trees } of this.loaded.values()) {
      const pl = squarePlace(sq);
      island.group.position.set((pl.lon - lon) * mx, 0, -(pl.lat - lat) * my);
      island.update(t, a.haze, a.light, a.hs, a.storm);
      trees?.update(t, wind, a.haze, a.storm);
    }
  }

  private async load(sq: Square): Promise<void> {
    this.loading.add(sq.key);
    const h = this.hole;
    const skip = h ? (lo: number, la: number) => lo >= h.lon0 && lo <= h.lon1 && la >= h.lat0 && la <= h.lat1 : undefined;
    const place = squarePlace(sq);
    const island = await Island.load(place, this.quality, this.base, { mid: this.mid, skip }).catch(() => null);
    // Trees where the square has a cover mask (land squares), none where the finer place grows its own.
    const { mx, my } = metresPerDegree(this.mid);
    const blocked = skip ? (x: number, z: number) => skip(place.lon + x / mx, place.lat - z / my) : undefined;
    const trees =
      island?.grid && !this.gone
        ? await Trees.load(place, this.quality, island.grid, blocked, this.base, { mid: this.mid, options: SQUARE_TREES[this.quality] }).catch(() => null)
        : null;
    this.loading.delete(sq.key);
    if (this.gone || !island || !sameHole(h, this.hole)) {
      if (island) release(island.group);
      if (trees) release(trees.group);
      if (!island) this.all = this.all.filter((s) => s !== sq); // its files aren't there: stop asking
      return;
    }
    this.root.add(island.group);
    const ground = island.group.getObjectByName("island");
    if (ground) reflectable(ground);
    if (trees) {
      island.group.add(trees.group); // moves with its square
      reflectable(trees.group);
    }
    this.loaded.set(sq.key, { sq, island, trees });
  }

  private drop(key: string): void {
    const l = this.loaded.get(key);
    if (!l) return;
    this.root.remove(l.island.group);
    release(l.island.group);
    this.loaded.delete(key);
  }

  dispose(): void {
    this.gone = true;
    for (const k of [...this.loaded.keys()]) this.drop(k);
  }
}

function release(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    m.geometry?.dispose();
    const mats = m.material ? (Array.isArray(m.material) ? m.material : [m.material]) : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
    if (x instanceof THREE.InstancedMesh) x.dispose();
  });
}
