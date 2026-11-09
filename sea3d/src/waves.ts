// Sea surface as a sum of regular wave trains (Gerstner waves).
//
// Kept separate from the renderer on purpose: Phase 1 floats the boats by
// sampling this same function, so what you see and what lifts the boat agree.
//
// Units: metres, seconds, radians. x = east, z = south (three.js), y = up.
// Directions are the way the waves travel, in radians from +x.

export const G = 9.81; // m/s^2

export interface WaveComponent {
  amplitude: number; // m
  wavelength: number; // m
  direction: number; // rad, direction of travel
  phase: number; // rad
}

export interface SeaState {
  name: string;
  hs: number; // significant wave height, m
  tp: number; // peak period, s
  meanDirection: number; // rad
}

// Display presets for Phase 0. Not tied to data yet: Phase 1 takes Hs and Tp
// from the same ERA5 fields the simulator uses.
export const SEA_STATES: Record<string, SeaState> = {
  calm: { name: "Calm", hs: 0.5, tp: 5, meanDirection: 0.3 }, // GUESS display preset
  moderate: { name: "Moderate", hs: 1.5, tp: 7, meanDirection: 0.3 }, // GUESS display preset
  gale: { name: "Gale", hs: 5.0, tp: 11, meanDirection: 0.3 }, // GUESS display preset
};

/** Deep-water wavelength for a period: L = g T^2 / (2 pi). */
export function wavelengthFromPeriod(t: number): number {
  return (G * t * t) / (2 * Math.PI);
}

/** Small deterministic random generator so every run draws the same sea. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- Spectrum ---------------------------------------------------------------
// JONSWAP frequency spectrum (Hasselmann et al. 1973), peak enhancement
// gamma 3.3, sigma 0.07 below the peak and 0.09 above, with cos^2s
// directional spreading (Longuet-Higgins et al. 1963), s = 10 (GUESS: a
// wind sea with some swell; s ~ 5-25 is typical).
//
// The sea is split into n components of EQUAL energy: frequencies sit at the
// energy-weighted midpoints of n equal-variance bands between 0.6 fp and 3.5 fp,
// and directions at the midpoints of n equal-probability bands of the
// spreading function, paired by a seeded shuffle. Every component then has the
// same amplitude, so hsOf() is exact, the shape follows the spectrum (more
// components near the peak, fewer short ones) and nothing tiny wastes time.
// The JONSWAP shape in f / fp doesn't depend on Hs or Tp, so the layout is
// computed once per (n, seed) and only scaled.

export const JONSWAP_GAMMA = 3.3;
export const SPREAD_S = 10; // GUESS
const F_LO = 0.6; // f / fp
const F_HI = 3.5; // f / fp: shorter waves than this barely move a 1.5-3 m hull

/** JONSWAP spectral shape at r = f / fp (unnormalised). */
export function jonswapShape(r: number, gamma = JONSWAP_GAMMA): number {
  if (r <= 0) return 0;
  const sigma = r <= 1 ? 0.07 : 0.09;
  const peak = Math.pow(gamma, Math.exp(-((r - 1) ** 2) / (2 * sigma * sigma)));
  return Math.pow(r, -5) * Math.exp(-1.25 * Math.pow(r, -4)) * peak;
}

/** Points that split a density on [lo, hi] into n bands of equal area,
 *  returning each band's area-weighted midpoint. */
function equalAreaMidpoints(f: (x: number) => number, lo: number, hi: number, n: number): number[] {
  const m = 4000;
  const xs: number[] = [];
  const cum: number[] = [0];
  for (let i = 0; i <= m; i++) xs.push(lo + ((hi - lo) * i) / m);
  for (let i = 1; i <= m; i++) cum.push(cum[i - 1] + 0.5 * (f(xs[i - 1]) + f(xs[i])) * (xs[i] - xs[i - 1]));
  const total = cum[m];
  const inv = (q: number) => {
    let j = 1;
    while (j < m && cum[j] < q * total) j++;
    const c0 = cum[j - 1];
    const c1 = cum[j];
    return xs[j - 1] + ((xs[j] - xs[j - 1]) * (q * total - c0)) / (c1 - c0 || 1);
  };
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(inv((i + 0.5) / n));
  return out;
}

interface Layout {
  ratio: number[]; // f / fp
  offset: number[]; // direction from the mean, rad
  phase: number[]; // rad
}
const layouts = new Map<string, Layout>();

function layout(n: number, seed: number): Layout {
  const key = `${n}:${seed}`;
  const hit = layouts.get(key);
  if (hit) return hit;
  const rand = mulberry32(seed);
  const ratio = equalAreaMidpoints((r) => jonswapShape(r), F_LO, F_HI, n);
  const spread = (d: number) => Math.pow(Math.cos(d / 2), 2 * SPREAD_S);
  const dirs = equalAreaMidpoints(spread, -Math.PI, Math.PI, n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
  }
  const phase = ratio.map(() => rand() * 2 * Math.PI);
  const out = { ratio, offset: dirs, phase };
  layouts.set(key, out);
  return out;
}

/** Equal-energy amplitude that makes n components add up to Hs exactly. */
function amplitudeFor(hs: number, n: number): number {
  return Math.sqrt(2 / n) * (hs / 4);
}

/**
 * A sea state as n wave trains drawn from a JONSWAP spectrum with directional
 * spreading. Their combined variance gives exactly Hs: Hs = 4 sqrt(sum a^2 / 2).
 * Deterministic: the same (sea, n, seed) always gives the same sea.
 */
export function components(sea: SeaState, n = 24, seed = 1): WaveComponent[] {
  const L = layout(n, seed);
  const a = amplitudeFor(sea.hs, n);
  const fp = 1 / sea.tp;
  return L.ratio.map((r, i) => ({
    amplitude: a,
    wavelength: wavelengthFromPeriod(1 / (r * fp)),
    direction: sea.meanDirection + L.offset[i],
    phase: L.phase[i],
  }));
}

/** Direction of travel in this file's convention (rad from +x = east, toward
 *  +z = south) for waves coming FROM a compass bearing (deg true), as in ERA5
 *  mean wave direction. From the west (270) travels east (0 rad). */
export function travelFromCompass(dirFromDeg: number): number {
  return (((dirFromDeg + 90) % 360) * Math.PI) / 180;
}

/**
 * A live sea that follows changing conditions without jumps, for the replay.
 *
 *   const sea = new Sea();
 *   sea.setSeaState(hs, tp, dirFrom);  // any time, e.g. each hour of the replay
 *   const comps = sea.advance(t);      // every frame; pass comps to displace(), BoatMotion...
 *
 * Hs, Tp and direction ease toward the latest target with time constant
 * `smoothing` seconds (of the t you pass to advance). Each component keeps its
 * own running phase, so changing its period or direction never makes the
 * surface jump: it only stretches or turns smoothly, pivoting on `anchor`. The component layout
 * (frequency ratios, direction offsets, starting phases) is fixed by n and seed.
 */
export class Sea {
  readonly n: number;
  readonly seed: number;
  smoothing: number;
  hs: number;
  tp: number;
  direction: number; // rad, travel
  private target: { hs: number; tp: number; direction: number };
  private readonly L: Layout;
  private readonly psi: number[]; // running phase of each component
  private readonly comps: WaveComponent[];
  private tLast: number | null = null;
  /** Where a change of period or direction pivots (world x, z, m). Put it at
   *  the boats: near it the sea changes smoothly; far away the crests sweep
   *  round faster, like a fan opening. */
  anchor = { x: 0, z: 0 };

  constructor(start: SeaState = SEA_STATES.moderate, opts: { n?: number; seed?: number; smoothing?: number } = {}) {
    this.n = opts.n ?? 24;
    this.seed = opts.seed ?? 1;
    this.smoothing = opts.smoothing ?? 3;
    this.L = layout(this.n, this.seed);
    this.hs = start.hs;
    this.tp = start.tp;
    this.direction = start.meanDirection;
    this.target = { hs: this.hs, tp: this.tp, direction: this.direction };
    this.psi = this.L.phase.slice();
    this.comps = components(start, this.n, this.seed);
  }

  /** New conditions: significant wave height (m), peak period (s), and the
   *  compass direction the waves come FROM (deg true). Eases in, no jumps. */
  setSeaState(hs: number, tp: number, dirFromDeg: number): void {
    this.setTarget(hs, tp, travelFromCompass(dirFromDeg));
  }

  /** Same, with a preset (direction already in radians of travel). */
  setPreset(sea: SeaState): void {
    this.setTarget(sea.hs, sea.tp, sea.meanDirection);
  }

  /** Jump straight to the target (e.g. when the replay seeks). Not smooth. */
  snap(): void {
    this.hs = this.target.hs;
    this.tp = this.target.tp;
    this.direction = this.target.direction;
  }

  private setTarget(hs: number, tp: number, direction: number): void {
    this.target = { hs: Math.max(hs, 0), tp: Math.max(tp, 1), direction };
  }

  /** The sea at time t (s). Call with non-decreasing t. */
  advance(t: number): WaveComponent[] {
    const first = this.tLast === null;
    const dt = first ? 0 : Math.max(t - (this.tLast as number), 0);
    this.tLast = t;
    if (dt > 0) {
      const w = this.smoothing > 0 ? 1 - Math.exp(-dt / this.smoothing) : 1;
      this.hs += (this.target.hs - this.hs) * w;
      this.tp += (this.target.tp - this.tp) * w;
      // shortest way round
      let dd = this.target.direction - this.direction;
      dd = Math.atan2(Math.sin(dd), Math.cos(dd));
      this.direction += dd * w;
    }
    const a = amplitudeFor(this.hs, this.n);
    const fp = 1 / this.tp;
    for (let i = 0; i < this.n; i++) {
      const T = 1 / (this.L.ratio[i] * fp);
      const k = (2 * Math.PI) / wavelengthFromPeriod(T);
      const omega = Math.sqrt(G * k);
      const dir = this.direction + this.L.offset[i];
      const kAnchor = k * (Math.cos(dir) * this.anchor.x + Math.sin(dir) * this.anchor.z);
      // phase runs on at the component's current frequency; the first call
      // starts it where components() would be at time t
      if (first) this.psi[i] = this.L.phase[i] - omega * t + kAnchor;
      else this.psi[i] -= omega * dt;
      const c = this.comps[i];
      c.amplitude = a;
      c.wavelength = wavelengthFromPeriod(T);
      c.direction = dir;
      // displace() uses k x - omega t + phase: hand it the running phase,
      // measured from the anchor so stretching and turning pivot there
      c.phase = this.psi[i] + omega * t - kAnchor;
    }
    return this.comps;
  }
}

/** Significant wave height implied by a set of components. */
export function hsOf(comps: WaveComponent[]): number {
  return 4 * Math.sqrt(comps.reduce((s, c) => s + (c.amplitude * c.amplitude) / 2, 0));
}

/**
 * Displace a point (x0, z0) on the flat sea at time t. Returns [dx, y, dz].
 * steepness caps the crest sharpness sum(k a): 0 gives plain sine waves, up to
 * ~0.8 sharp crests. Below the cap each point moves sideways by its amplitude.
 */
export function displace(
  comps: WaveComponent[],
  x0: number,
  z0: number,
  t: number,
  steepness = 0.5,
): [number, number, number] {
  let dx = 0;
  let y = 0;
  let dz = 0;
  // Each surface point circles as in a real (trochoidal) wave, sideways by its
  // amplitude, scaled down if needed so the summed sharpness sum(k a) never
  // passes `steepness`: crests sharpen but never fold over into loops.
  let ka = 0;
  for (const c of comps) ka += ((2 * Math.PI) / c.wavelength) * c.amplitude;
  const q = ka > 0 ? Math.min(1, steepness / ka) : 0;
  for (const c of comps) {
    const k = (2 * Math.PI) / c.wavelength;
    const w = Math.sqrt(G * k); // deep-water dispersion
    const ux = Math.cos(c.direction);
    const uz = Math.sin(c.direction);
    const th = k * (ux * x0 + uz * z0) - w * t + c.phase;
    const qa = q * c.amplitude;
    dx -= qa * ux * Math.sin(th);
    dz -= qa * uz * Math.sin(th);
    y += c.amplitude * Math.cos(th);
  }
  return [dx, y, dz];
}

/**
 * Sea surface height at a fixed world point (x, z) at time t.
 *
 * displace() moves each surface point sideways as well as up, so the height
 * above a fixed point is the y of the surface point that has drifted onto it.
 * A few fixed-point steps find that point; with the default steepness the
 * error is well under a millimetre. This is what floats the boats, so the
 * picture and the motion use the same sea.
 */
export function heightAt(
  comps: WaveComponent[],
  x: number,
  z: number,
  t: number,
  steepness = 0.5,
  iterations = 4,
): number {
  let x0 = x;
  let z0 = z;
  for (let i = 0; i < iterations; i++) {
    const [dx, , dz] = displace(comps, x0, z0, t, steepness);
    x0 = x - dx;
    z0 = z - dz;
  }
  return displace(comps, x0, z0, t, steepness)[1];
}
