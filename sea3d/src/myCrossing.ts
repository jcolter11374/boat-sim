// The player's last crossing, remembered in this browser, so the leaderboard can
// list their boat under its own name (issue #653). Nothing leaves the browser.
//
// The leaderboard itself ranks a fixed list of boats, each sailed by the autopilot
// on the same launch days. One voyage steered by a player is not that test, so the
// player's boat is shown as a row of its own, never given a place: its name, the
// Boatyard's odds for the build when our servers have tested it, and how the
// player's own crossing ended. Pure: no page code.

import type { StorageLike } from "./myboat";

export const CROSSING_KEY = "boatsim.lastcrossing.v1";

export interface MyCrossing {
  /** The boat's name as the Set sail card showed it (the player's own text for a Boatyard design). */
  boat: string;
  /** The simulator's id for the build that sailed (catalog.grid_id), as on the Results card. */
  build: string;
  /** Did she reach the finish? */
  finished: boolean;
  /** Days at sea when it ended. */
  days: number;
  /** The launch day sailed ("2020-04-23"), or "". */
  day: string;
  /** When it ended (ISO time). */
  at: string;
}

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** What was stored, checked: anything that isn't a crossing we wrote is dropped. */
export function parseMyCrossing(raw: string | null): MyCrossing | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const c = o as Record<string, unknown>;
  if (c.v !== 1 || typeof c.boat !== "string" || !c.boat.trim() || typeof c.build !== "string" || !c.build) return null;
  if (typeof c.finished !== "boolean" || typeof c.days !== "number" || !Number.isFinite(c.days) || c.days < 0) return null;
  return { boat: c.boat.slice(0, 60), build: c.build.slice(0, 200), finished: c.finished, days: c.days, day: typeof c.day === "string" ? c.day.slice(0, 10) : "", at: typeof c.at === "string" ? c.at : "" };
}

export function loadMyCrossing(s: StorageLike | null = store()): MyCrossing | null {
  if (!s) return null;
  try {
    return parseMyCrossing(s.getItem(CROSSING_KEY));
  } catch {
    return null;
  }
}

/** Remember this crossing (replacing the last). Returns what was kept, or null if it couldn't be. */
export function saveMyCrossing(c: Omit<MyCrossing, "at"> & { at?: string }, s: StorageLike | null = store(), now: Date = new Date()): MyCrossing | null {
  const kept = parseMyCrossing(JSON.stringify({ v: 1, ...c, at: c.at ?? now.toISOString() }));
  if (!kept || !s) return kept;
  try {
    s.setItem(CROSSING_KEY, JSON.stringify({ v: 1, ...kept }));
  } catch {
    // full or switched off: nothing to do
  }
  return kept;
}

/** The boat's name on the Results card: the one she sailed under, never another boat's. */
export function resultsBoatName(sailedAs: string | null | undefined): string {
  const n = (sailedAs ?? "").trim();
  return n || "This build";
}

/** The Results table's row for the player: their boat's name when it has one of its own. */
export function resultsRowLabel(sailedAs: string | null | undefined): string {
  const n = (sailedAs ?? "").trim();
  return !n || n === "Our kayak" ? "You" : `${n} (you)`;
}

/** The player's boat as the leaderboard shows it. */
export interface YourRow {
  name: string;
  /** The board already has a row for this build: mark that row with the name; no row of its own. */
  onBoard: boolean;
  /** "84%" with where it comes from, or null when our servers haven't tested the build. */
  odds: { rate: number; words: string } | null;
  /** "Your crossing: finished in 55.3 days (launched 23 Apr 2020)." */
  crossing: string;
  /** Why it has no place. */
  why: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayWords(day: string): string {
  const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(day);
  const mo = m ? Number(m[2]) : 0;
  return m && mo >= 1 && mo <= 12 ? ` (launched ${Number(m[3])} ${MONTHS[mo - 1]} ${m[1]})` : "";
}

/** A Boatyard grid build, as much as this needs (boatyard/index.json builds[]). */
interface GridBuildOdds {
  id: string;
  odds?: { voyages: number; odds: number } | null;
}

/**
 * The row for the player's boat, or null when they haven't finished a crossing in this browser.
 * `boardBuilds` are the builds the board ranks; `grid` the Boatyard's tested builds.
 */
export function yourRow(c: MyCrossing | null, boardBuilds: string[], grid: GridBuildOdds[] | null): YourRow | null {
  if (!c) return null;
  const g = grid?.find((b) => b.id === c.build && b.odds);
  const days = `${c.days.toFixed(1)} days`;
  return {
    name: c.boat,
    onBoard: boardBuilds.includes(c.build),
    odds: g?.odds ? { rate: g.odds.odds, words: `Boatyard odds, over ${g.odds.voyages} launch days` } : null,
    crossing: `Your crossing: ${c.finished ? `finished in ${days}` : `didn't finish (${days} at sea)`}${dayWords(c.day)}.`,
    why: "Your boat. Not ranked: the board tests a fixed list of boats, each sailed by the autopilot on the same launch days.",
  };
}
