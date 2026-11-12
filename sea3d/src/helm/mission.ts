// Weather challenges with a goal (Rosa; Sandy's shadow first, plan approved by Elena 12 Nov):
// the briefing, the goal chip on screen, the one big call, and the stars on the result card.
// The goal and the storm come from challenges.json (Sam); the stars come from the simulator's
// judge (Ravi's sandbox/stars.py) through the result card. The words and the feel are here.
// Tone: these are real storms that killed people. Sober, plain, never "epic".

import { stormFromBoat, type StormRow } from "./storm";

export interface Goal {
  /** When the challenge ends (ISO). Still sailing then = the goal. */
  until: string;
  storm?: { name: string; track: StormRow[]; clear_km: number; well_km: number };
  /** ★★★: end east of this longitude with the battery never below this share. */
  stars3?: { east_of: number; battery_min: number };
  /** The day (from the drop) the big call is asked. */
  call_day?: number;
  /** "What really happened", with a source. */
  debrief?: { text: string; url: string };
}

/** Days from the drop to the deadline. */
export function goalDays(goal: Goal, startIso: string): number {
  return Math.round((Date.parse(goal.until) - Date.parse(startIso)) / 86400e3);
}

export type ChipState = "clear" | "near" | "danger";
/** The goal chip: "Day 4 of 9 · storm centre 380 km", and how close is too close. */
export function goalChip(goal: Goal, startIso: string, nowMs: number, lat: number, lon: number): { day: string; storm: string; km: string; state: ChipState } {
  const n = goalDays(goal, startIso);
  const d = Math.min(n, Math.max(1, Math.floor((nowMs - Date.parse(startIso)) / 86400e3) + 1));
  const day = `Day ${d} of ${n}`;
  const s = goal.storm ? stormFromBoat(goal.storm.track, nowMs, lat, lon) : null;
  if (!goal.storm || !s) return { day, storm: "", km: "", state: "clear" };
  const km = Math.round(s.km / 10) * 10;
  const state: ChipState = s.km < goal.storm.clear_km ? "danger" : s.km < goal.storm.well_km ? "near" : "clear";
  const kmText = `${km.toLocaleString("en-US")} km`;
  return { day, storm: `storm centre ${kmText}`, km: kmText, state };
}

/** The briefing: what to do, in three short lines, then the stars and the honesty note. */
export function briefing(goal: Goal, startIso: string): { lines: string[]; stars: string[] } {
  const n = goalDays(goal, startIso);
  const s = goal.storm;
  const lines = s
    ? [
        `${s.name} is coming north from the Caribbean.`,
        `Keep more than ${s.clear_km} km from its centre, and keep sailing for ${n} days.`,
      ]
    : [`Keep sailing for ${n} days.`];
  const stars = [`★ Never within ${s?.clear_km ?? 0} km of the centre, still sailing at the end`];
  if (s) stars.push(`★★ Never within ${s.well_km} km`);
  if (goal.stars3) stars.push(`★★★ Finish east of ${Math.abs(goal.stars3.east_of)}°W with the battery never below ${Math.round(goal.stars3.battery_min * 100)}%`);
  return { lines, stars };
}

/** The honesty note under every storm briefing (Leo). */
export const HONEST = "A real storm, from the weather records. The records soften the strongest winds near the eye, so the real thing was even rougher.";

/** One option of the big call: a heading (compass deg, or "auto") and a power share. */
export interface CallOption {
  key: string;
  label: string;
  title: string;
  heading: number | "auto";
  power: number | null;
}
export interface Call {
  text: string;
  options: CallOption[];
}

/**
 * The big call for each challenge (Rosa writes them; Leo checks the words). Each option says its
 * trade honestly, from Ravi's runs in the challenge's own weather. One is always the autopilot's.
 */
export const CALLS: Record<string, Call> = {
  "sandys-shadow": {
    text: "Sandy is forecast to turn up the coast. Run east across the Gulf Stream, or south-east and hope it turns early?",
    options: [
      { key: "east", label: "Run east, easy (15% power): away from the coast, and the battery lasts", title: "Heads east at low power so the battery survives days of cloud", heading: 90, power: 0.15 },
      { key: "southeast", label: "South-east (50% power): away from the coast, but the battery may run flat", title: "Heads south-east at half power", heading: 135, power: 0.5 },
      { key: "auto", label: "Do what the autopilot does", title: "Keep to the autopilot's plan, as the ghost does", heading: "auto", power: null },
    ],
  },
};

/**
 * What the call bought you, a couple of days later: against the ghost, in the same km as the
 * strip's "vs the ghost" (the simulator's lead_km, + ahead), so the toast and the strip agree.
 */
export function callToast(key: string, leadKm: number): string {
  const km = Math.round(leadKm); // as the strip rounds it
  const verb: Record<string, string> = { east: "Running east", southeast: "Heading south-east", auto: "Following the autopilot" };
  if (Math.abs(km) < 1) return `${verb[key] ?? "Your call"}: level with the autopilot so far.`;
  return `${verb[key] ?? "Your call"}: ${Math.abs(km).toLocaleString("en-US")} km ${km > 0 ? "ahead of" : "behind"} the autopilot so far.`;
}

/** The result card's headline for a challenge: whether she was still sailing at the deadline, plainly (not who won). */
export function missionHead(sailing: boolean, goal: Goal): string {
  const s = goal.storm?.name;
  if (sailing) return s ? `Still sailing after ${s}.` : "Still sailing at the deadline.";
  return s ? `She didn't come through ${s}.` : "She didn't make it to the deadline.";
}

/** The judge's stars on the result card (Ravi's judge(), through the simulator's result). */
export interface Stars {
  stars: number;
  closest_km: number;
  end_lon: number;
  battery_low: number;
  sailing: boolean;
}
/** The stars line and the reasons, plainly; with the ghost's stars, one plain line on how the autopilot fared (Elena). */
export function starsText(s: Stars, goal: Goal, ghost?: Stars): { stars: string; why: string[] } {
  const why = [`Closest to the centre: ${Math.round(s.closest_km).toLocaleString("en-US")} km.`];
  if (!s.sailing) why.push("The boat didn't make it to the end.");
  if (goal.stars3) why.push(`Ended at ${Math.abs(s.end_lon).toFixed(1)}°W, with the battery at ${Math.round(s.battery_low * 100)}% at its lowest.`);
  if (ghost && goal.storm) why.push(`The autopilot kept to its usual route, which crossed ${goal.storm.name}'s path: the ghost passed ${Math.round(ghost.closest_km).toLocaleString("en-US")} km from the eye.`);
  return { stars: "★".repeat(s.stars) + "☆".repeat(Math.max(0, 3 - s.stars)), why };
}
