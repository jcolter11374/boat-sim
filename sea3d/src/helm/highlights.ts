// The results card's highlights for a watched voyage and a race (M3 piece E4): up to three plain
// lines from the voyage's own log, under "What happened". What broke, how often waves knocked her
// flat, the roughest sea, and in a race the lead changing hands. Pure: no page code, unit tested.
// No sailing words; Leo owns the wording (the strings are all here, in one place).

import { distanceKm, failedPart, PART_NAME, positionAt, type Replay } from "../replay/data";

export const HIGHLIGHT_WORDS = {
  title: "What happened",
  /** "the main computer and the backup computer" broke on a day. */
  broke: (day: number, parts: string[]) => `Day ${day}: ${joinAnd(parts.map((p) => `the ${p.toLowerCase()}`))} broke.`,
  knocked: (n: number) => (n === 1 ? "A wave knocked her flat once." : `Waves knocked her flat ${n} times.`),
  sea: (hs: number, day: number) => `The roughest sea: waves of ${hs.toFixed(1)} m on day ${day}.`,
  calm: "Nothing broke, and no wave knocked her flat.",
  /** A sailing boat leans hard in every gust, so her log's knockdowns aren't news: just what broke. */
  calmSail: "Nothing broke all the way.",
  lead: (who: string, day: number) => (day <= 3 ? `${who} led all the way.` : `${who} led from day ${day} to the end.`),
  swaps: (n: number, who: string, day: number) => `The lead changed hands ${n === 1 ? "once" : `${n} times`}; ${mid(who)} took it for good on day ${day}.`,
  brokeIn: (who: string, day: number, parts: string[]) => `${who}, day ${day}: ${joinAnd(parts.map((p) => `the ${p.toLowerCase()}`))} broke.`,
} as const;

/** A boat's name inside a sentence: "our kayak", a design's own name as it is. */
const mid = (n: string) => n.replace(/^Our /, "our ");
function joinAnd(xs: string[]): string {
  return xs.length < 2 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
const dayOf = (h: number) => Math.floor(h / 24) + 1;

/** How many times waves knocked her flat (the log's "2 knockdown(s)" counts each). Only for our kayak:
 *  a sailing boat's log counts every hard lean in a gust, hundreds a voyage, which says nothing. */
export function knockdowns(rep: Replay): number {
  if (!/kayak/i.test(rep.boat)) return 0;
  let n = 0;
  for (const e of rep.events) if (e.kind === "capsize") n += Number(/^(\d+)/.exec(e.detail ?? "")?.[1] ?? 1) || 1;
  return n;
}

/** The first breakdown: its day and the parts that broke that hour (named plainly, each once). */
export function firstBreak(rep: Replay): { day: number; parts: string[] } | null {
  const fails = rep.events.filter((e) => e.kind === "part_failed" && PART_NAME[failedPart(e).part] && failedPart(e).part !== "entangled");
  if (!fails.length) return null;
  const h = fails[0].h;
  const parts = [...new Set(fails.filter((e) => Math.abs(e.h - h) < 0.5).map((e) => PART_NAME[failedPart(e).part]))];
  return { day: dayOf(h), parts };
}

/** The roughest sea of the voyage: the highest waves, and the day. */
export function roughest(...reps: Replay[]): { hs: number; day: number } | null {
  let best: { hs: number; day: number } | null = null;
  for (const r of reps)
    r.hs.forEach((v, i) => {
      if (v != null && (!best || v > best.hs)) best = { hs: v, day: dayOf(r.h[i]) };
    });
  return best;
}

/** A watched voyage: what broke first, the knockdowns, the roughest sea (at most three lines). */
export function watchHighlights(rep: Replay): string[] {
  const W = HIGHLIGHT_WORDS;
  const out: string[] = [];
  const broke = firstBreak(rep);
  if (broke) out.push(W.broke(broke.day, broke.parts));
  const k = knockdowns(rep);
  if (k) out.push(W.knocked(k));
  if (!broke && !k) out.push(/kayak/i.test(rep.boat) ? W.calm : W.calmSail);
  const sea = roughest(rep);
  if (sea && sea.hs >= 1) out.push(W.sea(sea.hs, sea.day));
  return out.slice(0, 3);
}

/**
 * Who was nearer the finish, hour by hour, while both were sailing; a lead must be held a day to count
 * (so two boats side by side don't swap it every hour). Returns the changes of hands and the last holder.
 */
export function leadChanges(a: Replay, b: Replay, target: [number, number]): { swaps: number; who: 0 | 1; since: number } | null {
  const end = Math.min(a.h[a.h.length - 1] ?? 0, b.h[b.h.length - 1] ?? 0);
  let who: 0 | 1 | null = null;
  let since = 0;
  let swaps = 0;
  let pending: { who: 0 | 1; from: number } | null = null;
  for (let h = 24; h <= end; h += 6) {
    const ka = distanceKm(positionAt(a, h), target);
    const kb = distanceKm(positionAt(b, h), target);
    if (!Number.isFinite(ka) || !Number.isFinite(kb)) continue;
    const now: 0 | 1 = ka <= kb ? 0 : 1;
    if (who === null) {
      who = now;
      since = h;
      continue;
    }
    if (now === who) {
      pending = null;
      continue;
    }
    if (!pending || pending.who !== now) pending = { who: now, from: h };
    if (h - pending.from >= 24) {
      who = now;
      since = pending.from;
      swaps++;
      pending = null;
    }
  }
  return who === null ? null : { swaps, who, since: dayOf(since) };
}

/** A race: the lead, what broke on each boat, then the roughest sea (at most three lines). */
export function raceHighlights(a: Replay, b: Replay, names: [string, string], target: [number, number]): string[] {
  const W = HIGHLIGHT_WORDS;
  const out: string[] = [];
  const lead = leadChanges(a, b, target);
  if (lead) out.push(lead.swaps ? W.swaps(lead.swaps, names[lead.who], lead.since) : W.lead(names[lead.who], lead.since));
  for (const [k, r] of [a, b].entries()) {
    const broke = firstBreak(r);
    if (broke) out.push(W.brokeIn(names[k], broke.day, broke.parts));
  }
  // Both boats met the same weather: its roughest moment says what the race was like.
  const sea = roughest(a, b);
  if (out.length < 3 && sea && sea.hs >= 1) out.push(W.sea(sea.hs, sea.day));
  return out.slice(0, 3);
}
