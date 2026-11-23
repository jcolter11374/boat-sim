// Your best crossing from each launch day, kept in this browser (#331: "Personal best per launch").
//
// A crossing that reaches the finish is timed in days at sea. The fastest one from each launch
// day is kept here, so the results card can say "a new personal best" and the next start from
// that day has a time to beat. There is no server: it lives in the browser's storage, like the
// weather challenges' results (helm/challengeBest.ts). A weather challenge, a watched voyage, a
// race, practice and someone else's shared game are never kept here.
//
// A crossing with breakdowns switched off, or one from another start, is an easier or a
// different voyage, so each has its own best. The start is where the track begins, not the
// port picked on the card: a voyage picked up later no longer knows its port. Any boat counts:
// a faster design earning a better time is the game.
//
// Pure: no page code. The results card calls savePersonalBest once when a crossing ends.

import type { StorageLike } from "../myboat";

export const PERSONAL_BEST_KEY = "boatsim.crossing.best.v1";

export interface PersonalBest {
  /** Days at sea of the fastest finish. */
  days: number;
  /** The boat that sailed it: the player's own name for her, so text only on a page. */
  boat: string;
  /** When, as an ISO date and time. */
  at: string;
  /** How many crossings from this day reached the finish. */
  finishes: number;
}

/** The crossing a best belongs to. */
export interface CrossingId {
  /** The launch day, "2020-04-23" or a full timestamp. */
  launch: string;
  /** Where the track begins, [lat, lon]. */
  start: [number, number];
  breakdowns: boolean;
}

/** The storage key for one kind of crossing, or null for a launch day that can't be read. */
export function bestId(c: CrossingId): string | null {
  const day = c.launch.slice(0, 10);
  if (!/^\d{4}-\d\d-\d\d$/.test(day)) return null;
  const [lat, lon] = c.start;
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  // To a tenth of a degree (about 10 km): the same start every time, apart from any other.
  return `${day}_${Math.round(lat * 10)}_${Math.round(lon * 10)}${c.breakdowns ? "" : "_easy"}`;
}

function tidy(x: unknown): PersonalBest | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const days = Number(r.days);
  if (!Number.isFinite(days) || days <= 0 || days > 1000) return null;
  const n = Number(r.finishes);
  return {
    days,
    boat: typeof r.boat === "string" ? r.boat.slice(0, 60) : "",
    at: typeof r.at === "string" && !Number.isNaN(Date.parse(r.at)) ? r.at : "",
    finishes: Number.isInteger(n) && n >= 1 ? Math.min(n, 100000) : 1,
  };
}

/** What was stored, checked: anything that isn't a result we wrote is dropped, never trusted. */
export function tidyBests(raw: unknown): Record<string, PersonalBest> {
  const out: Record<string, PersonalBest> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w-]{1,60}$/.test(id)) continue;
    const b = tidy(v);
    if (b) out[id] = b;
  }
  return out;
}

// The fallback when the browser won't store anything: what this page saved.
let memory: Record<string, PersonalBest> | null = null;

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage with storage off
  }
}

function loadAll(s: StorageLike | null): Record<string, PersonalBest> {
  if (s && !memory) {
    try {
      const raw = s.getItem(PERSONAL_BEST_KEY);
      if (raw) return tidyBests(JSON.parse(raw));
    } catch {
      /* unreadable: as if nothing were kept */
    }
  }
  return memory ? tidyBests(memory) : {};
}

/** Your best for this crossing, or null if you haven't finished one. Never throws. */
export function loadPersonalBest(c: CrossingId, s: StorageLike | null = store()): PersonalBest | null {
  const id = bestId(c);
  return id ? loadAll(s)[id] ?? null : null;
}

export interface BestResult {
  /** The best before this crossing, or null if there was none. */
  before: PersonalBest | null;
  /** The best now. */
  now: PersonalBest | null;
  /** This crossing became the best (the first finish counts). */
  isBest: boolean;
}

/**
 * A crossing has just ended. If she reached the finish, count it, and keep it if it is your
 * fastest from this launch day. A crossing that didn't finish changes nothing. Never throws.
 */
export function savePersonalBest(c: CrossingId, run: { finished: boolean; days: number }, about: { boat?: string; at?: string } = {}, s: StorageLike | null = store()): BestResult {
  const id = bestId(c);
  const all = loadAll(s);
  const before = id ? all[id] ?? null : null;
  // The same ending shown again (the page reloaded on a finished voyage) is not another finish.
  const ending = `${id}|${run.finished}|${run.days}`;
  const last = readLast(s);
  if (last && last.ending === ending) return last.result;
  const result = saveRun(id, all, before, run, about, s);
  // Only an ending that was counted needs remembering.
  if (result.now === result.before) return result;
  lastSeen = { ending, result };
  if (s) {
    try {
      s.setItem(LAST_ENDING_KEY, JSON.stringify(lastSeen));
      lastSeen = null;
    } catch {
      /* quota full or storage off: this page's memory keeps it */
    }
  }
  return result;
}

/** The last ending counted, and what the card said of it: a reload on a finished voyage shows the same line and counts nothing. */
export const LAST_ENDING_KEY = "boatsim.crossing.best.last.v1";
// The fallback when the browser won't store anything.
let lastSeen: { ending: string; result: BestResult } | null = null;

function readLast(s: StorageLike | null): { ending: string; result: BestResult } | null {
  if (lastSeen) return lastSeen;
  try {
    const raw = s?.getItem(LAST_ENDING_KEY);
    const x = raw ? (JSON.parse(raw) as { ending?: unknown; result?: Record<string, unknown> }) : null;
    if (x && typeof x.ending === "string" && x.result && typeof x.result === "object")
      return { ending: x.ending, result: { before: tidy(x.result.before), now: tidy(x.result.now), isBest: x.result.isBest === true } };
  } catch {
    /* unreadable: as if there were none */
  }
  return null;
}

function saveRun(id: string | null, all: Record<string, PersonalBest>, before: PersonalBest | null, run: { finished: boolean; days: number }, about: { boat?: string; at?: string }, s: StorageLike | null): BestResult {
  if (!id || !run.finished || !Number.isFinite(run.days) || run.days <= 0 || run.days > 1000) return { before, now: before, isBest: false };
  const isBest = !before || run.days < before.days;
  const now: PersonalBest = isBest
    ? { days: run.days, boat: (about.boat ?? "").slice(0, 60), at: about.at ?? new Date().toISOString(), finishes: (before?.finishes ?? 0) + 1 }
    : { ...before, finishes: before.finishes + 1 };
  all[id] = now;
  let stored = false;
  if (s) {
    try {
      s.setItem(PERSONAL_BEST_KEY, JSON.stringify(all));
      stored = true;
    } catch {
      /* quota full or storage off: this page's memory keeps it */
    }
  }
  memory = stored ? null : all;
  return { before, now, isBest };
}

const d1 = (x: number) => x.toFixed(1);
/** "0.4 days" from a difference, never "0.0 days" for a real one. */
const gap = (x: number) => `${Math.max(Math.abs(x), 0.1).toFixed(1)} days`;

/**
 * The results card's line. A finish: a first time to beat, a new best and by how much, or how
 * far off your best it was. No finish: your best from this day if you have one, else nothing.
 */
export function bestWords(r: BestResult, run: { finished: boolean; days: number }): string {
  if (!run.finished) return r.before ? `Your best from this launch day is still ${d1(r.before.days)} days.` : "";
  if (!r.before) return `Your first finish from this launch day: ${d1(run.days)} days is now your time to beat.`;
  if (r.isBest) return `A new personal best: ${gap(r.before.days - run.days)} faster than your old best of ${d1(r.before.days)} days.`;
  if (Math.abs(run.days - r.before.days) < 0.05) return `Level with your personal best of ${d1(r.before.days)} days from this launch day.`;
  return `${gap(run.days - r.before.days)} off your personal best of ${d1(r.before.days)} days from this launch day.`;
}

/** The note at the start of a crossing you have finished before. */
export function toBeatWords(b: PersonalBest): string {
  return `Your best from this launch day is ${d1(b.days)} days. That's the time to beat.`;
}
