/**
 * "Take the wheel" (Rosa, Gameplay): sail the boat yourself in real time. You hold the
 * rudder, pull the sails in or ease them out, and reef in strong wind. Plan:
 * /mnt/project-files/simulator/gameplay/hands-on-sailing-plan.md, reviewed by Leo.
 *
 * Honest by construction: the boat's speed and heel for any sheet come from the trim
 * table that Theo's VPP writes (python -m boatsim.vessel.vpp <design> --trim), the same
 * force balance as the polar the voyage sails. At the best sheet you sail the polar;
 * no input sails faster. On top of it sits a little real-time motion (how quickly the
 * boat speeds up, turns and heels), whose numbers are marked GUESS.
 *
 * This is a pure model: no DOM, no three.js, no clock. The page feeds it the keys and
 * frame times and draws what it says (tests/wheel.test.ts drives it directly).
 * Phase 1: a spell doesn't move the voyage's boat; the simulator stays the only thing
 * that does (Maya's rule). The spell is scored on its own.
 */

export const KNOT = 0.514444;

export interface TrimPlan {
  main: number;
  jib: number;
  /** [tws][twa][sheet] */
  speed_kn: number[][][];
  heel_deg: number[][][];
  leeway_deg: number[][][];
  overpowered: number[][][];
}

export interface TrimTable {
  tws_kn: number[];
  twa_deg: number[];
  sheet_deg: number[];
  alpha_stall_deg: number;
  heel_max_deg: number;
  autopilot_factor: number;
  disp_kg: number;
  plans: Record<string, TrimPlan>;
}

/** Real-time handling of one boat. Every number here is a GUESS for feel, not physics. */
export interface Handling {
  /** Rudder hard over at `refSpeedKn` turns the boat this fast, deg/s. */
  turnDegS: number;
  refSpeedKn: number;
  /** Seconds for the rudder to go from centre to hard over (Leo: about 0.3 s). */
  rudderS: number;
  /** Seconds to close most of the gap to the table's speed, speeding up and slowing down. */
  accelS: number;
  decelS: number;
  /** Speed lost to a rudder held hard over (share of the table's speed). */
  rudderDrag: number;
  /** How fast the sheet moves while a key is held, deg/s. */
  sheetDegS: number;
  /** Seconds to tuck in or shake out a reef; the sails are half useful meanwhile. */
  reefS: number;
  /** Overpowered: the boat rounds up toward the wind at this rate, deg/s, and loses speed. */
  roundUpDegS: number;
  roundUpLoss: number;
  /** In irons (pointing into the wind, stopped), the bow falls off at this rate, deg/s. */
  fallOffDegS: number;
}

// GUESS: a 31 ft cruiser tacks through 90 degrees in about 12 s at 5 knots, and takes
// about 20 s to get going again after a tack.
export const CRUISER_HANDLING: Handling = {
  turnDegS: 7,
  refSpeedKn: 5,
  rudderS: 0.3,
  accelS: 8,
  decelS: 5,
  rudderDrag: 0.25,
  sheetDegS: 25,
  reefS: 4,
  roundUpDegS: 6,
  roundUpLoss: 0.35,
  fallOffDegS: 4,
};

// GUESS: the Pearson 31-2 (our model of Randolph's boat) is 17 % heavier on a shorter
// waterline: a touch slower to turn and to get going again than the cruiser.
export const PEARSON31_2_HANDLING: Handling = {
  ...CRUISER_HANDLING,
  turnDegS: 6,
  accelS: 10,
  decelS: 6,
};

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;
const wrap360 = (a: number) => ((a % 360) + 360) % 360;

/** Where x falls in a sorted axis: index i and weight f of axis[i+1] (clamped at the ends). */
function locate(axis: number[], x: number): [number, number] {
  const n = axis.length;
  if (x <= axis[0]) return [0, 0];
  if (x >= axis[n - 1]) return [n - 2, 1];
  let i = 0;
  while (axis[i + 1] < x) i++;
  return [i, (x - axis[i]) / (axis[i + 1] - axis[i])];
}

function tri(t: TrimTable, grid: number[][][], tws: number, twa: number, sheet: number): number {
  const [i, fi] = locate(t.tws_kn, tws);
  const [j, fj] = locate(t.twa_deg, twa);
  const [k, fk] = locate(t.sheet_deg, sheet);
  let out = 0;
  for (const [a, wa] of [[i, 1 - fi], [i + 1, fi]] as const)
    for (const [b, wb] of [[j, 1 - fj], [j + 1, fj]] as const)
      for (const [c, wc] of [[k, 1 - fk], [k + 1, fk]] as const) {
        const w = wa * wb * wc;
        if (w) out += w * grid[a][b][c];
      }
  return out;
}

export interface Look {
  speedKn: number;
  heelDeg: number;
  /** 0..1: how overpowered (the table's flag, interpolated). */
  over: number;
}

/**
 * The table at any wind speed (kn), true wind angle off the bow (deg, either side) and
 * sheet (deg to the centreline). Below the table's lightest wind, speed scales with the
 * wind; pointing closer than the table's first angle, the sails can only flap.
 */
export function look(t: TrimTable, plan: string, twsKn: number, twaDeg: number, sheetDeg: number): Look {
  const p = t.plans[plan];
  const twa = Math.abs(wrap180(twaDeg));
  const lightest = t.tws_kn[0];
  const scale = twsKn < lightest ? Math.max(0, twsKn) / lightest : 1;
  const w = Math.max(twsKn, lightest);
  const lo = t.twa_deg[0];
  // In irons: closer than the table starts (30 deg) the sails flap; GUESS: fade to nothing by 20 deg.
  const irons = twa >= lo ? 1 : clamp((twa - 20) / (lo - 20), 0, 1);
  const a = Math.max(twa, lo);
  return {
    speedKn: tri(t, p.speed_kn, w, a, sheetDeg) * scale * irons,
    heelDeg: tri(t, p.heel_deg, w, a, sheetDeg) * scale * scale * irons,
    over: scale < 1 ? 0 : tri(t, p.overpowered, w, a, sheetDeg) * irons,
  };
}

/** The best sheet (fastest without being overpowered), to 1 degree, and its speed. */
export function bestSheet(t: TrimTable, plan: string, twsKn: number, twaDeg: number): { sheet: number; speedKn: number; lo: number; hi: number } {
  const s0 = t.sheet_deg[0];
  const s1 = t.sheet_deg[t.sheet_deg.length - 1];
  let best = { sheet: s1, speedKn: -1 };
  const speeds: [number, number][] = [];
  for (let s = s0; s <= s1 + 1e-9; s += 1) {
    const l = look(t, plan, twsKn, twaDeg, s);
    const v = l.over > 0.5 ? -1 : l.speedKn;
    speeds.push([s, v]);
    if (v > best.speedKn) best = { sheet: s, speedKn: v };
  }
  // The sweet spot (Leo's green band): every sheet within 3 % of the best.
  const good = speeds.filter(([, v]) => v >= best.speedKn * 0.97 && best.speedKn > 0).map(([s]) => s);
  const lo = good.length ? Math.min(...good) : best.sheet;
  const hi = good.length ? Math.max(...good) : best.sheet;
  return { sheet: best.sheet, speedKn: Math.max(0, best.speedKn), lo, hi };
}

/** The sails as the telltales show them, in words a non-sailor can act on. */
export type SailState = "flapping" | "ease" | "good" | "in" | "stalled";
export const SAIL_WORDS: Record<SailState, string> = {
  flapping: "Flapping: pull the sail in (Up)",
  in: "Drawing, a little loose: pull in (Up)",
  good: "Drawing well",
  ease: "Drawing, a little tight: ease out (Down)",
  stalled: "Stalled: ease the sail out (Down)",
};

export interface Inputs {
  /** -1 (left) .. 1 (right): the key held now. 0 lets the rudder centre. */
  helm: number;
  /** -1 pull in, +1 ease out, 0 hold. */
  sheet: number;
}

export interface Wind {
  /** True wind speed, knots, and the compass direction it blows FROM. */
  twsKn: number;
  fromDeg: number;
}

export interface Spell {
  /** The goal: a mark this far away, on this bearing from the start. */
  markM: number;
  markBearing: number;
  /** A course instead (practice off Annapolis): marks to reach in order, metres east and north of the start. */
  marks?: { x: number; y: number }[];
  /** How close counts as reaching a mark (default 40 m). */
  markRadiusM?: number;
}

export interface WheelState {
  t: number; // seconds sailed
  heading: number; // compass degrees
  speedKn: number;
  heelDeg: number;
  rudder: number; // -1..1
  sheet: number; // deg to the centreline
  plan: string;
  reefing: number; // seconds left of a reef change
  x: number; // metres east of the start
  y: number; // metres north
  autoTrim: boolean;
  /** Seconds sailed at each share of the best speed, for the score. */
  sumShare: number;
  sumSecs: number;
  roundUps: number;
  overNow: boolean;
  tacks: number;
  side: -1 | 1; // which side the wind is on (port -1, starboard +1)
  done: boolean;
  /** On a course: the mark sailing for now, and the time (s) each one was reached. */
  mark: number;
  markTimes: number[];
  /** Ended in water too shallow for her keel. */
  aground: boolean;
}

export class Wheel {
  s: WheelState;
  readonly plans: string[];

  constructor(
    readonly table: TrimTable,
    readonly h: Handling,
    public wind: Wind,
    start: { heading: number; speedKn?: number; plan?: string; autoTrim?: boolean },
    readonly spell: Spell,
  ) {
    this.plans = Object.keys(table.plans);
    const plan = start.plan && table.plans[start.plan] ? start.plan : this.plans[0];
    const twa = this.twa(start.heading);
    const b = bestSheet(table, plan, wind.twsKn, twa);
    this.s = {
      t: 0,
      heading: wrap360(start.heading),
      speedKn: start.speedKn ?? b.speedKn,
      heelDeg: 0,
      rudder: 0,
      sheet: b.sheet,
      plan,
      reefing: 0,
      x: 0,
      y: 0,
      autoTrim: start.autoTrim ?? false,
      sumShare: 0,
      sumSecs: 0,
      roundUps: 0,
      overNow: false,
      tacks: 0,
      side: wrap180(wind.fromDeg - start.heading) >= 0 ? 1 : -1,
      done: false,
      mark: 0,
      markTimes: [],
      aground: false,
    };
  }

  /** True wind angle off the bow, -180..180 (positive: wind on the starboard side). */
  twa(heading = this.s.heading): number {
    return wrap180(this.wind.fromDeg - heading);
  }

  /** The apparent wind angle (deg, 0..180) the sails feel at the boat's speed now. */
  awa(): number {
    const tws = this.wind.twsKn;
    const a = (Math.abs(this.twa()) * Math.PI) / 180;
    const v = Math.max(this.s.speedKn, 0);
    return (Math.atan2(tws * Math.sin(a), tws * Math.cos(a) + v) * 180) / Math.PI;
  }

  best(): ReturnType<typeof bestSheet> {
    return bestSheet(this.table, this.s.plan, this.wind.twsKn, this.twa());
  }

  sailState(): SailState {
    const alpha = this.awa() - this.s.sheet;
    if (alpha < 2) return "flapping";
    // Judged against the sweet spot, not the raw angle: running before the wind the best
    // trim is a stalled sail (it pushes by drag), so "stalled" means too tight for here.
    const b = this.best();
    if (this.s.sheet >= b.lo - 0.5 && this.s.sheet <= b.hi + 0.5) return "good";
    if (this.s.sheet > b.hi) return "in";
    return alpha > this.table.alpha_stall_deg + 4 ? "stalled" : "ease";
  }

  /** Tuck in a reef (deeper = +1) or shake one out (-1). */
  reef(dir: 1 | -1): boolean {
    const i = this.plans.indexOf(this.s.plan) + dir;
    if (i < 0 || i >= this.plans.length || this.s.reefing > 0) return false;
    this.s.plan = this.plans[i];
    this.s.reefing = this.h.reefS;
    return true;
  }

  /** Where the mark sailed for now is, metres east and north of the start. */
  markXY(): { x: number; y: number } {
    const m = this.spell.marks;
    if (m?.length) return m[Math.min(this.s.mark, m.length - 1)];
    const b = (this.spell.markBearing * Math.PI) / 180;
    return { x: Math.sin(b) * this.spell.markM, y: Math.cos(b) * this.spell.markM };
  }

  /** Compass bearing from the boat to the mark. */
  markBearing(): number {
    const m = this.markXY();
    return wrap360((Math.atan2(m.x - this.s.x, m.y - this.s.y) * 180) / Math.PI);
  }

  /** The keel touched: the spell ends there. */
  ground(): void {
    this.s.aground = true;
    this.s.done = true;
    this.s.speedKn = 0;
  }

  distToMark(): number {
    const m = this.spell.marks;
    if (m?.length) {
      const k = m[Math.min(this.s.mark, m.length - 1)];
      return Math.hypot(k.x - this.s.x, k.y - this.s.y);
    }
    const b = (this.spell.markBearing * Math.PI) / 180;
    return Math.hypot(Math.sin(b) * this.spell.markM - this.s.x, Math.cos(b) * this.spell.markM - this.s.y);
  }

  /** Move on dt seconds (call with small steps: a frame). */
  step(dt: number, inp: Inputs): void {
    const s = this.s;
    const h = this.h;
    if (s.done || dt <= 0) return;
    // Rudder: eases toward the key held, and back to the centre when let go.
    const want = clamp(inp.helm, -1, 1);
    const dr = dt / h.rudderS;
    s.rudder = s.rudder < want ? Math.min(want, s.rudder + dr) : Math.max(want, s.rudder - dr);
    // Sheet.
    const t0 = this.table.sheet_deg[0];
    const t1 = this.table.sheet_deg[this.table.sheet_deg.length - 1];
    if (s.autoTrim) s.sheet = this.best().sheet;
    else s.sheet = clamp(s.sheet + inp.sheet * h.sheetDegS * dt, t0, t1);
    if (s.reefing > 0) s.reefing = Math.max(0, s.reefing - dt);

    const twa = this.twa();
    const l = look(this.table, s.plan, this.wind.twsKn, twa, s.sheet);
    const b = this.best();
    s.overNow = l.over > 0.5 && s.reefing === 0;
    // Turning: faster the faster you go, a little even when slow (GUESS 0.25).
    const steer = Math.max(0.25, Math.min(1.3, s.speedKn / h.refSpeedKn));
    let turn = s.rudder * h.turnDegS * steer;
    if (s.overNow) {
      // Overpowered: weather helm rounds the boat up into the wind.
      turn += Math.sign(twa) * h.roundUpDegS;
    }
    // In irons and nearly stopped: the bow blows off to the side it was on.
    // GUESS: until it's 40 degrees off, where the sails fill again.
    if (Math.abs(twa) < 40 && s.speedKn < 1.5 && Math.abs(s.rudder) < 0.2) turn += -s.side * h.fallOffDegS;
    const before = twa;
    s.heading = wrap360(s.heading + turn * dt);
    const after = this.twa();
    // A tack: the bow crossed the wind (both sides near head to wind).
    if (Math.sign(after) !== Math.sign(before) && Math.abs(after) < 90 && Math.abs(before) < 90) {
      s.tacks++;
      s.side = after >= 0 ? 1 : -1;
    } else if (Math.abs(after) > 30) s.side = after >= 0 ? 1 : -1;
    // Speed: eases toward the table's speed for this trim, less any rudder drag.
    let target = l.speedKn * (1 - h.rudderDrag * Math.abs(s.rudder));
    if (s.reefing > 0) target *= 0.5;
    if (s.overNow) target *= 1 - h.roundUpLoss;
    const tau = target > s.speedKn ? h.accelS : h.decelS;
    s.speedKn += (target - s.speedKn) * (1 - Math.exp(-dt / tau));
    // Heel follows the sails' push quickly (GUESS 1.5 s).
    const heelTarget = s.overNow ? Math.max(l.heelDeg, this.table.heel_max_deg + 5) : l.heelDeg;
    s.heelDeg += (heelTarget - s.heelDeg) * (1 - Math.exp(-dt / 1.5));
    if (s.overNow && !this.wasOver) s.roundUps++;
    this.wasOver = s.overNow;
    // Move.
    const m = s.speedKn * KNOT * dt;
    const hr = (s.heading * Math.PI) / 180;
    s.x += Math.sin(hr) * m;
    s.y += Math.cos(hr) * m;
    // Score: the share of the best speed on the heading you chose (your trim and reefing).
    if (b.speedKn > 0.3) {
      s.sumShare += clamp(s.speedKn / b.speedKn, 0, 1) * dt;
      s.sumSecs += dt;
    }
    s.t += dt;
    if (this.distToMark() < (this.spell.markRadiusM ?? 40)) {
      if (this.spell.marks?.length) {
        s.markTimes.push(s.t);
        s.mark++;
        if (s.mark >= this.spell.marks.length) s.done = true;
      } else s.done = true;
    }
  }
  private wasOver = false;

  /** Trim score so far: the share of the boat's best speed you sailed at, 0..1. */
  share(): number {
    return this.s.sumSecs > 0 ? this.s.sumShare / this.s.sumSecs : 0;
  }

  /** The heel for the boat's side: positive leans to port (wind from starboard pushes it over). */
  heelSigned(): number {
    return this.s.heelDeg * (this.twa() >= 0 ? 1 : -1);
  }
}

/**
 * The guided first spell (Leo): three prompts, each waiting until the player has done it.
 * Pure: the session calls update() every frame with the wheel, and reef() when a reef
 * changes; it shows `text` and hides the guide when `done`.
 */
export type GuideStep = "steer" | "trim" | "reef" | "go";
export const GUIDE_WORDS: Record<GuideStep, string> = {
  steer: "1 of 3 · Steer: hold Left or Right to turn the boat. Let go and the rudder centres.",
  trim: "2 of 3 · We've put the sail out of trim. Up pulls it in, Down lets it out: get the needle into the green, until it says \"Drawing well\".",
  reef: "3 of 3 · Leaning too far in a gust? Let the sail out (Down) or reef: press R now to make the sail smaller, then Shift+R to shake it out.",
  go: "That's sailing! Keep the needle in the green and head for the mark.",
};

export class Guide {
  step: GuideStep = "steer";
  done = false;
  private from: number | null = null;
  private goodFor = 0;
  private goShown = 0;

  update(w: Wheel, dt: number): void {
    if (this.done) return;
    if (this.step === "steer") {
      if (this.from === null) this.from = w.s.heading;
      if (Math.abs(wrap180(w.s.heading - this.from)) >= 10) {
        this.step = w.s.autoTrim ? "reef" : "trim";
        // Put the sail out of trim, so the player sees it and fixes it: right out (flapping),
        // or, running before the wind where right out is correct, pulled right in (stalled).
        if (this.step === "trim") {
          const sh = w.table.sheet_deg;
          const b = w.best();
          w.s.sheet = b.hi < sh[sh.length - 1] - 5 ? sh[sh.length - 1] : sh[0];
        }
      }
    } else if (this.step === "trim") {
      this.goodFor = w.sailState() === "good" ? this.goodFor + dt : 0;
      if (this.goodFor >= 1.5 || w.s.autoTrim) this.step = "reef";
    } else if (this.step === "go") {
      this.goShown += dt;
      if (this.goShown > 6) this.done = true;
    }
  }

  /** A reef was tucked in or shaken out. */
  reefed(): void {
    if (this.step === "reef") this.step = "go";
  }

  skip(): void {
    this.done = true;
  }

  get text(): string {
    return GUIDE_WORDS[this.step];
  }
}
