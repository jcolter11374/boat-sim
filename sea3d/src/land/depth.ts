// How deep the water is, from the Bay's coast squares (landtiles.py: NOAA CUDEM topobathy,
// decimetres, sea floor below 0). For practice sailing only (Rosa; Maya's conditions,
// 12 Nov): this is display data, never the voyage simulator's, so it never feeds a
// voyage, the odds or the leaderboard. Where a square hasn't loaded the depth is unknown
// (null) and nobody runs aground on it.

import type { LandGrid } from "./island";
import type { Square } from "./squares";

export interface DepthGrid {
  meta: Pick<LandGrid, "nx" | "ny" | "lon0" | "lon1" | "lat0" | "lat1" | "scale">;
  hgt: Int16Array;
}

/** Height (m, + above the water, - depth) at (lat, lon), blended from the four nearest points; null outside the grid. */
export function sampleGrid(g: DepthGrid, lat: number, lon: number): number | null {
  const { nx, ny, lon0, lon1, lat0, lat1 } = g.meta;
  if (lon < lon0 || lon > lon1 || lat < lat0 || lat > lat1) return null;
  const fx = ((lon - lon0) / (lon1 - lon0)) * (nx - 1);
  const fy = ((lat1 - lat) / (lat1 - lat0)) * (ny - 1); // row 0 north
  const i = Math.min(Math.floor(fx), nx - 2);
  const j = Math.min(Math.floor(fy), ny - 2);
  const a = fx - i;
  const b = fy - j;
  const at = (ii: number, jj: number) => g.hgt[jj * nx + ii];
  const h = (at(i, j) * (1 - a) + at(i + 1, j) * a) * (1 - b) + (at(i, j + 1) * (1 - a) + at(i + 1, j + 1) * a) * b;
  return h * (g.meta.scale ?? 1);
}

/**
 * What the depth means for a boat drawing `draftM`. The data is a survey model, not a
 * chart, and the tide isn't in it, so (Maya) we use a margin and say "shallow water",
 * never a precise grounding:
 * - "aground": GUESS: under draft - 0.4 m in the data, so a near miss isn't called;
 * - "shallow": under draft + 1 m: a warning to steer for deeper water;
 * - "unknown": no depth loaded here: no warning and no grounding.
 */
export type DepthState = "unknown" | "deep" | "shallow" | "aground";
export const AGROUND_MARGIN_M = 0.4;
export const SHALLOW_MARGIN_M = 1.0;
export function depthState(height: number | null, draftM: number): DepthState {
  if (height == null || !Number.isFinite(height)) return "unknown";
  const depth = -height;
  if (depth < draftM - AGROUND_MARGIN_M) return "aground";
  if (depth < draftM + SHALLOW_MARGIN_M) return "shallow";
  return "deep";
}

/** The Bay's depths around the boat: the squares' height files, fetched as the boat comes near. */
export class BayDepths {
  private squares: Square[] = [];
  private grids = new Map<string, DepthGrid | "loading" | "none">();

  private constructor(private readonly base: string) {}

  /** Read the squares' index; none published means no depths (everything stays "unknown"). */
  static async create(base = "./land"): Promise<BayDepths> {
    const d = new BayDepths(base);
    try {
      const r = await fetch(`${base}/bay_index.json`);
      if (r.ok && !(r.headers.get("content-type") ?? "").includes("text/html")) {
        const j = (await r.json()) as { tiles?: Square[] };
        d.squares = (j.tiles ?? []).filter((s) => typeof s.key === "string" && s.box?.length === 4 && s.box.every(Number.isFinite));
      }
    } catch {
      d.squares = [];
    }
    return d;
  }

  /** True when this copy of the site has the Bay's squares at all. */
  get known(): boolean {
    return this.squares.length > 0;
  }

  /** True when (lat, lon) is inside a published square. */
  covers(lat: number, lon: number): boolean {
    return this.squareAt(lat, lon) !== null;
  }

  /** Height (m, - is depth) at (lat, lon), or null while its square loads or where there is none. */
  at(lat: number, lon: number): number | null {
    const sq = this.squareAt(lat, lon);
    if (!sq) return null;
    const g = this.grids.get(sq.key);
    if (g === undefined) {
      void this.load(sq);
      return null;
    }
    return typeof g === "string" ? null : sampleGrid(g, lat, lon);
  }

  /** Start loading the squares within `m` metres of (lat, lon), so the depth is known before the boat gets there. */
  prefetch(lat: number, lon: number, m = 1500): void {
    const dlat = m / 111_320;
    const dlon = m / (111_320 * Math.cos((lat * Math.PI) / 180));
    for (const sq of this.squares) {
      const [lon0, lon1, lat0, lat1] = sq.box;
      if (lon1 >= lon - dlon && lon0 <= lon + dlon && lat1 >= lat - dlat && lat0 <= lat + dlat && !this.grids.has(sq.key)) void this.load(sq);
    }
  }

  private squareAt(lat: number, lon: number): Square | null {
    for (const sq of this.squares) {
      const [lon0, lon1, lat0, lat1] = sq.box;
      if (lon >= lon0 && lon <= lon1 && lat >= lat0 && lat <= lat1) return sq;
    }
    return null;
  }

  private async load(sq: Square): Promise<void> {
    this.grids.set(sq.key, "loading");
    try {
      const get = async (f: string) => {
        const r = await fetch(`${this.base}/bay_${sq.key}_${f}`);
        if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) throw new Error(f);
        return r;
      };
      const meta = (await (await get("meta.json")).json()) as LandGrid;
      if (!meta.depths) throw new Error("no sea floor in this square");
      const hgt = new Int16Array(await (await get("height.bin")).arrayBuffer());
      if (hgt.length !== meta.nx * meta.ny) throw new Error("height size");
      this.grids.set(sq.key, { meta, hgt });
    } catch {
      this.grids.set(sq.key, "none");
    }
  }
}
