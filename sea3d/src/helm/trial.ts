// Practice time trials (Rosa; Elena approved 12 Nov): a clock, splits against your best,
// bronze/silver/gold, and a ghost of your best run to race. Practice only: everything stays
// in this browser and never feeds a voyage, the odds or the leaderboard (Maya's condition 1).

import type { Breeze, CourseKind } from "./course";

/**
 * The robot sailor's time (s) with perfect trim and a good route (robot.ts; tests/trial.test.ts
 * re-sails it and fails if these drift more than 3%). The triangle is laid to the wind, so
 * every wind direction sails the same course; the light run has a fixed wind (LIGHT_WIND_FROM).
 */
export const ROBOT_SECS: Record<"triangle" | "light", Record<Breeze, number>> = {
  triangle: { light: 980, good: 801, fresh: 721 },
  light: { light: 2220, good: 1952, fresh: 1816 }, // through the finish gate east of the light (#420), not just 300 m off it
};

/** The light run's wind always comes from here, so a best time means the same thing every time: a fast close reach down to the light. */
export const LIGHT_WIND_FROM = 250;

export type Medal = "gold" | "silver" | "bronze";
/**
 * GUESS (Leo play-tunes): gold a few percent slower than the robot, so a good human can win it
 * (Elena); bronze loose enough for a first-timer's second try.
 */
export const MEDAL_FACTOR: Record<Medal, number> = { gold: 1.05, silver: 1.15, bronze: 1.35 }; // Leo's starting point
export const MEDAL_WORDS: Record<Medal, string> = { gold: "Gold", silver: "Silver", bronze: "Bronze" };

export function medalFor(secs: number, kind: CourseKind, breeze: Breeze): Medal | null {
  if (kind !== "triangle" && kind !== "light") return null;
  const ref = ROBOT_SECS[kind][breeze];
  for (const m of ["gold", "silver", "bronze"] as Medal[]) if (secs <= ref * MEDAL_FACTOR[m]) return m;
  return null;
}

/** The time a medal needs, for "Silver in 15:21" hints. */
export const medalTime = (m: Medal, kind: "triangle" | "light", breeze: Breeze): number => ROBOT_SECS[kind][breeze] * MEDAL_FACTOR[m];

/** The clock as the banner shows it: 6:05, or 1:02:05 past an hour. */
export function clock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** A split against the best: "−0:05" (ahead) or "+0:08" (behind). The minus is a real minus sign. */
export function splitText(secs: number, best: number): string {
  const d = Math.round(secs - best);
  return `${d < 0 ? "−" : "+"}${clock(Math.abs(d))}`;
}

/** A run, sampled once a second of boat time: [t, x, y, heading, heel] per sample. */
export interface Track {
  secs: number;
  markTimes: number[];
  pts: number[];
}
export const TRACK_STRIDE = 5;

/** Records a run as it's sailed (once a second of boat time). */
export class Recorder {
  private pts: number[] = [];
  private next = 0;
  add(t: number, x: number, y: number, heading: number, heel: number): void {
    if (t < this.next) return;
    this.pts.push(Math.round(t * 10) / 10, Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(heading), Math.round(heel));
    this.next = t + 1;
  }
  track(secs: number, markTimes: number[]): Track {
    return { secs, markTimes: [...markTimes], pts: this.pts };
  }
}

const lerpAngle = (a: number, b: number, f: number) => a + (((((b - a) % 360) + 540) % 360) - 180) * f;

/** Where the ghost is at time t (it waits at the finish once it's done). */
export function ghostAt(tr: Track, t: number): { x: number; y: number; heading: number; heel: number } | null {
  const n = tr.pts.length / TRACK_STRIDE;
  if (!n) return null;
  const at = (i: number, k: number) => tr.pts[i * TRACK_STRIDE + k];
  if (t <= at(0, 0)) return { x: at(0, 1), y: at(0, 2), heading: at(0, 3), heel: at(0, 4) };
  // Binary search for the last sample at or before t.
  let lo = 0;
  let hi = n - 1;
  if (t >= at(hi, 0)) return { x: at(hi, 1), y: at(hi, 2), heading: at(hi, 3), heel: at(hi, 4) };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at(mid, 0) <= t) lo = mid;
    else hi = mid;
  }
  const f = (t - at(lo, 0)) / (at(hi, 0) - at(lo, 0) || 1);
  return {
    x: at(lo, 1) + (at(hi, 1) - at(lo, 1)) * f,
    y: at(lo, 2) + (at(hi, 2) - at(lo, 2)) * f,
    heading: (lerpAngle(at(lo, 3), at(hi, 3), f) + 360) % 360,
    heel: at(lo, 4) + (at(hi, 4) - at(lo, 4)) * f,
  };
}

const GHOST_KEY = "boatsim.practice.ghost.v1";
/** The best run's track, per course and breeze (key from bestKey()), in this browser only. */
export function readGhost(key: string): Track | null {
  try {
    const all = JSON.parse(localStorage.getItem(GHOST_KEY) ?? "{}") as Record<string, Track>;
    const tr = all[key];
    return tr && Array.isArray(tr.pts) && Number.isFinite(tr.secs) ? tr : null;
  } catch {
    return null;
  }
}
/** Keep this run as the ghost if it's the best yet. Returns true if it was kept. */
export function saveGhost(key: string, tr: Track): boolean {
  const before = readGhost(key);
  if (before && before.secs <= tr.secs) return false;
  try {
    const all = JSON.parse(localStorage.getItem(GHOST_KEY) ?? "{}") as Record<string, Track>;
    all[key] = tr;
    localStorage.setItem(GHOST_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false; // private mode or full: no ghost
  }
}

/**
 * How far behind (+) or ahead (−) of the ghost you are, in seconds: when the ghost was nearest
 * where you are now, looking within three minutes either side of now.
 */
export function gapToGhost(tr: Track, x: number, y: number, t: number): number {
  let best = Infinity;
  let tg = t;
  for (let i = 0; i < tr.pts.length; i += TRACK_STRIDE) {
    const ti = tr.pts[i];
    if (ti < t - 180) continue;
    if (ti > t + 180) break;
    const d = (tr.pts[i + 1] - x) ** 2 + (tr.pts[i + 2] - y) ** 2;
    if (d < best) [best, tg] = [d, ti];
  }
  return Math.round(t - tg);
}

/**
 * Turn a track round the start by `deg` (compass, clockwise). Ghosts are kept as if the wind
 * came from the north, and turned to today's wind when raced: the triangle is laid to the
 * wind, so a run in a south-westerly races fairly against one in a northerly.
 */
export function turnTrack(tr: Track, deg: number): Track {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const pts = tr.pts.slice();
  for (let i = 0; i < pts.length; i += TRACK_STRIDE) {
    const x = pts[i + 1];
    const y = pts[i + 2];
    pts[i + 1] = Math.round((x * c + y * s) * 10) / 10;
    pts[i + 2] = Math.round((-x * s + y * c) * 10) / 10;
    pts[i + 3] = (((pts[i + 3] + deg) % 360) + 360) % 360;
  }
  return { ...tr, pts };
}
