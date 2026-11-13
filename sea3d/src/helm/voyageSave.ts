// A crossing saved in this browser, so closing the tab mid-voyage and coming back
// can offer "Continue your voyage" (DESIGN.md, M3: "One ending, and go again").
//
//   import { packVoyage, saveVoyage, loadVoyage, clearVoyage, continueLink } from "./helm/voyageSave";
//   saveVoyage(packVoyage({ code: await game.save(), challenge: "", boat: "Kayak", day: 12.4, toGoKm: 4100, rate: 6 }));
//   const v = loadVoyage();            // null if none saved, or the saved one can't be used
//   continueLink(v);                   // "helm.html?g=<code>&continue=1": opens it where it was left
//   offerWords(v);                     // "Day 12 · 4,100 km to go · Kayak", under "Continue your voyage"
//   clearVoyage();                     // when the voyage ends, or the player starts a new one
//
// What makes a crossing: its launch day, boat, seeds and every order so far. All of that is
// inside `code`, the simulator's own save code (sandbox/helm.py Game.save). Restoring is
// Game.load: the simulator sails the voyage again from the start with the same weather, luck
// and orders, and refuses a code whose replay doesn't end where it was saved. So nothing here
// is trusted as the boat's state. `day`, `toGoKm` and `boat` are only for the words of the
// offer ("day 12, 4,100 km to go"); the boat's real place comes from the replay.
//
// Stored in localStorage under one key, as JSON with a version number: one crossing at a
// time. Nothing leaves the browser. If the browser won't store anything (private mode,
// storage off, quota full) the save is kept in memory for this page, so nothing throws; it
// just won't be there after the tab closes.

import type { StorageLike } from "../myboat";

/** The storage key. The trailing version changes only if the format can't be read the old way. */
export const VOYAGE_KEY = "boatsim.voyage.v1";
/** The format's version, written into every save. A save with another version is not offered. */
export const VOYAGE_VERSION = 1;
/** Real time on the speed bar (John's T1) as a saved rate: a second of the voyage every second. */
export const REAL_TIME = "rt";

export interface SavedVoyage {
  v: typeof VOYAGE_VERSION;
  /** The simulator's save code: launch, boat, seeds and the orders so far. The only part
   *  a restore reads; the voyage is sailed again from it. */
  code: string;
  /** The weather challenge's id, or "" for an open crossing (the code needs its weather file). */
  challenge: string;
  /** The boat's name, for the offer's words. */
  boat: string;
  /** Voyage day when saved, for the offer's words only. */
  day: number;
  /** Km left to the finish when saved, for the offer's words only; null if not known. */
  toGoKm: number | null;
  /** The speed the clock was at: hours of voyage per second, REAL_TIME, or 0 for paused. */
  rate: number | typeof REAL_TIME;
  /** The simulator build that made the code ("" if not known). A different build may sail
   *  the voyage differently, and then the code won't load: see `madeBy`. */
  sim: string;
  /** When it was saved (ISO real time). Filled in by packVoyage. */
  saved: string;
}

/** What the page hands over when it saves. */
export interface VoyageNow {
  code: string;
  challenge?: string | null;
  boat?: string | null;
  day: number;
  toGoKm?: number | null;
  rate?: number | typeof REAL_TIME | null;
  sim?: string | null;
}

/** The simulator's codes are URL-safe base64, a few hundred characters; a year of daily
 *  orders stays far under this. Anything longer isn't one of ours. */
const MAX_CODE = 20000;
const CODE = /^[A-Za-z0-9_-]+$/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

const finite = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const okRate = (x: unknown): x is number | typeof REAL_TIME => x === REAL_TIME || (finite(x) && x >= 0 && x <= 1000);

/** A save record for this moment, or null if there's nothing worth keeping (no code, or
 *  a day that isn't a number). `now` is injectable for tests. */
export function packVoyage(n: VoyageNow, now: Date = new Date()): SavedVoyage | null {
  if (typeof n.code !== "string" || !CODE.test(n.code) || n.code.length > MAX_CODE) return null;
  if (!finite(n.day) || n.day < 0) return null;
  const challenge = typeof n.challenge === "string" && ID.test(n.challenge) ? n.challenge : "";
  return {
    v: VOYAGE_VERSION,
    code: n.code,
    challenge,
    boat: typeof n.boat === "string" ? n.boat.trim().slice(0, 60) : "",
    day: Math.round(n.day * 100) / 100,
    toGoKm: finite(n.toGoKm) && n.toGoKm >= 0 ? Math.round(n.toGoKm) : null,
    rate: okRate(n.rate) ? n.rate : 0,
    sim: typeof n.sim === "string" ? n.sim.slice(0, 80) : "",
    saved: now.toISOString(),
  };
}

/** A saved voyage if `raw` is one this version can use, else null. Never throws: a save
 *  that was cut short, edited by hand or written by a later version is simply not offered. */
export function parseVoyage(raw: string | null | undefined): SavedVoyage | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const r = o as Record<string, unknown>;
  if (r.v !== VOYAGE_VERSION) return null;
  if (typeof r.code !== "string" || !CODE.test(r.code) || r.code.length > MAX_CODE) return null;
  if (typeof r.challenge !== "string" || (r.challenge !== "" && !ID.test(r.challenge))) return null;
  if (!finite(r.day) || r.day < 0) return null;
  if (typeof r.saved !== "string" || Number.isNaN(Date.parse(r.saved))) return null;
  return {
    v: VOYAGE_VERSION,
    code: r.code,
    challenge: r.challenge,
    boat: typeof r.boat === "string" ? r.boat.slice(0, 60) : "",
    day: r.day,
    toGoKm: finite(r.toGoKm) && r.toGoKm >= 0 ? r.toGoKm : null,
    rate: okRate(r.rate) ? r.rate : 0,
    sim: typeof r.sim === "string" ? r.sim.slice(0, 80) : "",
    saved: r.saved,
  };
}

let memory: string | null = null; // the fallback when the browser won't store anything

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage with storage off
  }
}

/** Keep this voyage (replacing any other: one crossing at a time). True if it reached the
 *  browser's storage, false if it is only in this page's memory. Never throws. */
export function saveVoyage(v: SavedVoyage, s: StorageLike | null = store()): boolean {
  const raw = JSON.stringify(v);
  memory = raw;
  if (!s) return false;
  try {
    s.setItem(VOYAGE_KEY, raw);
    return true;
  } catch {
    return false; // quota full or storage off: the in-memory copy stands
  }
}

/** The saved voyage, or null if there is none (or it can't be used). Never throws. */
export function loadVoyage(s: StorageLike | null = store()): SavedVoyage | null {
  if (s) {
    try {
      const raw = s.getItem(VOYAGE_KEY);
      if (raw !== null) return parseVoyage(raw);
    } catch {
      // unreadable: use the in-memory copy
    }
  }
  return parseVoyage(memory);
}

/** Forget the saved voyage: it ended, or the player set off on a new one. Never throws. */
export function clearVoyage(s: StorageLike | null = store()): void {
  memory = null;
  if (!s) return;
  try {
    s.removeItem(VOYAGE_KEY);
  } catch {
    // nothing to do: it wasn't stored there either
  }
}

/** Whether a voyage is worth saving now: under way (so there is something to come back to)
 *  and not over (an ended voyage has its results card, not a "continue"). */
export function worthSaving(day: number | null | undefined, over: boolean | null | undefined): boolean {
  return finite(day) && day > 0 && !over;
}

/** Whether `v` was made by the simulator build `sim`. A save from another build may not
 *  load (the simulator refuses a code it would sail differently); the page can say so
 *  kindly instead of failing. Unknown on either side counts as a match: try it. */
export function madeBy(v: SavedVoyage, sim: string | null | undefined): boolean {
  return !v.sim || !sim || v.sim === sim;
}

/** The offer's second line: where the saved voyage stands. "Day 12 · 4,100 km to go · Kayak"
 *  (the day as the helm counts it: day 12.4 is day 12; before the first midnight, "The first day"). */
export function offerWords(v: SavedVoyage): string {
  const parts = [v.day < 1 ? "The first day" : `Day ${Math.floor(v.day)}`];
  if (v.toGoKm !== null) parts.push(`${v.toGoKm.toLocaleString("en-US")} km to go`);
  if (v.boat) parts.push(v.boat);
  return parts.join(" · ");
}

/** The link that opens the saved voyage where it was left. `continue=1` tells the helm it is
 *  the player's own voyage coming back, not a game someone shared with them. */
export function continueLink(v: SavedVoyage, page = "helm.html"): string {
  const q = new URLSearchParams({ g: v.code });
  if (v.challenge) q.set("c", v.challenge);
  q.set("continue", "1");
  return `${page}?${q.toString()}`;
}
