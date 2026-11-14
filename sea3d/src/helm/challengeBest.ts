// Your weather challenge results, kept in this browser (M3 piece L3; Rosa).
//
// The leaderboard's "Weather challenges" tab (John, W5: their own tab, not the main board)
// shows, for each challenge, your best try beside the autopilot's. There is no server: a try
// is kept here, in the browser's storage, when a challenge ends on the results card.
// Practice runs and ordinary crossings are never kept here.
//
// Pure: no page code. The card calls saveChallengeRun once when a challenge ends.

import type { StorageLike } from "../myboat";

export const CHALLENGE_BEST_KEY = "boatsim.challenge.best.v1";

/** How one try at a challenge ended. */
export interface ChallengeRun {
  /** The judge's stars, 0 to 3; null for a challenge that gives none. */
  stars: number | null;
  /** Did she reach the finish (or, with a goal, sail to its last day)? */
  finished: boolean;
  /** Days at sea when it ended. */
  days: number;
}

/** What is kept for one challenge. */
export interface ChallengeBest {
  /** Your best try. */
  best: ChallengeRun;
  /** The boat that sailed it: the player's own name for her, so text only on a page. */
  boat: string;
  /** When, as an ISO date and time. */
  at: string;
  /** How the autopilot did on that same try; null if the card didn't say. */
  autopilot: ChallengeRun | null;
  /** How many tries so far. */
  tries: number;
}

/**
 * Is try `a` better than try `b`? More stars first; then finishing over not finishing; then,
 * for two that finished, fewer days, and for two that didn't, more days (she lasted longer).
 */
export function betterRun(a: ChallengeRun, b: ChallengeRun): boolean {
  const sa = a.stars ?? -1;
  const sb = b.stars ?? -1;
  if (sa !== sb) return sa > sb;
  if (a.finished !== b.finished) return a.finished;
  return a.finished ? a.days < b.days : a.days > b.days;
}

function tidyRun(x: unknown): ChallengeRun | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const days = Number(r.days);
  if (!Number.isFinite(days) || days < 0 || days > 1000) return null;
  const stars = r.stars == null ? null : Number(r.stars);
  if (stars != null && !(Number.isInteger(stars) && stars >= 0 && stars <= 3)) return null;
  return { stars, finished: r.finished === true, days };
}

/** What was stored, checked: anything that isn't a result we wrote is dropped, never trusted. */
export function tidyBests(raw: unknown): Record<string, ChallengeBest> {
  const out: Record<string, ChallengeBest> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[\w-]{1,60}$/.test(id) || !v || typeof v !== "object") continue;
    const b = v as Record<string, unknown>;
    const best = tidyRun(b.best);
    if (!best) continue;
    const tries = Number(b.tries);
    out[id] = {
      best,
      boat: typeof b.boat === "string" ? b.boat.slice(0, 60) : "",
      at: typeof b.at === "string" && !Number.isNaN(Date.parse(b.at)) ? b.at : "",
      autopilot: tidyRun(b.autopilot),
      tries: Number.isInteger(tries) && tries >= 1 ? Math.min(tries, 100000) : 1,
    };
  }
  return out;
}

// The fallback when the browser won't store anything: what this page saved, used only after a save could not be stored.
let memory: Record<string, ChallengeBest> | null = null;

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage with storage off
  }
}

/** Every challenge's kept result, by the challenge's id. Never throws. */
export function loadChallengeBests(s: StorageLike | null = store()): Record<string, ChallengeBest> {
  if (s && !memory) {
    try {
      const raw = s.getItem(CHALLENGE_BEST_KEY);
      if (raw) return tidyBests(JSON.parse(raw));
    } catch {
      /* unreadable: as if nothing were kept */
    }
  }
  return memory ? tidyBests(memory) : {};
}

/**
 * A challenge has just ended: count the try, and keep it if it is your best so far.
 * Returns what is now kept and whether this try became the best. Never throws.
 */
export function saveChallengeRun(
  id: string,
  run: ChallengeRun,
  about: { boat?: string; autopilot?: ChallengeRun | null; at?: string } = {},
  s: StorageLike | null = store(),
): { kept: ChallengeBest | null; isBest: boolean } {
  const mine = tidyRun(run);
  if (!/^[\w-]{1,60}$/.test(id) || !mine) return { kept: null, isBest: false };
  const all = loadChallengeBests(s);
  const was = all[id];
  const isBest = !was || betterRun(mine, was.best);
  const kept: ChallengeBest = isBest
    ? { best: mine, boat: (about.boat ?? "").slice(0, 60), at: about.at ?? new Date().toISOString(), autopilot: tidyRun(about.autopilot), tries: (was?.tries ?? 0) + 1 }
    : { ...was, tries: was.tries + 1 };
  all[id] = kept;
  let stored = false;
  if (s) {
    try {
      s.setItem(CHALLENGE_BEST_KEY, JSON.stringify(all));
      stored = true;
    } catch {
      /* quota full or storage off: this page's memory keeps it */
    }
  }
  memory = stored ? null : all;
  return { kept, isBest };
}

/** "★★☆" for 2 stars; "" for a challenge that gives none. */
export function starsWord(stars: number | null): string {
  return stars == null ? "" : "★".repeat(stars) + "☆".repeat(3 - stars);
}

/** One line for a kept try: "★★☆ in 6.0 days", "Finished in 41.2 days", "Lost on day 3.9". */
export function runWords(r: ChallengeRun): string {
  const d = r.days.toFixed(1);
  if (r.stars != null) return r.finished ? `${starsWord(r.stars)} in ${d} days` : `${starsWord(r.stars)} · lost on day ${d}`;
  return r.finished ? `Finished in ${d} days` : `Lost on day ${d}`;
}
