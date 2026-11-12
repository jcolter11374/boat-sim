// Other ships in the 3D views, as many and where the real traffic is: placed from
// the simulator's own ship-traffic map (public/ships.bin, from EMODnet vessel density
// and the World Bank / IMF global shipping density, ships per km² at any moment; see
// scripts/ships.py). Busy lanes and port approaches have plenty, mid-ocean you may
// sail for days without one. Display only: it doesn't touch the simulator's
// ship-strike hazard, which reads the same map on its own.
//
// Ships are drawn from fixed 0.1 degree cells of the map, a few chances per cell,
// each chance a new ship every hour (staggered), so where they are depends only on
// the time and place: every page and every replay of the same hour shows the same
// ships. Each one sails a straight line through its cell for that hour; merchant ships
// follow the lie of the lane (along the map's ridges of traffic), fishing boats wander.
// A ship that's in sight when its hour is up keeps going until it's out of sight, and
// new ones only appear out of sight, so nothing pops in or out in view.

import * as THREE from "three";
import { dressShip, makeShip, SHIP_SIZE, type ShipKind } from "./boats/ships";
import { metresPerDegree, R_EARTH } from "./land/shader";
import { reflectable } from "./mirror";

export interface ShipGrid {
  lat0: number;
  lon0: number;
  res: number;
  nlat: number;
  nlon: number;
  cells: Uint8Array;
}

/** Each chance is a new ship this often (s). */
export const HOUR = 3600;
/** Chances per cell: enough for the busiest water at CAP. */
export const SLOTS = 4;
/**
 * Ships per km² we show at most. The busiest cells are harbours full of moored craft
 * (0.3 per km² off Lisbon); the ships you'd see sailing there are far fewer. GUESS.
 */
export const CAP = 0.02;
/** How far out we look for ships (m): past where their lights carry on a clear night (about 6 nautical miles). */
export const RANGE = 15000;
/** The most ships kept in the scene at once (the nearest). */
export const MAX_SHIPS = 24;
/** How much further than the fog's far edge a ship's hull still shows (as rainbands.ts). */
export const HULL_REACH = 1.8;
const FASTEST = 10; // m/s, the fastest any ship goes (container ships, about 20 knots)

/** Read ships.bin (see scripts/ships.py). */
export function decodeShips(buf: ArrayBuffer): ShipGrid {
  const v = new DataView(buf);
  const nlat = v.getUint16(12, true);
  const nlon = v.getUint16(14, true);
  return { lat0: v.getFloat32(0, true), lon0: v.getFloat32(4, true), res: v.getFloat32(8, true), nlat, nlon, cells: new Uint8Array(buf, 16, nlat * nlon) };
}

/** A cell's byte (0 for land, no ships, or off the map). */
function byteAt(g: ShipGrid, i: number, j: number): number {
  return i < 0 || j < 0 || i >= g.nlat || j >= g.nlon ? 0 : g.cells[i * g.nlon + j];
}

const fromByte = (b: number) => (b ? 10 ** ((b - 1) / 32 - 7) : 0);

/** Ships per km² at any moment at (lat, lon); 0 on land and off the map. */
export function densityAt(g: ShipGrid, lat: number, lon: number): number {
  return fromByte(byteAt(g, Math.floor((lat - g.lat0) / g.res), Math.floor((lon - g.lon0) / g.res)));
}

/** A number in 0..1 from four integers, always the same for the same four. */
export function hash4(a: number, b: number, c: number, d: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x9e3779b1) ^ Math.imul(d | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** One ship's hour: where it's going, how fast, and where it is at the middle of the hour. */
export interface Sighting {
  id: string;
  kind: ShipKind;
  /** Its place at tMid. */
  lat: number;
  lon: number;
  /** Degrees true (clockwise from north). */
  heading: number;
  /** m/s; 0 at anchor. */
  speed: number;
  anchored: boolean;
  /** Seconds (UTC) at the middle of its hour. */
  tMid: number;
  seed: number;
}

/** Where a ship is at time t (s), on its straight line. */
export function shipAt(s: Sighting, t: number): { lat: number; lon: number } {
  const m = s.speed * (t - s.tMid);
  const { mx, my } = metresPerDegree(s.lat);
  const h = THREE.MathUtils.degToRad(s.heading);
  return { lat: s.lat + (Math.cos(h) * m) / my, lon: s.lon + (Math.sin(h) * m) / mx };
}

/** Metres from (lat, lon) to a point, flat-earth (fine over tens of km). */
export function metresTo(lat: number, lon: number, p: { lat: number; lon: number }): number {
  const { mx, my } = metresPerDegree(lat);
  return Math.hypot((p.lon - lon) * mx, (p.lat - lat) * my);
}

/**
 * The way a lane runs at a cell, degrees true (either way along it), or null where
 * the traffic has no clear grain: along the ridge, across the slope of the map.
 */
export function laneHeading(g: ShipGrid, i: number, j: number): number | null {
  // The slope over the cells round about (two each way), so one odd cell doesn't turn the lane.
  let n = 0;
  let e = 0;
  for (let a = -2; a <= 2; a++)
    for (const d of [1, 2]) {
      n += (byteAt(g, i + d, j + a) - byteAt(g, i - d, j + a)) / (2 * d);
      e += (byteAt(g, i + a, j + d) - byteAt(g, i + a, j - d)) / (2 * d);
    }
  n /= 10;
  e /= 10;
  if (Math.hypot(n, e) < 4) return null; // under about a third of a decade a cell
  const { mx, my } = metresPerDegree(g.lat0 + (i + 0.5) * g.res);
  // Slope per metre north and east; the lane runs square to it.
  const sn = n / my;
  const se = e / mx;
  return (THREE.MathUtils.radToDeg(Math.atan2(-sn, se)) + 360) % 360;
}

/** Every ship within `radius` (m) of (lat, lon) at time t (s, UTC), nearest first. */
export function shipsNear(g: ShipGrid, lat: number, lon: number, t: number, radius = RANGE): Sighting[] {
  const out: { s: Sighting; d: number }[] = [];
  const reach = radius + FASTEST * (HOUR / 2);
  const { mx, my } = metresPerDegree(lat);
  const i0 = Math.floor((lat - reach / my - g.lat0) / g.res);
  const i1 = Math.floor((lat + reach / my - g.lat0) / g.res);
  const j0 = Math.floor((lon - reach / mx - g.lon0) / g.res);
  const j1 = Math.floor((lon + reach / mx - g.lon0) / g.res);
  for (let i = Math.max(0, i0); i <= Math.min(g.nlat - 1, i1); i++) {
    const cLat = g.lat0 + (i + 0.5) * g.res;
    const m = metresPerDegree(cLat);
    const km2 = (g.res * m.mx * g.res * m.my) / 1e6;
    for (let j = Math.max(0, j0); j <= Math.min(g.nlon - 1, j1); j++) {
      const b = byteAt(g, i, j);
      if (!b) continue;
      const d = fromByte(b);
      const p = Math.min(1, (Math.min(d, CAP) * km2) / SLOTS);
      for (let k = 0; k < SLOTS; k++) {
        const phase = hash4(i, j, k, 7) * HOUR;
        const n = Math.floor((t - phase) / HOUR);
        let c = 0;
        const r = () => hash4(i * 8 + k, j, n, ++c);
        if (r() >= p) continue;
        const s = sighting(g, i, j, k, n, phase, d, r);
        if (!s) continue;
        const dist = metresTo(lat, lon, shipAt(s, t));
        if (dist < radius) out.push({ s, d: dist });
      }
    }
  }
  return out.sort((a, b) => a.d - b.d).map((x) => x.s);
}

/** Fill in one chance's ship (null when its line would cross land). */
function sighting(g: ShipGrid, i: number, j: number, k: number, n: number, phase: number, d: number, r: () => number): Sighting | null {
  const lat = g.lat0 + (i + r()) * g.res;
  const lon = g.lon0 + (j + r()) * g.res;
  // The mix of kinds (GUESS: roughly the share of big ships on AIS: box ships, tankers, bulk carriers, fishing).
  const u = r();
  const kind: ShipKind = u < 0.35 ? "container" : u < 0.6 ? "tanker" : u < 0.85 ? "bulk" : "fishing";
  // In crowded port water half the merchant ships wait at anchor (GUESS).
  const anchored = kind !== "fishing" && d > 0.01 && r() < 0.5;
  const speed = anchored ? 0 : kind === "container" ? 8 + 2 * r() : kind === "tanker" ? 6 + 1.2 * r() : kind === "bulk" ? 6.2 + 1.2 * r() : 1.5 + 1.0 * r(); // a trawler fishing makes 3 to 5 knots (Sam)
  const lane = kind === "fishing" || anchored ? null : laneHeading(g, i, j);
  const heading = lane == null ? r() * 360 : (lane + (r() < 0.5 ? 0 : 180) + (r() - 0.5) * 30 + 360) % 360;
  const s: Sighting = { id: `${i}:${j}:${k}:${n}`, kind, lat, lon, heading, speed, anchored, tMid: phase + (n + 0.5) * HOUR, seed: r() };
  // Never across land: look along the whole hour's line.
  for (let q = 0; q <= 6; q++) {
    const at = shipAt(s, s.tMid + ((q - 3) / 6) * HOUR);
    if (densityAt(g, at.lat, at.lon) === 0) return null;
  }
  return s;
}

interface Live {
  s: Sighting;
  obj: THREE.Group;
}

export class Traffic {
  readonly root = new THREE.Group();
  /** What's in the scene (for tests and the page). */
  readonly shown = { ships: 0, inSight: 0, nearest: Infinity, bearing: 0, kinds: { container: 0, tanker: 0, bulk: 0, fishing: 0 } as Record<ShipKind, number> };
  /** Lights fade out by this distance (m). */
  private readonly lightRange = { value: 8000 };
  private live = new Map<string, Live>();
  /** Ships out of use, kept to reuse. */
  private spare: Record<ShipKind, THREE.Group[]> = { container: [], tanker: [], bulk: [], fishing: [] };
  private last: { t: number; lat: number; lon: number } | null = null;

  /** ?ship=container|tanker|bulk|fishing puts one ship of that kind under way near the boat (testing, proofs). */
  private readonly forcedKind: ShipKind | null;
  /** &near=metres: how far off she starts (default 900, 100 to 5000). */
  private readonly forcedRange: number;

  private constructor(private readonly grid: ShipGrid | null) {
    this.root.name = "traffic";
    const q = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("ship");
    const near = typeof location === "undefined" ? NaN : Number(new URLSearchParams(location.search).get("near"));
    this.forcedRange = Number.isFinite(near) && near > 0 ? THREE.MathUtils.clamp(near, 100, 5000) : 900;
    this.forcedKind = q === "container" || q === "tanker" || q === "bulk" || q === "fishing" ? q : null;
    // For playtest checks: where the ships are, so a check can point its camera at one.
    if (typeof window !== "undefined") (window as unknown as { __traffic: { ships: () => ReturnType<Traffic["list"]> } }).__traffic = { ships: () => this.list() };
  }

  /** The ships in the scene now: scene position (m, our boat at the origin, east +x, north -z), range, bearing and how she's going. */
  list(): { id: string; kind: ShipKind; x: number; z: number; distance: number; bearing: number; heading: number; speed: number; anchored: boolean }[] {
    return [...this.live.values()].map(({ s, obj }) => ({
      id: s.id,
      kind: s.kind,
      x: obj.position.x,
      z: obj.position.z,
      distance: Math.hypot(obj.position.x, obj.position.z),
      bearing: (THREE.MathUtils.radToDeg(Math.atan2(obj.position.x, -obj.position.z)) + 360) % 360,
      heading: s.heading,
      speed: s.speed,
      anchored: s.anchored,
    }));
  }

  /** Load the traffic map; with none published there are simply no ships. */
  static async load(base = "."): Promise<Traffic> {
    try {
      const r = await fetch(`${base}/ships.bin`);
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return new Traffic(null);
      return new Traffic(decodeShips(await r.arrayBuffer()));
    } catch {
      return new Traffic(null);
    }
  }

  /** For tests: a Traffic on a grid already in hand. */
  static from(grid: ShipGrid): Traffic {
    return new Traffic(grid);
  }

  /**
   * Each frame, with our boat at the scene's origin at (lat, lon), at time t (s, UTC).
   * `seeing` is how far you can see (m, the fog's far edge); hs the wave height (m).
   */
  update(lat: number, lon: number, t: number, seeing: number, hs: number): void {
    const g = this.grid;
    if (!g || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(t)) return;
    // A dark hull shows through haze that hides the paler sea (as the rain curtains do), and a
    // lit lantern carries further still: a big ship's masthead light reaches 6 nautical miles
    // on a clear night (COLREGs Annex I), much less in fog.
    const hullSeen = seeing * HULL_REACH;
    this.lightRange.value = THREE.MathUtils.clamp(seeing * 4, 600, 11000);
    // Out of sight: where neither its hull nor its lights show.
    const hidden = Math.min(0.9 * RANGE, Math.max(hullSeen, this.lightRange.value));
    const last = this.last;
    const jumped = !last || Math.abs(t - last.t) > HOUR / 2 || metresTo(lat, lon, last) > 10000;
    if (jumped || Math.abs(t - last!.t) > 20 || metresTo(lat, lon, last!) > 500) {
      this.last = { t, lat, lon };
      const near = shipsNear(g, lat, lon, t).slice(0, MAX_SHIPS);
      const want = new Set(near.map((s) => s.id));
      for (const [id, l] of this.live) {
        const p = shipAt(l.s, t);
        // The test ship stays until she has passed well clear (then a fresh one comes), whatever the density map says.
        if (id === "forced") {
          if (jumped || metresTo(lat, lon, p) > Math.max(3000, 3 * this.forcedRange)) this.remove(id);
          continue;
        }
        const d = metresTo(lat, lon, p);
        // After a jump in time or place, only the ships that are really there now stay.
        const keep = want.has(id) || (!jumped && d <= hidden);
        if (!keep || d > RANGE || densityAt(g, p.lat, p.lon) === 0) this.remove(id);
      }
      if (this.forcedKind && !this.live.has("forced")) {
        // Off on the starboard bow (900 m unless &near= says), crossing ahead from east to west.
        const { mx, my } = metresPerDegree(lat);
        const b = THREE.MathUtils.degToRad(40);
        const fishing = this.forcedKind === "fishing";
        this.add({ id: "forced", kind: this.forcedKind, lat: lat + (Math.cos(b) * this.forcedRange) / my, lon: lon + (Math.sin(b) * this.forcedRange) / mx, heading: 270, speed: fishing ? 2 : 8.5, anchored: false, tMid: t, seed: 0.3 });
      }
      for (const s of near) if (!this.live.has(s.id) && (jumped || metresTo(lat, lon, shipAt(s, t)) > hidden)) this.add(s);
    }
    // Place them: east is +x, north is -z, sunk by the earth's curve.
    const { mx, my } = metresPerDegree(lat);
    const k = this.shown.kinds;
    k.container = k.tanker = k.bulk = k.fishing = 0;
    let nearest = Infinity;
    let bearing = 0;
    let inSight = 0;
    for (const { s, obj } of this.live.values()) {
      const p = shipAt(s, t);
      const x = (p.lon - lon) * mx;
      const z = -(p.lat - lat) * my;
      const d = Math.hypot(x, z);
      if (d < nearest) {
        nearest = d;
        bearing = (THREE.MathUtils.radToDeg(Math.atan2(x, -z)) + 360) % 360;
      }
      if (d < hullSeen) inSight++;
      k[s.kind]++;
      // Riding the swell: smaller ships pitch and roll more.
      const { length: L, beam: B } = SHIP_SIZE[s.kind];
      const w = 2 * Math.PI * (0.08 + 0.04 * s.seed);
      const a = s.seed * 50;
      obj.position.set(x, (obj.userData.lift ?? 0) - (d * d) / (2 * R_EARTH) + (s.kind === "fishing" ? 0.25 * hs * Math.sin(w * t + a) : 0), z);
      obj.rotation.set(
        Math.min(0.15, (0.6 * hs) / B) * Math.sin(w * t * 0.8 + a), // roll
        -THREE.MathUtils.degToRad(s.heading + 90), // bow (builder -x) to the heading
        Math.min(0.08, (0.8 * hs) / L) * Math.sin(w * t * 1.1 + a + 1), // pitch
      );
    }
    Object.assign(this.shown, { ships: this.live.size, inSight, nearest, bearing });
  }

  private add(s: Sighting): void {
    const obj = this.spare[s.kind].pop() ?? makeShip(s.kind, this.lightRange);
    dressShip(obj, s.kind, s.seed, s.anchored, s.speed); // under way she makes a bow wave
    reflectable(obj);
    this.root.add(obj);
    this.live.set(s.id, { s, obj });
  }

  private remove(id: string): void {
    const l = this.live.get(id);
    if (!l) return;
    this.root.remove(l.obj); // geometry and materials are shared, so nothing to free
    this.spare[l.s.kind].push(l.obj);
    this.live.delete(id);
  }
}
