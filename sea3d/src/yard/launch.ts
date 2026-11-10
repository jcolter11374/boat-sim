// Launching a Boatyard design. The yard only talks to a Launcher, so the same
// page works with either back end:
//  - SandboxLauncher: the real simulator in the browser (Pyodide in Web
//    Workers, Theo's boatsim.sandbox, docs/sandbox.md): any design, six
//    launches of spring 2020, labelled "sandbox, 2020 weather";
//  - GridLauncher: Theo's precomputed grid (boatyard/index.json, schema 2):
//    finish odds over ten years for the nearest of ~20 builds.
// The yard shows the sandbox's voyages beside the grid's odds.

import { simChoices, type Catalog, type Design, type Summary } from "./design";

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
  /** True when the odds are this exact build's own; false for the nearest grid build. */
  exact: boolean;
  /** Plain words on what was run, e.g. "sandbox, 2020 weather; odds from the closest simulated build". */
  note: string;
  odds: LaunchOdds | null;
  replays: LaunchReplay[];
  /** Sandbox runs, one per launch, in Theo's reference fingerprint shape (Ravi's exact-match gate). */
  fingerprints?: Record<string, unknown>[];
}
export type Progress = (text: string, done: number, total: number) => void;
export interface Launcher {
  readonly name: string;
  /** null when this back end can't say anything about the design. */
  launch(design: Design, summary: Summary, progress?: Progress): Promise<LaunchResult | null>;
}

// ---------- the precomputed grid (schema 2) ----------
export interface GridBuild {
  id: string;
  boat: string;
  label: string;
  options: Record<string, string | number>; // catalog slot -> option id, plus cruise_w
  current?: boolean;
  odds: LaunchOdds | null;
  replays: { file: string; start: string; outcome: string; days: number }[];
}
interface GridIndex {
  schema: number;
  builds: GridBuild[];
}

/** How far a grid build is from a design: [modelled slots that differ, cruise watts apart] (as boatsim.sandbox.catalog.nearest). */
export function gridDistance(b: GridBuild, cat: Catalog, d: Design): [number, number] {
  let slots = 0;
  for (const s of cat.slots) {
    const want = d.picks[s.id];
    const def = (s.opts.find((o) => o.def) ?? s.opts[0]).id;
    const have = (b.options[s.id] as string | undefined) ?? def;
    const opt = s.opts.find((o) => o.id === want);
    if (have !== want && (opt?.effect ?? "wired") === "wired") slots++;
  }
  return [slots, Math.abs(Number(b.options.cruise_w ?? 25) - d.cruiseW)];
}

export class GridLauncher implements Launcher {
  readonly name = "precomputed grid";
  private index: Promise<GridIndex | null>;
  constructor(
    private cat: () => Catalog | null,
    private base = "./boatyard",
  ) {
    this.index = fetch(`${base}/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<GridIndex>) : null))
      .then((j) => (j && j.schema >= 2 ? j : null))
      .catch(() => null);
  }
  async build(id: string): Promise<GridBuild | null> {
    return (await this.index)?.builds.find((b) => b.id === id) ?? null;
  }
  async nearest(d: Design): Promise<{ build: GridBuild; exact: boolean } | null> {
    const idx = await this.index;
    const cat = this.cat();
    if (!idx || !cat) return null;
    const kayaks = idx.builds.filter((b) => !/randolph/i.test(b.boat));
    let best: GridBuild | null = null;
    let bestD: [number, number] = [Infinity, Infinity];
    for (const b of kayaks) {
      const dist = gridDistance(b, cat, d);
      if (dist[0] < bestD[0] || (dist[0] === bestD[0] && dist[1] < bestD[1])) [best, bestD] = [b, dist];
    }
    return best ? { build: best, exact: bestD[0] === 0 && bestD[1] === 0 } : null;
  }
  async launch(d: Design): Promise<LaunchResult | null> {
    const n = await this.nearest(d);
    if (!n) return null;
    return {
      exact: n.exact,
      note: n.exact ? `Simulated as built: ${n.build.label}.` : `Closest simulated build: ${n.build.label}.`,
      odds: n.build.odds,
      replays: n.build.replays.map((r) => ({ url: `${this.base}/${r.file}`, start: r.start, outcome: r.outcome, days: r.days })),
    };
  }
}

// ---------- the simulator in the browser ----------
interface Job {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** A few Web Workers, each with its own Pyodide, the simulator and the 2020 weather loaded once. */
class Pool {
  private workers: Worker[] = [];
  private jobs = new Map<number, Job>();
  private next = 1;
  onProgress: (text: string) => void = () => {};
  constructor(n: number) {
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") return this.onProgress(m.text);
        const job = this.jobs.get(m.id);
        if (!job) return;
        this.jobs.delete(m.id);
        if (m.ok) job.resolve(m.value);
        else job.reject(new Error(m.error));
      };
      this.workers.push(w);
    }
  }
  get size() {
    return this.workers.length;
  }
  ask<T>(worker: number, msg: Record<string, unknown>): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.workers[worker].postMessage({ ...msg, id });
    });
  }
}

interface SandboxMeta {
  build: string;
  effects: Record<string, unknown>;
  odds_build: string;
  exact: boolean;
  note: string;
  launches: [string, number][];
}
interface SandboxRun {
  result: { start: string; outcome: string; days?: number; [k: string]: unknown };
  replay: Record<string, unknown> | null;
  fingerprint: Record<string, unknown>;
}

export class SandboxLauncher implements Launcher {
  readonly name = "simulator in the browser";
  private pool: Pool | null = null;
  constructor(
    private grid: GridLauncher,
    private base = "./sandbox/",
  ) {}
  /** True when the page was published with the sandbox files (boatsim.zip, the weather bundle). */
  async available(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}boatsim.zip`, { method: "HEAD" });
      // A dev server answers a missing file with its HTML page, not a 404.
      return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
    } catch {
      return false;
    }
  }
  async launch(d: Design, _s: Summary, progress: Progress = () => {}): Promise<LaunchResult | null> {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    this.pool ??= new Pool(Math.max(1, Math.min(3, cores - 1)));
    const pool = this.pool;
    const choices = simChoices(d);
    // Absolute: inside a worker a relative URL means the worker script's folder, not the page's.
    const base = new URL(this.base, location.href).href;
    let done = 0;
    pool.onProgress = (text) => progress(text, done, 6);
    const meta = await pool.ask<SandboxMeta>(0, { type: "meta", base, choices });
    const total = meta.launches.length;
    progress("Sailing...", 0, total);
    const runs: SandboxRun[] = new Array(total);
    let nextLaunch = 0;
    await Promise.all(
      Array.from({ length: pool.size }, async (_, w) => {
        while (nextLaunch < total) {
          const i = nextLaunch++;
          runs[i] = await pool.ask<SandboxRun>(w, { type: "run", base, choices, index: i });
          done++;
          progress(`Sailed ${done} of ${total} launches`, done, total);
        }
      }),
    );
    const grid = await this.grid.build(meta.odds_build);
    const finished = runs.filter((r) => r.result.outcome === "arrived").length;
    const replays = runs
      .filter((r) => r.replay)
      .map((r) => ({
        url: URL.createObjectURL(new Blob([JSON.stringify(r.replay)], { type: "application/json" })),
        start: r.result.start,
        outcome: r.result.outcome,
        days: Number(r.result.days ?? 0),
      }));
    return {
      exact: meta.exact,
      note:
        `Sandbox (${meta.note}): ${finished} of ${total} voyages finished, run here in your browser. ` +
        "A browser run can end differently from the same voyage on our servers, because tiny maths differences grow over months. " +
        (grid?.odds
          ? `The odds above come from our server runs over ten years of weather${meta.exact ? ", for this exact build." : `, for the closest build we've run: ${grid.label}.`}`
          : "No server odds for this build yet."),
      odds: grid?.odds ?? null,
      replays,
      fingerprints: runs.map((r) => r.fingerprint),
    };
  }
}
