/**
 * "Take the wheel" on the helm page (Rosa, Gameplay): the keys, the panel and the
 * summary around the pure sailing model in wheel.ts. helm.ts only starts and stops a
 * session, hands it the keys while it's on, and asks it each frame where the bow
 * points, how far the boat leans and how fast it goes.
 *
 * Phase 1 (Maya's rule): a spell never moves the voyage's boat. The voyage clock waits,
 * the spell is sailed and scored on its own, and the voyage carries on where it was.
 *
 * House rules: innerHTML only with constant strings; anything from data goes in with
 * textContent. Reduced motion is respected by the page's camera code, not here.
 */

import { CRUISER_HANDLING, Guide, PEARSON31_2_HANDLING, SAIL_WORDS, Wheel, type Handling, type TrimTable } from "./wheel";

/** Boats that can be sailed by hand, and their trim tables (written by vpp.py --trim). */
const TABLES: Record<string, { url: URL; handling: Handling; name: string }> = {
  stock_cruiser31: { url: new URL("../../../configs/polars/cruiser31_trim.json", import.meta.url), handling: CRUISER_HANDLING, name: "31 ft cruiser" },
  stock_pearson31_2: {
    url: new URL("../../../configs/polars/pearson31_2_trim.json", import.meta.url),
    handling: PEARSON31_2_HANDLING,
    name: "Pearson 31-2 (our model of Randolph's boat)",
  },
};

export const canTakeWheel = (boatKey: string): boolean => boatKey in TABLES;

const PLAN_WORDS: Record<string, string> = { full: "Full sail", reef1: "Reef 1", reef2: "Reef 2", storm: "Storm sails" };
const SPEEDS = [1, 2, 5, 10];
const BEST_KEY = "boatsim.wheel.best.v1";
const TAUGHT_KEY = "boatsim.wheel.taught.v1";
const KNOTS_PER_MS = 1.943844;

export interface WheelStart {
  boatKey: string;
  /** Where the bow points now, compass degrees. */
  heading: number;
  speedMs: number;
  /** Wind toward east and north, m/s (the simulator's wind_u, wind_v). */
  windU: number;
  windV: number;
  plan?: string | null;
}

export interface WheelFrame {
  heading: number;
  /** Lean, degrees: positive to port (wind from starboard). */
  heelDeg: number;
  speedMs: number;
  plan: string;
  sheet: number;
}

export interface WheelResult {
  metres: number;
  seconds: number;
  share: number;
  autopilot: number;
  best: number | null;
  reached: boolean;
  tacks: number;
  roundUps: number;
}

const tables = new Map<string, Promise<TrimTable>>();
function loadTable(key: string): Promise<TrimTable> {
  let p = tables.get(key);
  if (!p) {
    p = fetch(TABLES[key].url).then((r) => {
      if (!r.ok) throw new Error(`trim table ${r.status}`);
      return r.json() as Promise<TrimTable>;
    });
    p.catch(() => tables.delete(key));
    tables.set(key, p);
  }
  return p;
}

const el = <T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string) => root.querySelector(sel) as T;

/** One spell at the wheel. */
export class WheelSession {
  on = false;
  wheel: Wheel | null = null;
  private keys = { left: false, right: false, up: false, down: false };
  private speed = 1;
  private paused = false;
  private root: HTMLElement;
  private startedAt = 0;
  /** The guided first spell (Leo), until the player has done it or skipped it once. */
  guide: Guide | null = null;

  constructor(
    private readonly host: {
      /** The spell is over (or handed back): show the summary, restart the clock. */
      ended: (r: WheelResult) => void;
      /** A message for the notes column. */
      note: (text: string) => void;
    },
  ) {
    this.root = document.createElement("section");
    this.root.id = "wheel";
    this.root.className = "glass";
    this.root.hidden = true;
    this.root.setAttribute("aria-label", "At the wheel");
    // Constant markup only; every value below goes in by textContent.
    this.root.innerHTML = `
      <div class="w-top"><b>At the wheel</b> <span class="w-goal"></span>
        <span class="w-speeds" role="group" aria-label="How fast time runs">
          <button data-x="0" title="Pause (space bar)">❚❚</button><button data-x="1" title="Real time (key 1)">1×</button><button data-x="2" title="Twice as fast (key 2)">2×</button><button data-x="5" title="Five times (key 3)">5×</button><button data-x="10" title="Ten times (key 4)">10×</button>
        </span>
        <button class="w-back" title="Give the boat back to your orders (Esc)">Hand back</button></div>
      <div class="w-guide" hidden><span class="w-gtext"></span> <button class="w-gskip" title="Skip the guide">Skip</button></div>
      <div class="w-grid">
        <div><div class="w-lbl">Speed</div><div class="w-big w-speed"></div><div class="w-bar"><i class="w-best"></i><i class="w-now"></i></div><div class="w-sub w-bestt"></div></div>
        <div><div class="w-lbl">Sail <span class="w-plan"></span></div><div class="w-tell"></div>
          <div class="w-gauge" title="How far the sail is let out. Green: the sweet spot."><i class="w-band"></i><i class="w-needle"></i></div><div class="w-sub"><span>pulled in</span><span>let out</span></div></div>
        <div><div class="w-lbl">Leaning</div><div class="w-big w-heel"></div><div class="w-bar w-heelbar"><i class="w-now"></i><i class="w-max"></i></div><div class="w-sub w-heelt"></div></div>
        <div><div class="w-lbl">Wind</div><div class="w-big w-wind"></div><div class="w-sub w-twa"></div></div>
      </div>
      <div class="w-keys">←→ steer · ↑ pull the sail in · ↓ let it out · R reef · Shift+R shake out · T auto-trim (<span class="w-auto"></span>) · Esc hand back</div>
      <div class="w-btns"><button class="w-reef">Reef</button><button class="w-shake">Shake out</button><button class="w-autob" aria-pressed="false">Auto-trim</button></div>`;
    document.body.append(this.root);
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".w-speeds button"))) b.addEventListener("click", () => this.setSpeed(Number(b.dataset.x)));
    el(this.root, ".w-back").addEventListener("click", () => this.stop(false));
    el(this.root, ".w-reef").addEventListener("click", () => this.reef(1));
    el(this.root, ".w-shake").addEventListener("click", () => this.reef(-1));
    el(this.root, ".w-autob").addEventListener("click", () => this.toggleAuto());
    el(this.root, ".w-gskip").addEventListener("click", () => this.endGuide());
  }

  /** Start a spell: about 800 m on the course the boat was already sailing. */
  async start(s: WheelStart): Promise<boolean> {
    if (this.on || !canTakeWheel(s.boatKey)) return false;
    const spec = TABLES[s.boatKey];
    let table: TrimTable;
    try {
      table = await loadTable(s.boatKey);
    } catch {
      this.host.note("The sailing tables didn't load, so you can't take the wheel just now.");
      return false;
    }
    const tws = Math.hypot(s.windU, s.windV) * KNOTS_PER_MS;
    const from = (((Math.atan2(-s.windU, -s.windV) * 180) / Math.PI) % 360 + 360) % 360;
    this.wheel = new Wheel(
      table,
      spec.handling,
      { twsKn: tws, fromDeg: from },
      // She was sailing on autopilot until now, so start at the best speed for this heading
      // (a new game reports 0 kn through the water before its first step).
      { heading: s.heading, speedKn: undefined, plan: s.plan ?? undefined, autoTrim: localStorage.getItem("boatsim.wheel.auto") === "1" },
      { markM: 800, markBearing: s.heading }, // GUESS: 800 m, about 3 minutes at 1x (Leo: 2-4 minute spells)
    );
    this.on = true;
    this.paused = false;
    this.speed = 1;
    this.keys = { left: false, right: false, up: false, down: false };
    this.startedAt = performance.now();
    let taught = true;
    try {
      taught = localStorage.getItem(TAUGHT_KEY) === "1";
    } catch {
      /* private mode: guide every time is fine */
      taught = false;
    }
    this.guide = taught ? null : new Guide();
    this.root.hidden = false;
    document.body.classList.add("at-wheel");
    this.draw();
    return true;
  }

  /** End the spell: reached the mark, or handed back. */
  stop(reached: boolean): void {
    if (!this.on || !this.wheel) return;
    const w = this.wheel;
    const share = w.share();
    let best: number | null = null;
    try {
      best = Number(localStorage.getItem(BEST_KEY)) || null;
      if (w.s.sumSecs > 20 && share > (best ?? 0)) localStorage.setItem(BEST_KEY, String(share));
    } catch {
      /* private mode: no personal best */
    }
    this.on = false;
    this.root.hidden = true;
    document.body.classList.remove("at-wheel");
    this.host.ended({
      metres: Math.hypot(w.s.x, w.s.y),
      seconds: w.s.t,
      share,
      autopilot: w.table.autopilot_factor,
      best,
      reached,
      tacks: w.s.tacks,
      roundUps: w.s.roundUps,
    });
  }

  private setSpeed(x: number): void {
    if (x === 0) this.paused = !this.paused;
    else {
      this.speed = x;
      this.paused = false;
    }
    this.draw();
  }

  private reef(dir: 1 | -1): void {
    if (this.wheel?.reef(dir)) {
      this.guide?.reefed();
      this.draw();
    }
  }

  private endGuide(): void {
    this.guide = null;
    try {
      localStorage.setItem(TAUGHT_KEY, "1");
    } catch {
      /* fine */
    }
    this.lastDraw = 0;
    this.draw();
  }

  private toggleAuto(): void {
    if (!this.wheel) return;
    this.wheel.s.autoTrim = !this.wheel.s.autoTrim;
    try {
      localStorage.setItem("boatsim.wheel.auto", this.wheel.s.autoTrim ? "1" : "0");
    } catch {
      /* fine */
    }
    this.draw();
  }

  /** A key while at the wheel. Returns true if it was ours (the page then ignores it). */
  key(e: KeyboardEvent, down: boolean): boolean {
    const k = e.code;
    const arrows: Record<string, keyof WheelSession["keys"]> = { ArrowLeft: "left", KeyA: "left", ArrowRight: "right", KeyD: "right", ArrowUp: "up", KeyW: "up", ArrowDown: "down", KeyS: "down" };
    if (arrows[k]) {
      this.keys[arrows[k]] = down;
      return true;
    }
    if (!down) return k === "KeyR" || k === "KeyT" || k === "Escape" || k === "Space";
    if (e.repeat) return true;
    if (k === "Escape") this.stop(false);
    else if (k === "KeyR") this.reef(e.shiftKey ? -1 : 1);
    else if (k === "KeyT") this.toggleAuto();
    else if (k === "Space") this.setSpeed(0);
    else if (/^(Digit|Numpad)[1-4]$/.test(k)) this.setSpeed(SPEEDS[Number(k.slice(-1)) - 1]);
    else return false;
    return true;
  }

  /** Window lost focus: let go of the wheel and the sheet. */
  release(): void {
    this.keys = { left: false, right: false, up: false, down: false };
  }

  /** One frame (dt in real seconds). Returns what the 3D view should show. */
  frame(dt: number): WheelFrame | null {
    const w = this.wheel;
    if (!this.on || !w) return null;
    if (!this.paused) {
      const total = Math.min(dt, 0.1) * this.speed;
      const n = Math.max(1, Math.ceil(total / 0.05));
      const inp = { helm: (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0), sheet: (this.keys.down ? 1 : 0) - (this.keys.up ? 1 : 0) };
      for (let i = 0; i < n; i++) {
        w.step(total / n, inp);
        this.guide?.update(w, total / n);
      }
      if (this.guide?.done) this.endGuide();
      if (w.s.done) {
        this.draw();
        this.stop(true);
        return null;
      }
    }
    this.draw();
    return { heading: w.s.heading, heelDeg: w.heelSigned(), speedMs: w.s.speedKn / KNOTS_PER_MS, plan: w.s.plan, sheet: w.s.sheet };
  }

  private lastDraw = 0;
  private draw(): void {
    const w = this.wheel;
    if (!w) return;
    const now = performance.now();
    if (now - this.lastDraw < 66 && this.on) return; // 15 a second is plenty for text
    this.lastDraw = now;
    const r = this.root;
    const b = w.best();
    const st = w.sailState();
    const toGo = w.distToMark();
    const g = el(r, ".w-guide");
    g.hidden = !this.guide;
    if (this.guide) el(r, ".w-gtext").textContent = this.guide.text;
    el(r, ".w-goal").textContent = `${toGo >= 1000 ? `${(toGo / 1000).toFixed(1)} km` : `${Math.round(toGo / 10) * 10} m`} to the mark`;
    for (const btn of Array.from(r.querySelectorAll<HTMLButtonElement>(".w-speeds button"))) {
      const x = Number(btn.dataset.x);
      btn.setAttribute("aria-pressed", String(x === 0 ? this.paused : !this.paused && x === this.speed));
    }
    el(r, ".w-speed").textContent = `${w.s.speedKn.toFixed(1)} kn`;
    el(r, ".w-bestt").textContent = b.speedKn > 0.2 ? `best on this heading ${b.speedKn.toFixed(1)} kn` : "no sailing this close to the wind";
    const top = Math.max(b.speedKn, w.s.speedKn, 1) * 1.15;
    el(r, ".w-bar .w-now").style.width = `${(w.s.speedKn / top) * 100}%`;
    el(r, ".w-bar .w-best").style.left = `${(b.speedKn / top) * 100}%`;
    el(r, ".w-plan").textContent = `(${PLAN_WORDS[w.s.plan] ?? w.s.plan}${w.s.reefing > 0 ? ", changing..." : ""})`;
    const tell = el(r, ".w-tell");
    tell.textContent = w.s.autoTrim ? "Auto-trim is setting the sail" : SAIL_WORDS[st];
    tell.dataset.state = w.s.autoTrim ? "good" : st;
    const s0 = w.table.sheet_deg[0];
    const s1 = w.table.sheet_deg[w.table.sheet_deg.length - 1];
    const pos = (x: number) => `${((x - s0) / (s1 - s0)) * 100}%`;
    const band = el(r, ".w-band");
    band.hidden = b.speedKn <= 0.2;
    band.style.left = pos(b.lo);
    band.style.width = `${Math.max(((b.hi - b.lo) / (s1 - s0)) * 100, 1.5)}%`;
    el(r, ".w-needle").style.left = pos(w.s.sheet);
    const heel = w.s.heelDeg;
    const hmax = w.table.heel_max_deg;
    el(r, ".w-heel").textContent = `${Math.round(heel)}°`;
    el(r, ".w-heelbar .w-now").style.width = `${Math.min(heel / (hmax + 15), 1) * 100}%`;
    el(r, ".w-heelbar .w-max").style.left = `${(hmax / (hmax + 15)) * 100}%`;
    el(r, ".w-heelt").textContent = w.s.overNow ? "Too much sail: she's rounding up. Ease out or reef (R)" : heel > hmax * 0.8 ? "Leaning hard: think about a reef" : "";
    r.classList.toggle("over", w.s.overNow);
    el(r, ".w-wind").textContent = `${Math.round(w.wind.twsKn)} kn`;
    const twa = w.twa();
    const side = twa >= 0 ? "starboard (right)" : "port (left)";
    const a = Math.abs(twa);
    const sailing = a < 40 ? "too close to the wind: turn away" : a < 70 ? "close-hauled (sailing toward the wind)" : a < 120 ? "a reach (wind from the side)" : a < 160 ? "a broad reach (wind from behind)" : "running (wind dead behind)";
    el(r, ".w-twa").textContent = `${Math.round(a)}° off the bow on the ${side}: ${sailing}`;
    el(r, ".w-auto").textContent = w.s.autoTrim ? "on" : "off";
    el(r, ".w-autob").setAttribute("aria-pressed", String(w.s.autoTrim));
    el<HTMLButtonElement>(r, ".w-shake").disabled = w.plans.indexOf(w.s.plan) === 0 || w.s.reefing > 0;
    el<HTMLButtonElement>(r, ".w-reef").disabled = w.plans.indexOf(w.s.plan) === w.plans.length - 1 || w.s.reefing > 0;
  }

  /** Seconds of real time since the spell began (for the page's checks). */
  get realSeconds(): number {
    return this.on ? (performance.now() - this.startedAt) / 1000 : 0;
  }
}

/** The spell's payoff line (Leo: the summary is the reward). */
export function summary(r: WheelResult): string {
  const km = r.metres >= 1000 ? `${(r.metres / 1000).toFixed(2)} km` : `${Math.round(r.metres)} m`;
  const mins = Math.floor(r.seconds / 60);
  const secs = Math.round(r.seconds % 60);
  const pct = Math.round(r.share * 100);
  const ap = Math.round(r.autopilot * 100);
  const vs = pct > ap ? `better than the autopilot's ${ap}%` : pct === ap ? `level with the autopilot's ${ap}%` : `the autopilot manages ${ap}%`;
  const pb = r.best && r.seconds > 20 ? (r.share > r.best ? " A new personal best!" : ` Your best: ${Math.round(r.best * 100)}%.`) : "";
  const extra = [r.tacks ? `${r.tacks} tack${r.tacks > 1 ? "s" : ""}` : "", r.roundUps ? `rounded up ${r.roundUps} time${r.roundUps > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  return `${r.reached ? "Mark reached!" : "Handed back."} You sailed ${km} in ${mins} min ${secs} s at ${pct}% of the boat's best speed (${vs}).${extra ? ` ${extra[0].toUpperCase()}${extra.slice(1)}.` : ""}${pb} Your voyage waits while you sail; for now a spell doesn't change it.`;
}
