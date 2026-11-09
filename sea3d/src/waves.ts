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

/**
 * Split a sea state into n wave trains whose combined variance matches Hs:
 * Hs = 4 * sqrt(sum a_i^2 / 2), with periods spread from 0.35 Tp to 1.3 Tp (short chop on top of the long waves) and directions
 * spread around the mean.
 */
export function components(sea: SeaState, n = 16, seed = 1): WaveComponent[] {
  const rand = mulberry32(seed);
  const a = Math.sqrt(2 / n) * (sea.hs / 4);
  const out: WaveComponent[] = [];
  for (let i = 0; i < n; i++) {
    const t = sea.tp * (0.35 + 0.95 * (i / Math.max(1, n - 1))); // 0.35 Tp .. 1.3 Tp
    out.push({
      amplitude: a,
      wavelength: wavelengthFromPeriod(t),
      direction: sea.meanDirection + (rand() - 0.5) * 1.2,
      phase: rand() * Math.PI * 2,
    });
  }
  return out;
}

/** Significant wave height implied by a set of components. */
export function hsOf(comps: WaveComponent[]): number {
  return 4 * Math.sqrt(comps.reduce((s, c) => s + (c.amplitude * c.amplitude) / 2, 0));
}

/**
 * Displace a point (x0, z0) on the flat sea at time t. Returns [dx, y, dz].
 * steepness 0 gives plain sine waves; up to ~0.8 sharpens the crests.
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
  const q = steepness / comps.length;
  for (const c of comps) {
    const k = (2 * Math.PI) / c.wavelength;
    const w = Math.sqrt(G * k); // deep-water dispersion
    const ux = Math.cos(c.direction);
    const uz = Math.sin(c.direction);
    const th = k * (ux * x0 + uz * z0) - w * t + c.phase;
    const qa = (q / (k * c.amplitude || 1)) * c.amplitude; // keeps loops from forming
    dx -= qa * ux * Math.sin(th);
    dz -= qa * uz * Math.sin(th);
    y += c.amplitude * Math.cos(th);
  }
  return [dx, y, dz];
}
