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

import { depthState, type DepthState } from "../land/depth";
import { CRUISER_HANDLING, Guide, PEARSON31_2_HANDLING, SAIL_WORDS, Wheel, type Handling, type TrimTable } from "./wheel";

/** Boats that can be sailed by hand, their trim tables (written by vpp.py --trim) and their drafts (from their configs). */
const TABLES: Record<string, { url: URL; handling: Handling; name: string; draftM: number }> = {
  // configs/stock_cruiser31.yaml (deep-keel First 31.7)
  stock_cruiser31: { url: new URL("../../../configs/polars/cruiser31_trim.json", import.meta.url), handling: CRUISER_HANDLING, name: "31 ft cruiser", draftM: 1.9 },
  stock_pearson31_2: {
    url: new URL("../../../configs/polars/pearson31_2_trim.json", import.meta.url),
    handling: PEARSON31_2_HANDLING,
    name: "Pearson 31-2 (our model of Randolph's boat)",
    draftM: 1.71, // configs: the deep-keel version
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
  /** Where the mark is (default: dead ahead). */
  markBearing?: number;
  /** A practice course instead: marks in order (metres east and north of the start), the last the finish. */
  course?: { marks: { x: number; y: number; name: string; gate?: [{ x: number; y: number }, { x: number; y: number }] }[]; radiusM: number };
  /** Practice off Annapolis: the ground's height (m, - is depth) at metres east and north of the start; null = not known there. */
  depthAt?: (x: number, y: number) => number | null;
  /** How fast time runs at first (default 1x), and the hand-back button's words (default "Hand back"). */
  speed?: number;
  backLabel?: string;
}

export interface WheelFrame {
  heading: number;
  /** Lean, degrees: positive to port (wind from starboard). */
  heelDeg: number;
  speedMs: number;
  plan: string;
  sheet: number;
  /** Metres east and north of where the spell began. */
  x: number;
  y: number;
}

export interface WheelResult {
  metres: number;
  seconds: number;
  share: number;
  /** Seconds the share was measured over (under sail, with a speed to compare). */
  sailedSecs: number;
  autopilot: number;
  best: number | null;
  reached: boolean;
  tacks: number;
  roundUps: number;
  /** Ran into shallow water (practice off Annapolis). */
  aground: boolean;
  /** On a course: when (s) each mark was reached, and how many there were. */
  markTimes: number[];
  marks: number;
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
  private top: HTMLElement;
  private help = false;
  /** H: the strip and banner hidden (the keys still work). */
  private bare = false;
  private startedAt = 0;
  /** The guided first spell (Leo), until the player has done it or skipped it once. */
  guide: Guide | null = null;
  private course: WheelStart["course"] = undefined;
  private depthAt: WheelStart["depthAt"] = undefined;
  private draftM = 2;
  /** The water under her now (practice with depths only), for the panel and tests. */
  depth: { state: DepthState; m: number | null } = { state: "unknown", m: null };

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
      <div class="w-guide" hidden><span class="w-gtext"></span> <button class="w-gskip" title="Skip the guide">Skip</button></div>
      <div class="w-strip">
        <div class="w-cell" title="Speed through the water; the tick is the best she can do on this heading"><span class="w-lbl">speed</span> <b class="w-speed"></b><div class="w-bar"><i class="w-best"></i><i class="w-now"></i></div><span class="w-sub w-bestt"></span></div>
        <div class="w-cell" title="How far the sail is let out. Green: the sweet spot."><span class="w-lbl">sail</span> <span class="w-tell"></span> <span class="w-sub w-plan"></span><div class="w-gauge"><i class="w-band"></i><i class="w-needle"></i></div></div>
        <div class="w-cell" title="How far she leans; the red tick is too far"><span class="w-lbl">heel</span> <b class="w-heel"></b> <span class="w-sub w-heelt"></span><div class="w-bar w-heelbar"><i class="w-now"></i><i class="w-max"></i></div></div>
        <div class="w-cell" title="The true wind"><span class="w-lbl">wind</span> <b class="w-wind"></b> <span class="w-sub w-twa"></span></div>
        <div class="w-cell w-ctl">
          <span class="w-speeds" role="group" aria-label="How fast time runs">
            <button data-x="0" title="Pause (space bar)">❚❚</button><button data-x="1" title="Real time (key 1)">1×</button><button data-x="2" title="Twice as fast (key 2)">2×</button><button data-x="5" title="Five times (key 3)">5×</button><button data-x="10" title="Ten times (key 4)">10×</button>
          </span>
          <button class="w-back" title="Give the boat back (Esc)">Hand back</button>
          <button class="w-help" aria-expanded="false" title="Keys and buttons (?)">?</button>
        </div>
      </div>
      <div class="w-more" hidden>
        <span class="w-keys" title="↑ pulls the sail in, ↓ lets it out · Shift+R shakes out a reef · V switches camera · H hides the panels · Space pauses · 1-4 time speed">←→ steer · ↑↓ sail · R reef · T auto-trim (<span class="w-auto"></span>) · Esc hand back</span>
        <span class="w-btns"><button class="w-reef">Reef</button><button class="w-shake">Shake out</button><button class="w-autob" aria-pressed="false">Auto-trim</button></span>
      </div>`;
    // The goal (and the depth, off Annapolis) go in a slim banner at the top (Elena).
    this.top = document.createElement("div");
    this.top.id = "wheel-goal";
    this.top.className = "glass";
    this.top.hidden = true;
    this.top.innerHTML = `<span class="w-goal"><span class="w-gname"></span><span class="w-num"></span><span class="w-gwhere"></span></span> <span class="w-depth" hidden></span>`;
    document.body.append(this.top);
    document.body.append(this.root);
    for (const b of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".w-speeds button"))) b.addEventListener("click", () => this.setSpeed(Number(b.dataset.x)));
    el(this.root, ".w-back").addEventListener("click", () => this.stop(false));
    el(this.root, ".w-reef").addEventListener("click", () => this.reef(1));
    el(this.root, ".w-shake").addEventListener("click", () => this.reef(-1));
    el(this.root, ".w-autob").addEventListener("click", () => this.toggleAuto());
    el(this.root, ".w-gskip").addEventListener("click", () => this.endGuide());
    el(this.root, ".w-help").addEventListener("click", () => this.toggleHelp());
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
    // The trim table stops at its strongest wind (40 kn on the cruiser): beyond it we'd be guessing.
    const top = table.tws_kn[table.tws_kn.length - 1];
    if (tws > top) {
      this.host.note(`${Math.round(tws)} knots of wind is too much to hand-steer here (our sailing tables stop at ${top}); the autopilot keeps her for now.`);
      return false;
    }
    const from = (((Math.atan2(-s.windU, -s.windV) * 180) / Math.PI) % 360 + 360) % 360;
    this.wheel = new Wheel(
      table,
      spec.handling,
      { twsKn: tws, fromDeg: from },
      // She was sailing on autopilot until now, so start at the best speed for this heading
      // (a new game reports 0 kn through the water before its first step).
      { heading: s.heading, speedKn: undefined, plan: s.plan ?? undefined, autoTrim: localStorage.getItem("boatsim.wheel.auto") === "1" },
      // GUESS: 800 m, about 3 minutes at 1x (Leo: 2-4 minute spells)
      { markM: 800, markBearing: s.markBearing ?? s.heading, marks: s.course?.marks, markRadiusM: s.course?.radiusM },
    );
    this.course = s.course;
    this.depthAt = s.depthAt;
    this.draftM = spec.draftM;
    this.depth = { state: "unknown", m: null };
    this.on = true;
    this.paused = false;
    this.speed = s.speed && SPEEDS.includes(s.speed) ? s.speed : 1;
    el(this.root, ".w-back").textContent = s.backLabel ?? "Hand back";
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
    this.root.hidden = this.bare;
    this.top.hidden = this.bare;
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
    this.top.hidden = true;
    document.body.classList.remove("at-wheel");
    this.host.ended({
      metres: Math.hypot(w.s.x, w.s.y),
      seconds: w.s.t,
      share,
      sailedSecs: w.s.sumSecs,
      autopilot: w.table.autopilot_factor,
      best,
      reached,
      tacks: w.s.tacks,
      roundUps: w.s.roundUps,
      aground: w.s.aground,
      markTimes: [...w.s.markTimes],
      marks: this.course?.marks.length ?? 1,
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

  private toggleHelp(): void {
    this.help = !this.help;
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
    if (!down) return k === "KeyR" || k === "KeyT" || k === "Escape" || k === "Space" || k === "KeyH" || k === "Slash";
    if (e.repeat) return true;
    if (k === "Escape") this.stop(false);
    else if (k === "KeyR") this.reef(e.shiftKey ? -1 : 1);
    else if (k === "KeyT") this.toggleAuto();
    else if (k === "Slash" || k === "KeyK") this.toggleHelp();
    else if (k === "KeyH") {
      this.bare = !this.bare;
      this.root.hidden = this.bare;
      this.top.hidden = this.bare;
    }
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
      if (this.depthAt) {
        this.sound(w);
        if (this.depth.state === "aground" && !w.s.done) w.ground();
      }
      if (w.s.done) {
        this.draw();
        this.stop(!w.s.aground);
        return null;
      }
    }
    if (this.depthAt && this.paused) this.sound(w); // the reading still catches up while paused
    this.draw();
    return { heading: w.s.heading, heelDeg: w.heelSigned(), speedMs: w.s.speedKn / KNOTS_PER_MS, plan: w.s.plan, sheet: w.s.sheet, x: w.s.x, y: w.s.y };
  }

  /** The goal banner: white words, the distance in green (Elena). */
  private goal(name: string, num: string, where: string): void {
    el(this.top, ".w-gname").textContent = name;
    el(this.top, ".w-num").textContent = num;
    el(this.top, ".w-gwhere").textContent = where;
  }

  /** Read the depth under her (a sounding). */
  private sound(w: Wheel): void {
    const h = this.depthAt!(w.s.x, w.s.y);
    this.depth = { state: depthState(h, this.draftM), m: h == null ? null : -h };
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
    const more = el(r, ".w-more");
    more.hidden = !(this.help || this.guide);
    el(r, ".w-help").setAttribute("aria-expanded", String(!more.hidden));
    const g = el(r, ".w-guide");
    g.hidden = !this.guide;
    if (this.guide) el(r, ".w-gtext").textContent = this.guide.text;
    const dist = toGo >= 1000 ? `${(toGo / 1000).toFixed(1)} km` : `${Math.round(toGo / 10) * 10} m`;
    if (this.course) {
      const k = this.course.marks[Math.min(w.s.mark, this.course.marks.length - 1)];
      this.goal(`${k.name[0].toUpperCase()}${k.name.slice(1)}: `, dist, `, ${aside(w.markBearing() - w.s.heading)}`);
    } else this.goal("", dist, " to the mark");
    const dep = el(this.top, ".w-depth");
    dep.hidden = !this.depthAt;
    if (this.depthAt) {
      const d = this.depth;
      dep.dataset.state = d.state;
      dep.textContent =
        d.state === "unknown" ? "Depth: not known here yet (the chart is still loading)" : d.state === "shallow" ? `Shallow water: ${d.m!.toFixed(1)} m. Steer for deeper water` : `Depth ${Math.round(d.m!)} m`;
    }
    for (const btn of Array.from(r.querySelectorAll<HTMLButtonElement>(".w-speeds button"))) {
      const x = Number(btn.dataset.x);
      btn.setAttribute("aria-pressed", String(x === 0 ? this.paused : !this.paused && x === this.speed));
    }
    el(r, ".w-speed").textContent = `${w.s.speedKn.toFixed(1)} kn`;
    el(r, ".w-bestt").textContent = b.speedKn > 0.2 ? `best ${b.speedKn.toFixed(1)}` : "too close to the wind";
    const top = Math.max(b.speedKn, w.s.speedKn, 1) * 1.15;
    el(r, ".w-bar .w-now").style.width = `${(w.s.speedKn / top) * 100}%`;
    el(r, ".w-bar .w-best").style.left = `${(b.speedKn / top) * 100}%`;
    el(r, ".w-plan").textContent = w.s.plan === w.plans[0] && !w.s.reefing ? "" : `${PLAN_WORDS[w.s.plan] ?? w.s.plan}${w.s.reefing > 0 ? ", changing..." : ""}`;
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
    el(r, ".w-heelt").textContent = w.s.overNow ? "too much sail: ease out or reef (R)" : heel > hmax * 0.8 ? "leaning hard: reef?" : "";
    r.classList.toggle("over", w.s.overNow);
    el(r, ".w-wind").textContent = `${Math.round(w.wind.twsKn)} kn`;
    const twa = w.twa();
    const side = twa >= 0 ? "right" : "left";
    const a = Math.abs(twa);
    const sailing = a < 40 ? "too close: turn away" : a < 70 ? `upwind, ${side}` : a < 120 ? `reach, ${side}` : a < 160 ? `behind, ${side}` : "dead behind";
    el(r, ".w-twa").textContent = sailing;
    el(r, ".w-twa").title = `${Math.round(a)}° off the bow`;
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

/** Where something is, from the bow: "ahead", "to the right", "behind you". */
export function aside(rel: number): string {
  const a = ((((rel + 180) % 360) + 360) % 360) - 180;
  const side = a > 0 ? "right" : "left";
  const m = Math.abs(a);
  return m < 15 ? "dead ahead" : m < 60 ? `ahead to the ${side}` : m < 120 ? `to the ${side}` : m < 165 ? `behind you to the ${side}` : "behind you";
}

/** The spell's payoff line (Leo: the summary is the reward). */
/** A spell counts in the voyage (phase 2) after a minute under sail (GUESS, Theo/Sam). */
export const COUNTS_AFTER_S = 60;

/** counts: the simulator took the spell's trim for the next watch (null: it can't, or it was too short). */
export function summary(r: WheelResult, counts: { hours: number } | null = null): string {
  const km = r.metres >= 1000 ? `${(r.metres / 1000).toFixed(2)} km` : `${Math.round(r.metres)} m`;
  const mins = Math.floor(r.seconds / 60);
  const secs = Math.round(r.seconds % 60);
  const pct = Math.round(r.share * 100);
  const ap = Math.round(r.autopilot * 100);
  const vs = r.sailedSecs < 20 ? "too short to compare with the autopilot" : pct > ap ? `better than the autopilot's ${ap}%` : pct === ap ? `level with the autopilot's ${ap}%` : `the autopilot manages ${ap}%`;
  const pb = r.best && r.seconds > 20 ? (r.share > r.best ? " A new personal best!" : ` Your best: ${Math.round(r.best * 100)}%.`) : "";
  const extra = [r.tacks ? `${r.tacks} tack${r.tacks > 1 ? "s" : ""}` : "", r.roundUps ? `rounded up ${r.roundUps} time${r.roundUps > 1 ? "s" : ""}` : ""].filter(Boolean).join(", ");
  return `${r.reached ? "Mark reached!" : "Handed back."} You sailed ${km} in ${mins} min ${secs} s at ${pct}% of the boat's best speed (${vs}).${extra ? ` ${extra[0].toUpperCase()}${extra.slice(1)}.` : ""}${pb} ${
    counts
      ? `For the next ${counts.hours} hours of the voyage your boat sails trimmed like that, instead of the autopilot's ${ap}%.`
      : r.sailedSecs < COUNTS_AFTER_S
        ? "Sail at least a minute and your trimming counts in the voyage for the next watch."
        : "Your voyage waited while you sailed; this simulator can't count a spell yet."
  }`;
}
