// Launching a Boatyard design. The yard only talks to a Launcher, so the same
// page works with either back end:
//  - GridLauncher: Theo's precomputed grid (sea3d/public/boatyard/index.json,
//    docs/boatyard.md): the nearest simulated build, said plainly when it
//    isn't an exact match;
//  - later, the real simulator running in the browser (Pyodide), which can
//    run any combination exactly.

import type { Design, Summary } from "./design";

export interface LaunchOdds {
  voyages: number;
  finished: number;
  odds: number; // 0..1
  low95: number;
  high95: number;
  median_days: number | null;
}
export interface LaunchReplay {
  url: string; // replay file (voyage replay schema 1)
  start: string; // ISO UTC
  outcome: string;
  days: number;
}
export interface LaunchResult {
  /** True when this exact design was simulated; false for the nearest build. */
  exact: boolean;
  /** Plain words on what was run, e.g. "closest simulated build: ..." */
  note: string;
  odds: LaunchOdds | null;
  replays: LaunchReplay[];
}
export interface Launcher {
  readonly name: string;
  /** null when this back end can't say anything about the design. */
  launch(design: Design, summary: Summary): Promise<LaunchResult | null>;
}

// ---------- the precomputed grid ----------
interface GridBuild {
  id: string;
  boat: string;
  label: string;
  options: { motors?: number; cruise_w?: number; energy?: string; boxes?: number; [k: string]: unknown };
  current?: boolean;
  odds: (LaunchOdds & Record<string, unknown>) | null;
  replays: { file: string; start: string; outcome: string; days: number }[];
}
interface GridEnergy {
  id: string;
  label: string;
  battery_wh: number;
  solar_wp: number;
}
interface GridIndex {
  schema: number;
  options: { energy: GridEnergy[]; [k: string]: unknown };
  builds: GridBuild[];
}

/** How far a grid build is from a design (0 = same on every knob the grid has). */
export function gridDistance(b: GridBuild, energy: GridEnergy[], s: Summary): number {
  const o = b.options;
  const e = energy.find((x) => x.id === o.energy || x.label === o.energy);
  let d = 0;
  if (o.motors != null) d += Math.abs(o.motors - s.thrusters) * 4;
  if (o.boxes != null) d += Math.abs(o.boxes - s.boxes) * 4;
  if (o.cruise_w != null) d += Math.abs(o.cruise_w - s.cruiseW) / 5;
  if (e) d += Math.abs(Math.log2(e.battery_wh / s.batteryWh)) * 2 + Math.abs(Math.log2(e.solar_wp / s.solarW)) * 2;
  return d;
}

export class GridLauncher implements Launcher {
  readonly name = "precomputed grid";
  private index: Promise<GridIndex | null>;
  constructor(private base = "./boatyard") {
    this.index = fetch(`${base}/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<GridIndex>) : null))
      .catch(() => null);
  }
  /** False until the grid data is published with the page. */
  async ready(): Promise<boolean> {
    return (await this.index) !== null;
  }
  async launch(_d: Design, s: Summary): Promise<LaunchResult | null> {
    const idx = await this.index;
    if (!idx) return null;
    const kayaks = idx.builds.filter((b) => !/randolph/i.test(b.boat));
    if (!kayaks.length) return null;
    let best = kayaks[0];
    let bestD = Infinity;
    for (const b of kayaks) {
      const dist = gridDistance(b, idx.options.energy ?? [], s);
      if (dist < bestD) {
        bestD = dist;
        best = b;
      }
    }
    // Parts the grid doesn't vary (beacon, AIS, paint, keel...) are run as planned.
    const exact = bestD < 1e-6;
    return {
      exact,
      note: exact
        ? `Simulated as built: ${best.label}.`
        : `Closest simulated build: ${best.label}. Parts the grid doesn't vary yet run as planned.`,
      odds: best.odds,
      replays: best.replays.map((r) => ({ url: `${this.base}/${r.file}`, start: r.start, outcome: r.outcome, days: r.days })),
    };
  }
}
