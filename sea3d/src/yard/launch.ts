// Launching a Boatyard design. The yard only talks to a Launcher, so the same
// page works with either back end:
//  - SandboxLauncher: the real simulator in the browser (Pyodide in Web
//    Workers, Theo's boatsim.sandbox, docs/sandbox.md): any design, six
//    launches of spring 2020, labelled "sandbox, 2020 weather";
//  - GridLauncher: Theo's precomputed grid (boatyard/index.json, schema 2):
//    finish odds over ten years for the nearest of ~20 builds.
// The yard shows the sandbox's voyages beside the grid's odds.

import { sailOnly, simChoices, type Catalog, type Design, type Summary } from "./design";
import { sandboxThere } from "../sandbox";

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
  /** Data attribution to show with the results (the sandbox redistributes modified data). */
  credits?: { text: string; url: string };
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
  /** Which launches the odds come from (boatsim.mc.boatyard). */
  odds_source?: { years?: [number, number]; months?: number[] };
}

/** How far a grid build is from a design: [modelled slots that differ, cruise watts apart] (as boatsim.sandbox.catalog.nearest). */
export function gridDistance(b: GridBuild, cat: Catalog, d: Design): [number, number] {
  // Only builds of the same boat compare (an older Randolph build without a base never matches).
  if (gridBase(b) !== (d.base ?? "kayak")) return [Infinity, Infinity];
  let slots = 0;
  // A wing sail with no motors: the motors and cruise power don't apply (Theo's k-p0-drive.wing-sail).
  const sail = sailOnly(d);
  for (const s of cat.slots) {
    if (sail && s.id === "thr") continue;
    const def = (s.opts.find((o) => o.def) ?? s.opts[0]).id;
    // What the simulator actually sails in this slot: a part it doesn't model yet
    // sails as the default. So a grid build with full spares on Rev C (spares aren't
    // modelled) is the same voyage as Rev C as built, which has none (#315).
    const sails = (id: string) => ((s.opts.find((o) => o.id === id)?.effect ?? "wired") === "wired" ? id : def);
    const want = d.picks[s.id] ?? def;
    const have = (b.options[s.id] as string | undefined) ?? def;
    if (sails(have) !== sails(want)) slots++;
  }
  // The simulator ignores the cruise power on a Randolph boat.
  return [slots, sail || gridBase(b) !== "kayak" ? 0 : Math.abs(Number(b.options.cruise_w ?? 25) - d.cruiseW)];
}

/** Which boat a grid build is: its base option, else the kayak; older Randolph builds (no base) are their own. */
export function gridBase(b: GridBuild): string {
  const v = b.options.base;
  if (typeof v === "string") return v;
  return /randolph/i.test(b.boat) ? "legacy-randolph" : "kayak";
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
  /** Every grid build (empty without the grid). */
  async all(): Promise<GridBuild[]> {
    return (await this.index)?.builds ?? [];
  }
  /** Which launches the odds come from, or null. */
  async source(): Promise<GridIndex["odds_source"] | null> {
    return (await this.index)?.odds_source ?? null;
  }
  async nearest(d: Design): Promise<{ build: GridBuild; exact: boolean } | null> {
    const idx = await this.index;
    const cat = this.cat();
    if (!idx || !cat) return null;
    let best: GridBuild | null = null;
    let bestD: [number, number] = [Infinity, Infinity];
    for (const b of idx.builds) {
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
      note: n.exact ? `Simulated: ${n.build.label}.` : `Closest build we've simulated: ${n.build.label}.`,
      odds: n.build.odds,
      replays: n.build.replays.map((r) => ({ url: `${this.base}/${r.file}`, start: r.start, outcome: r.outcome, days: r.days })),
    };
  }
}

// ---------- the simulator in the browser ----------
interface Job {
  worker: number;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** How long a worker may stay silent before we give up on it and use the grid: loading Python and the
 * weather (one message when it starts), and one voyage (20 to 80 s on a laptop; slow machines get room). */
export const LOAD_TIMEOUT_MS = 150_000;
export const RUN_TIMEOUT_MS = 300_000;

/** A few Web Workers, each with its own Pyodide, the simulator and the 2020 weather loaded once.
 * A worker that crashes, can't start, or goes quiet too long fails its job (and the pool is spent),
 * so a launch always ends: in the browser's results or the grid's, never a page waiting forever. */
export class Pool {
  private workers: Worker[] = [];
  private jobs = new Map<number, Job>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private next = 1;
  broken: Error | null = null;
  onProgress: (text: string) => void = () => {};
  constructor(
    n: number,
    make: () => Worker = () => new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" }),
    private loadMs = LOAD_TIMEOUT_MS,
    private runMs = RUN_TIMEOUT_MS,
  ) {
    for (let i = 0; i < n; i++) {
      const w = make();
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.type === "progress") {
          this.kick(i);
          return this.onProgress(m.text);
        }
        const job = this.jobs.get(m.id);
        if (!job) return;
        this.settle(m.id);
        if (m.ok) job.resolve(m.value);
        else job.reject(new Error(m.error));
      };
      // A worker script that fails to load or throws outside a job (an old browser, a blocked
      // download, out of memory) never answers: fail everything rather than hang.
      w.onerror = (ev) => {
        ev.preventDefault?.();
        this.fail(new Error(`the simulator stopped (${ev.message || "worker error"})`));
      };
      w.onmessageerror = () => this.fail(new Error("the simulator sent a message the page couldn't read"));
      this.workers.push(w);
    }
  }
  get size() {
    return this.workers.length;
  }
  ask<T>(worker: number, msg: Record<string, unknown>): Promise<T> {
    if (this.broken) return Promise.reject(this.broken);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.jobs.set(id, { worker, resolve: resolve as (v: unknown) => void, reject });
      this.arm(id, this.loadMs);
      this.workers[worker].postMessage({ ...msg, id });
    });
  }
  /** Stop every worker and fail every job still waiting. */
  fail(e: Error): void {
    this.broken ??= e;
    for (const w of this.workers) w.terminate();
    for (const [id, job] of [...this.jobs]) {
      this.settle(id);
      job.reject(this.broken);
    }
  }
  private arm(id: number, ms: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.set(
      id,
      setTimeout(() => this.fail(new Error(`the simulator went quiet for ${Math.round(ms / 1000)} s`)), ms),
    );
  }
  /** A worker said something: its job is alive; after "Sailing..." the voyage budget applies. */
  private kick(worker: number): void {
    for (const [id, job] of this.jobs) if (job.worker === worker) this.arm(id, this.runMs);
  }
  private settle(id: number): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.jobs.delete(id);
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

/** docs/sandbox.md, "Data sources and attribution": shown wherever sandbox results appear. */
export const SANDBOX_CREDITS = {
  text:
    "Weather and currents: contains modified Copernicus Climate Change Service and Copernicus Marine Service information (2020). " +
    "Ship traffic: EMODnet and the World Bank (CC BY 4.0, changed by us). Land: made with Natural Earth.",
  url: "https://github.com/jcolter11374/boat-sim/blob/main/docs/sandbox.md#data-sources-and-attribution",
};

export class SandboxLauncher implements Launcher {
  readonly name = "simulator in the browser";
  private pool: Pool | null = null;
  private crash: Error | null = null;
  constructor(
    private grid: GridLauncher,
    private base = "./sandbox/",
    private planned?: () => Design | null,
  ) {}
  /** True when the page was published with the sandbox files (boatsim.zip, the weather bundle). */
  async available(): Promise<boolean> {
    return sandboxThere(new URL(this.base, location.href).href);
  }
  async launch(d: Design, _s: Summary, progress: Progress = () => {}): Promise<LaunchResult | null> {
    try {
      return await this.sail(d, progress);
    } catch (e) {
      // The published simulator can lag the page (a new part the page knows and it doesn't
      // yet answers "unknown slot"): fall back to the grid rather than fail the launch.
      console.warn("browser simulator failed, using the grid:", e);
      const crashed = this.crash;
      this.crash = null;
      if (this.pool?.broken) this.pool = null; // spent: free its memory, start fresh next time
      const r = await this.grid.launch(d);
      if (r)
        r.note = crashed
          ? `${r.note} (The simulator couldn't run in this browser: ${crashed.message}. These are the results from our servers.)`
          : `${r.note} (The simulator in your browser can't sail this design yet; coming soon.)`;
      return r;
    }
  }
  private async sail(d: Design, progress: Progress): Promise<LaunchResult | null> {
    const cores = typeof navigator !== "undefined" ? navigator.hardwareConcurrency || 2 : 2;
    if (!this.pool || this.pool.broken) this.pool = new Pool(Math.max(1, Math.min(3, cores - 1)));
    const pool = this.pool;
    // Only the parts that differ from the planned build: the simulator fills in the rest, so a
    // slot the page knows and the published simulator doesn't yet (a new part, as planned) still sails.
    const choices = simChoices(d, this.planned?.());
    // Absolute: inside a worker a relative URL means the worker script's folder, not the page's.
    const base = new URL(this.base, location.href).href;
    let done = 0;
    pool.onProgress = (text) => progress(text, done, 6);
    let meta: SandboxMeta;
    const runs: SandboxRun[] = [];
    try {
      meta = await pool.ask<SandboxMeta>(0, { type: "meta", base, choices });
      const total = meta.launches.length;
      progress("Sailing...", 0, total);
      runs.length = total;
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
    } catch (e) {
      this.crash = pool.broken; // a crash or silence, as opposed to the simulator turning the design down
      pool.fail(e instanceof Error ? e : new Error(String(e))); // stop the other workers too
      throw e;
    }
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
        `Sandbox (${meta.note}): ${finished} of ${runs.length} voyages finished, run here in your browser. ` +
        "Browser runs can end differently from the same build run on our servers; the odds shown come from the server grid" +
        (grid?.odds ? (meta.exact ? " (this exact build)." : ` (the closest build we've run: ${grid.label}).`) : ", which hasn't run this build yet."),
      credits: SANDBOX_CREDITS,
      odds: grid?.odds ?? null,
      replays,
      fingerprints: runs.map((r) => r.fingerprint),
    };
  }
}

// ---------- a boat we can't vary yet: its as-built voyages ----------
/** Wilson 95% interval for k of n. */
export function wilson(k: number, n: number): [number, number] {
  if (!n) return [0, 1];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, mid - half), Math.min(1, mid + half)];
}

/**
 * The Randolph boats' last resort: when neither the simulator in the browser nor
 * the grid has their builds yet, a launch plays the boat's existing voyage replays
 * as built (public/voyages), with the grid's odds when the grid has the boat (Rev B),
 * else the count of those voyages. It says so plainly when the design differs from as built.
 */
export class AsBuiltLauncher implements Launcher {
  readonly name = "replays of the boat as built";
  constructor(
    private boat: string, // the replays' boat name, e.g. "Randolph Rev C"
    private long: string, // "our model of the Randolph team's Rev C"
    private asBuilt: (d: Design) => boolean,
    private grid: GridLauncher,
    private gridId: string | null,
    private voyages = "./voyages",
  ) {}
  async launch(d: Design): Promise<LaunchResult | null> {
    const idx = await fetch(`${this.voyages}/index.json`)
      .then((r) => (r.ok ? (r.json() as Promise<{ voyages: { file: string; boat: string; start: string; outcome: string; days: number }[] }>) : null))
      .catch(() => null);
    const mine = (idx?.voyages ?? []).filter((v) => v.boat === this.boat).sort((a, b) => a.start.localeCompare(b.start));
    if (!mine.length) return null;
    const replays = mine.map((v) => ({ url: `${this.voyages}/${v.file}`, start: v.start, outcome: v.outcome, days: v.days }));
    const g = this.gridId ? await this.grid.build(this.gridId) : null;
    let odds = g?.odds ?? null;
    if (!odds) {
      const fin = mine.filter((v) => v.outcome === "arrived");
      const [lo, hi] = wilson(fin.length, mine.length);
      const days = fin.map((v) => v.days).sort((a, b) => a - b);
      odds = { voyages: mine.length, finished: fin.length, odds: fin.length / mine.length, low95: lo, high95: hi, median_days: days.length ? days[Math.floor(days.length / 2)] : null };
    }
    const n = mine.length;
    const what = `${n} spring 2020 launches of ${this.long} as built${g?.odds ? `; odds over ${g.odds.voyages} simulated voyages` : ""}.`;
    return {
      exact: this.asBuilt(d),
      note: this.asBuilt(d)
        ? `Simulated as built: ${what}`
        : `Our servers haven't simulated this build of their boat yet, so these are ${what}`,
      odds,
      replays,
    };
  }
}
