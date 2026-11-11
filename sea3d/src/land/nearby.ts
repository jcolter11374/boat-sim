// Real land near a moving boat (the helm page): when the boat comes within range of
// one of the land-data places (Bay mouth, Annapolis, Pico and Faial, Lisbon), its
// ground, surf, town and trees are loaded and kept in their true place as the boat
// sails by; they're dropped again once it's well clear. The boat stays at the
// scene's origin, so the land's group moves instead.

import * as THREE from "three";
import type { Quality } from "../boats/parts";
import { reflectable } from "../mirror";
import { Island, type LandGrid } from "./island";
import { PLACES, type Place } from "./place";
import { metresPerDegree } from "./shader";
import { Town } from "./town";
import { Trees } from "./trees";

/** Load a place's land once the boat is this close to its box (km)... */
export const LOAD_KM = 50;
/** ...and drop it again past this (a margin, so it doesn't flicker at the edge). */
export const DROP_KM = 70;
/** The town and trees only matter close in: within this of the place's own spot (km). */
export const DETAIL_KM = 10;
/** How far the view reaches with land about (m), as on the voyage page's places. */
export const LAND_HORIZON = 60000;

/** A land-data place and the box its files cover. */
export interface Tile {
  place: Place;
  lat0: number;
  lat1: number;
  lon0: number;
  lon1: number;
}

/** The places that have their own land files (one per set of files: Horta shares Pico's). */
export function landPlaces(places: Record<string, Place> = PLACES): Place[] {
  const by = new Map<string, Place>();
  for (const p of Object.values(places)) {
    const name = p.land ?? p.key;
    // Prefer the place the files are named after; otherwise the first that uses them.
    if (!by.has(name) || p.key === name) by.set(name, p);
  }
  return [...by.values()];
}

/** Kilometres from (lat, lon) to the nearest point of a tile's box (0 inside it). */
export function kmToBox(t: Pick<Tile, "lat0" | "lat1" | "lon0" | "lon1">, lat: number, lon: number): number {
  const la = THREE.MathUtils.clamp(lat, t.lat0, t.lat1);
  const lo = THREE.MathUtils.clamp(lon, t.lon0, t.lon1);
  const { mx, my } = metresPerDegree((lat + la) / 2);
  return Math.hypot((lo - lon) * mx, (la - lat) * my) / 1000;
}

/** The tile nearest the boat and how far off it is, or null with none known. */
export function nearestTile(tiles: Tile[], lat: number, lon: number): { tile: Tile; km: number } | null {
  let best: { tile: Tile; km: number } | null = null;
  for (const tile of tiles) {
    const km = kmToBox(tile, lat, lon);
    if (!best || km < best.km) best = { tile, km };
  }
  return best;
}

/**
 * Where a place's frame sits in the scene with the boat at the origin: x metres east,
 * z metres south. `mid` is the latitude the land's own grid was laid out at.
 */
export function placeOffset(place: Place, lat: number, lon: number, mid = place.lat): { x: number; z: number } {
  const { mx, my } = metresPerDegree(mid);
  return { x: (place.lon - lon) * mx, z: -(place.lat - lat) * my };
}

/** Free everything a loaded layer holds on the graphics card. */
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

interface Loaded {
  tile: Tile;
  island: Island;
  town: Town | null;
  trees: Trees | null;
  /** The town and trees: not asked for yet, on their way, or done. */
  detail: "no" | "loading" | "done";
}

export class NearbyLand {
  /** Moved each frame so the land stays put as the boat sails. */
  readonly root = new THREE.Group();
  /** What's loaded (for tests and the page): the place's key, its distance (km), the town and trees. */
  readonly shown = { place: "", km: Infinity, buildings: 0, trees: 0 };
  private tiles: Tile[] = [];
  private now: Loaded | null = null;
  private loading = false;
  private gone = false;

  private constructor(
    private readonly quality: Quality,
    private readonly base: string,
  ) {
    this.root.name = "nearby-land";
  }

  /** Learn where the land files reach (their small meta files); none published means no land. */
  static async create(quality: Quality, base = "./land"): Promise<NearbyLand> {
    const n = new NearbyLand(quality, base);
    const found = await Promise.all(
      landPlaces().map(async (place) => {
        try {
          const r = await fetch(`${base}/${place.land ?? place.key}_meta.json`);
          if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
          const m = (await r.json()) as LandGrid;
          return [m.lat0, m.lat1, m.lon0, m.lon1].every(Number.isFinite) ? { place, lat0: m.lat0, lat1: m.lat1, lon0: m.lon0, lon1: m.lon1 } : null;
        } catch {
          return null;
        }
      }),
    );
    n.tiles = found.filter((t): t is Tile => t !== null);
    return n;
  }

  /** How many places' land this copy of the site has. */
  get known(): number {
    return this.tiles.length;
  }

  /** True when land is in the scene (the view should reach out to LAND_HORIZON). */
  get active(): boolean {
    return this.now !== null;
  }

  /**
   * Each frame, with the boat at (lat, lon): load or drop land, keep it in place, and
   * run its own animation (light, surf, windows, swaying trees).
   */
  update(lat: number, lon: number, t: number, a: { haze: THREE.Color; light: number; sunEl: number; hs: number; storm: number; wu: number; wv: number }): void {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const near = nearestTile(this.tiles, lat, lon);
    const cur = this.now;
    if (cur) {
      const km = kmToBox(cur.tile, lat, lon);
      this.shown.km = km;
      if (km > DROP_KM || (near && near.tile !== cur.tile && near.km < LOAD_KM && near.km < km)) this.drop();
    }
    if (!this.now && !this.loading && near && near.km < LOAD_KM) void this.load(near.tile);
    const l = this.now;
    if (!l) return;
    const { place } = l.tile;
    const o = placeOffset(place, lat, lon, (l.tile.lat0 + l.tile.lat1) / 2);
    this.root.position.set(o.x, 0, o.z);
    if (l.detail === "no" && Math.hypot(o.x, o.z) < DETAIL_KM * 1000) void this.loadDetail(l);
    l.island.update(t, a.haze, a.light, a.hs, a.storm);
    l.town?.update(t, a.sunEl, a.hs, a.wu, a.wv);
    l.trees?.update(t, Math.hypot(a.wu, a.wv), a.haze, a.storm);
  }

  private async load(tile: Tile): Promise<void> {
    this.loading = true;
    const island = await Island.load(tile.place, this.quality, this.base).catch(() => null);
    this.loading = false;
    if (this.gone) return;
    if (!island) {
      // The meta is there but the rest isn't: don't keep asking for it.
      this.tiles = this.tiles.filter((t) => t !== tile);
      return;
    }
    this.root.add(island.group);
    const ground = island.group.getObjectByName("island");
    if (ground) reflectable(ground);
    this.now = { tile, island, town: null, trees: null, detail: "no" };
    this.shown.place = tile.place.key;
  }

  /** The town and trees, once the boat is close enough to see them. */
  private async loadDetail(l: Loaded): Promise<void> {
    l.detail = "loading";
    const town = await Town.load(l.tile.place, this.quality, this.base).catch(() => null);
    const trees = l.island.grid
      ? await Trees.load(l.tile.place, this.quality, l.island.grid, town ? (x, z) => town.blocked(x, z) : undefined, this.base).catch(() => null)
      : null;
    l.detail = "done";
    if (this.now !== l) {
      for (const x of [town, trees]) if (x) release(x.group);
      return;
    }
    if (town) {
      l.town = town;
      this.root.add(town.group);
      town.mirrored();
      this.shown.buildings = town.shown.buildings;
    }
    if (trees) {
      l.trees = trees;
      this.root.add(trees.group);
      reflectable(trees.group);
      this.shown.trees = trees.count;
    }
  }

  private drop(): void {
    const l = this.now;
    if (!l) return;
    for (const g of [l.island.group, l.town?.group, l.trees?.group]) {
      if (!g) continue;
      this.root.remove(g);
      release(g);
    }
    this.now = null;
    Object.assign(this.shown, { place: "", km: Infinity, buildings: 0, trees: 0 });
  }

  dispose(): void {
    this.gone = true;
    this.drop();
  }
}
