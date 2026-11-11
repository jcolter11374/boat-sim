// Real wave systems for the 3D sea: ERA5's wind sea and first two swells,
// baked by Priya's "Sea state data" workflow (src/boatsim/oceandata/seastate.py)
// into public/seastate/. Display only: the simulator never reads these.
//
// Files: seastate_index.json lists the months; per month a JSON header and a
// gzipped int16 block [time][field][lat][lon] (lat south->north, lon
// west->east, value = int x scale, -32768 = no data). 1 degree, every 3 hours.

import type { WaveSystem } from "./waves";

/** ERA5 gives each system's MEAN period (Tm01); the 3D sea is set by the PEAK
 *  period. Tp = factor x Tm01, from ERA5 itself: where one system holds over
 *  85% of the wave energy, ERA5's peak period over that system's Tm01 has
 *  median 1.36 for the wind sea (middle half 1.30-1.49, 1.8k points) and 1.14
 *  for swell (1.11-1.19, 9.8k), June 2020 over the corridor
 *  (`python -m boatsim.oceandata.tpfactor --era5`). The second swell rarely
 *  holds the peak, so it takes the first swell's factor.
 *
 *  Checked against NOAA NDBC buoys (8 buoys, April-November 2020, each hourly
 *  spectrum split into systems the way ERA5 splits them; workflow "Check Tp
 *  from Tm01 on buoys"): real swell gives 1.09, close to ERA5's 1.14, but the
 *  buoys' wind sea gives 1.10, not 1.36. ERA5's wind-sea mean periods run short
 *  next to its own peaks; we draw ERA5's sea, so we use ERA5's ratio and the
 *  drawn wind sea peaks where ERA5's does. */
export const TP_PER_TM01 = { windSea: 1.35, swell1: 1.14, swell2: 1.14 };

export const FILL = -32768;
const SYSTEMS = ["ws", "s1", "s2"] as const;
type Sys = (typeof SYSTEMS)[number];

export interface SeaStateHeader {
  month: string;
  t0: string; // ISO, UTC
  step_h: number;
  nt: number;
  lat0: number;
  lon0: number;
  res: number;
  nlat: number;
  nlon: number;
  fields: { name: string; scale: number }[];
}

/** The three systems at one time and place; null where a system is absent. */
export interface Systems {
  ws: WaveSystem | null;
  s1: WaveSystem | null;
  s2: WaveSystem | null;
}

/** Below this a system isn't drawn (m). */
const MIN_HS = 0.02;

/** gzip bytes -> raw bytes. Servers may already have unpacked it (a .gz served
 *  with Content-Encoding), so plain bytes pass through. */
export async function gunzip(buf: ArrayBuffer): Promise<ArrayBuffer> {
  const b = new Uint8Array(buf);
  if (b.length < 2 || b[0] !== 0x1f || b[1] !== 0x8b) return buf;
  const stream = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** One month of wave systems. */
export class SeaStateMonth {
  readonly t0: number; // ms
  private readonly idx: Record<string, number>;
  private readonly scale: number[];
  private readonly nf: number;

  constructor(
    readonly h: SeaStateHeader,
    private readonly data: Int16Array,
  ) {
    this.t0 = Date.parse(h.t0);
    this.nf = h.fields.length;
    this.idx = Object.fromEntries(h.fields.map((f, i) => [f.name, i]));
    this.scale = h.fields.map((f) => f.scale);
    const want = h.nt * this.nf * h.nlat * h.nlon;
    if (data.length !== want) throw new Error(`sea state ${h.month}: ${data.length} values, expected ${want}`);
  }

  /** Does this month cover the time (ms)? Holds the last step to the month's end. */
  covers(tMs: number): boolean {
    const k = (tMs - this.t0) / 3.6e6 / this.h.step_h;
    return k >= 0 && k < this.h.nt;
  }

  private raw(k: number, f: number, i: number, j: number): number {
    const h = this.h;
    return this.data[((k * this.nf + f) * h.nlat + i) * h.nlon + j];
  }

  /** The systems at a time (ms) and place: linear in time, bilinear in space.
   *  Heights blend as energy; periods and directions are energy-weighted
   *  (directions as vectors, so 350 and 10 average to 0). Land corners drop
   *  out; null when every corner is land or outside the grid. */
  at(tMs: number, lat: number, lon: number): Systems | null {
    const h = this.h;
    const kf = Math.min(Math.max((tMs - this.t0) / 3.6e6 / h.step_h, 0), h.nt - 1);
    const fi = (lat - h.lat0) / h.res;
    const fj = (lon - h.lon0) / h.res;
    if (fi < 0 || fj < 0 || fi > h.nlat - 1 || fj > h.nlon - 1) return null;
    const k0 = Math.floor(kf);
    const i0 = Math.min(Math.floor(fi), h.nlat - 2);
    const j0 = Math.min(Math.floor(fj), h.nlon - 2);
    const corners: [number, number, number, number][] = []; // k, i, j, weight
    for (const [k, wk] of [
      [k0, 1 - (kf - k0)],
      [Math.min(k0 + 1, h.nt - 1), kf - k0],
    ] as const)
      for (const [i, wi] of [
        [i0, 1 - (fi - i0)],
        [i0 + 1, fi - i0],
      ] as const)
        for (const [j, wj] of [
          [j0, 1 - (fj - j0)],
          [j0 + 1, fj - j0],
        ] as const) {
          const w = wk * wi * wj;
          if (w > 0) corners.push([k, i, j, w]);
        }
    const out: Systems = { ws: null, s1: null, s2: null };
    let sea = 0; // weight of corners that are sea
    const acc = SYSTEMS.map(() => ({ e: 0, tm: 0, x: 0, y: 0 }));
    for (const [k, i, j, w] of corners) {
      const vals = SYSTEMS.map((s) => this.sys(k, i, j, s));
      if (vals.every((v) => v === null)) continue; // land or ice
      sea += w;
      vals.forEach((v, n) => {
        if (!v) return; // absent here: height 0
        const e = w * v.hs * v.hs;
        const a = acc[n];
        a.e += e;
        a.tm += e * v.tm;
        const r = (v.dir * Math.PI) / 180;
        a.x += e * Math.sin(r);
        a.y += e * Math.cos(r);
      });
    }
    if (sea === 0) return null;
    SYSTEMS.forEach((s, n) => {
      const a = acc[n];
      const hs = Math.sqrt(a.e / sea);
      if (!(hs >= MIN_HS)) return;
      const tm = a.tm / a.e;
      const dir = ((Math.atan2(a.x, a.y) * 180) / Math.PI + 360) % 360;
      const f = s === "ws" ? TP_PER_TM01.windSea : s === "s1" ? TP_PER_TM01.swell1 : TP_PER_TM01.swell2;
      out[s] = { hs, tp: f * tm, dirFrom: dir };
    });
    return out;
  }

  private sys(k: number, i: number, j: number, s: Sys): { hs: number; tm: number; dir: number } | null {
    const fh = this.idx[`${s}_hs`];
    const ft = this.idx[`${s}_tm`];
    const fd = this.idx[`${s}_dir`];
    if (fh === undefined || ft === undefined || fd === undefined) return null;
    const qh = this.raw(k, fh, i, j);
    const qt = this.raw(k, ft, i, j);
    const qd = this.raw(k, fd, i, j);
    if (qh === FILL || qt === FILL || qd === FILL) return null;
    return { hs: qh * this.scale[fh], tm: qt * this.scale[ft], dir: qd * this.scale[fd] };
  }
}

/**
 * Lazily loads months from a folder (public/seastate/ on the site). at() is
 * synchronous: it answers from loaded months and starts loading the month it
 * needs, so the first hour or two of a replay may use the single combined sea.
 * Without the files (not deployed, or offline) it quietly stays off.
 */
export class SeaStateFeed {
  private months: Set<string> | null = null;
  private failed = false;
  private readonly loaded = new Map<string, SeaStateMonth>();
  private readonly pending = new Set<string>();
  /** Called when a month arrives, e.g. to refresh the sea. */
  onLoad: (() => void) | null = null;

  constructor(
    private readonly base = "seastate/",
    private readonly get: (url: string) => Promise<Response> = (u) => fetch(u),
  ) {}

  /** Read the month list. Resolves false when there is no sea-state data. */
  async init(): Promise<boolean> {
    try {
      const r = await this.get(`${this.base}seastate_index.json`);
      if (!r.ok) throw new Error(String(r.status));
      const idx = (await r.json()) as { months: string[] };
      this.months = new Set(idx.months);
      return this.months.size > 0;
    } catch {
      this.failed = true;
      return false;
    }
  }

  get available(): boolean {
    return !this.failed && this.months !== null && this.months.size > 0;
  }

  /** Load one month ("YYYY-MM"); resolves null if it isn't there. */
  async load(month: string): Promise<SeaStateMonth | null> {
    const hit = this.loaded.get(month);
    if (hit) return hit;
    if (!this.months?.has(month)) return null;
    const stem = `${this.base}seastate_${month}`;
    const [hr, br] = await Promise.all([this.get(`${stem}.json`), this.get(`${stem}.bin.gz`)]);
    if (!hr.ok || !br.ok) throw new Error(`sea state ${month}: ${hr.status} ${br.status}`);
    const h = (await hr.json()) as SeaStateHeader;
    const m = new SeaStateMonth(h, new Int16Array(await gunzip(await br.arrayBuffer())));
    this.loaded.set(month, m);
    return m;
  }

  /** The systems at a time and place, if that month is loaded; otherwise null
   *  (and the month starts loading). */
  at(t: Date, lat: number, lon: number): Systems | null {
    if (!this.available || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    const month = t.toISOString().slice(0, 7);
    const m = this.loaded.get(month);
    if (m) return m.covers(t.getTime()) ? m.at(t.getTime(), lat, lon) : null;
    if (this.months?.has(month) && !this.pending.has(month)) {
      this.pending.add(month);
      this.load(month)
        .then(() => this.onLoad?.())
        .catch(() => {
          this.months?.delete(month); // don't retry a broken month every frame
        });
    }
    return null;
  }
}
