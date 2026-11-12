// Weather challenges for Take the helm: famous stretches of real weather
// (Priya's src/boatsim/oceandata/challenges.py). challenges.json and each
// challenge's own weather bundle come from the challenge-data release, copied
// into public/challenges/ at build time; the two 2020 ones use the Boatyard's
// forcing_2020.npz. Without the files the picker stays hidden.

import type { Goal } from "./mission";

export interface Challenge {
  id: string;
  n: number;
  title: string;
  start: string; // ISO, noon UTC
  story: string;
  bundle: string; // file name; "forcing_2020.npz" = the 2020 bundle the page already has
  seed: number;
  hurricane: boolean;
  season: boolean;
  weather_note: string;
  /** Turn on the storm boost (#117) when it lands. Ignored for now (Maya, 11 Nov):
   *  the boost still runs hot near the eye, so storms sail on plain ERA5. */
  storm_boost: boolean;
  /** A goal to meet (Sandy's shadow first): a deadline, a storm to keep clear of, stars. Older files leave it out. */
  goal?: Goal;
}

export async function loadChallenges(base: string, get: (u: string) => Promise<Response> = (u) => fetch(u)): Promise<Challenge[]> {
  try {
    const r = await get(new URL("challenges.json", base).href);
    if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return [];
    const j = (await r.json()) as { challenges?: Challenge[] };
    // List order: 1-8, then the bonus (n = 0).
    return (j.challenges ?? []).slice().sort((a, b) => (a.n || 99) - (b.n || 99));
  } catch {
    return [];
  }
}

/** The URL of a challenge's weather, or undefined when it's the 2020 bundle. */
export function bundleUrl(c: Challenge, base: string): string | undefined {
  return c.season ? undefined : new URL(c.bundle, base).href;
}

/** "22 Oct 2012", for the picker. */
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function startLabel(c: Challenge): string {
  const d = new Date(c.start);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
