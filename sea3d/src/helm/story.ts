// The helm's results card, story first (Leo's plan, approved by Elena 12 Nov): the words.
// A headline that says who won, a sentence or two of what happened, at most three big
// numbers, the player's calls with what each was worth, and one line on where this leaves
// them. Pure functions of the simulator's card, so they can be tested; the page puts them
// in with textContent.
import type { Card, Ending } from "./game";

type Side = Card["boat"];

const d1 = (x: number) => x.toFixed(1);
const days = (x: number) => `${d1(x)} day${d1(x) === "1.0" ? "" : "s"}`;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const endDay = (x: Side) => x.ending?.day ?? x.days;

/** How each outcome reads after "Yours was" / "so was the ghost". */
const FATE: Record<string, string> = {
  lost: "Lost at sea",
  aground: "Washed ashore",
  disqualified: "Disqualified for going silent",
  timeout: "Still at sea when the clock ran out",
  at_sea: "Still at sea",
  left_data_box: "Off the edge of our weather map",
  landfall: "Ashore before the finish",
  sunk: "Sunk",
};

/** One line, who won. */
export function headline(c: Card): string {
  const me = c.boat;
  const gh = c.ghost;
  const m = c.margin_days;
  if (c.verdict === "draw") return "Level with the autopilot: within a day.";
  if (c.verdict === "won") return m !== null ? `You beat the autopilot by ${days(m)}.` : `You made it to Portugal, and the autopilot didn't.`;
  if (c.verdict === "lost") return m !== null ? `The autopilot beat you by ${days(-m)}.` : `The autopilot made it to Portugal, and you didn't.`;
  // Neither finished.
  const mine = FATE[me.outcome] ?? "Out of the race";
  if (me.outcome === gh.outcome && Math.abs(endDay(me) - endDay(gh)) < 0.05) return `${mine} on day ${d1(endDay(me))}, and so was the ghost.`;
  if (me.outcome === gh.outcome) return `${mine} on day ${d1(endDay(me))}; the ghost too, on day ${d1(endDay(gh))}.`;
  return `${mine} on day ${d1(endDay(me))}. Neither boat finished.`;
}

/** The ending's headline as a verb: "Went silent" -> "went silent", "Lost" -> "was lost". */
const PASSIVE = new Set(["lost", "disqualified", "swamped", "hit by a ship", "picked up", "still at sea"]);
function verb(head: string): string {
  const h = head.toLowerCase();
  if (h === "off the map") return "sailed off the map";
  if (h === "over") return "stopped";
  return PASSIVE.has(h) ? `was ${h}` : h;
}

/** "Both electronics boxes failed out in the open ocean": the ending's words as a clause. */
function clause(e: Ending, outcome: string): string {
  if (outcome === "arrived") return "crossed the finish line west of Lisbon";
  // Running aground names only the spot ("38.62N 27.91W"): say what happened there.
  const words = /^\d+(\.\d+)?[NS]\s/.test(e.words) ? `came ashore at ${e.words}` : e.words;
  return [words, e.where].filter(Boolean).join(" ");
}

/** One or two sentences of what happened, said once when both boats ended the same way. */
export function story(c: Card): string {
  const me = c.boat;
  const gh = c.ghost;
  const a = me.ending ? clause(me.ending, me.outcome) : null;
  const b = gh.ending ? clause(gh.ending, gh.outcome) : null;
  if (me.outcome === "arrived" && gh.outcome === "arrived")
    return `Both boats crossed the line west of Lisbon: you after ${days(me.days)}, the ghost after ${days(gh.days)}.`;
  if (a && b && a === b && me.outcome === gh.outcome) {
    const luck = !c.breakdowns_differ ? " The ghost had the same bad luck: breakdowns roll the same dice for both boats." : " The ghost ended the same way.";
    return `${cap(a)}, on day ${d1(endDay(me))}.${luck}`;
  }
  const say = (who: string, x: Side) => {
    const e = x.ending;
    if (!e) return "";
    if (x.outcome === "arrived") return `${who} crossed the finish line west of Lisbon after ${days(x.days)}.`;
    return `${who} ${verb(e.headline)} on day ${d1(endDay(x))}: ${clause(e, x.outcome)}.`;
  };
  const mine = say("Your boat", me);
  const theirs = say("The ghost", gh);
  return [mine, theirs].filter(Boolean).join(" ");
}

export interface Big {
  value: string;
  unit: string;
  label: string;
}

/** At most three big numbers: days sailed, km covered of the way, and how it stands against the ghost. */
export function numbers(c: Card, coveredKm: number, wayKm: number, leadKm: number): Big[] {
  const out: Big[] = [{ value: d1(c.boat.days), unit: "days", label: "at sea" }];
  if (wayKm > 0) out.push({ value: Math.max(0, Math.round(coveredKm)).toLocaleString("en-US"), unit: "km", label: `of ${Math.round(wayKm).toLocaleString("en-US")} sailed` });
  const m = c.margin_days;
  if (m !== null) out.push({ value: `${m >= 0 ? "+" : "−"}${d1(Math.abs(m))}`, unit: "days", label: m >= 0 ? "ahead of the ghost" : "behind the ghost" });
  else if (Math.abs(leadKm) < 1) out.push({ value: "level", unit: "", label: "with the ghost" });
  else out.push({ value: `${leadKm > 0 ? "+" : "−"}${Math.round(Math.abs(leadKm)).toLocaleString("en-US")}`, unit: "km", label: leadKm > 0 ? "ahead of the ghost" : "behind the ghost" });
  return out;
}

/** A call the player made when the clock stopped: when, what, and the lead on the ghost at that moment (km, + ahead). */
export interface Call {
  day: number;
  chose: string;
  lead: number;
}

/** "Day 2 · Rode the Gulf Stream · +120 km on the ghost": what each call was worth, until the next one or the end. */
export function callLines(calls: Call[], endLead: number): string[] {
  if (!calls.length) return ["You let the autopilot sail. Next time, make a call when the clock stops."];
  return calls.map((k, i) => {
    const gain = Math.round((i + 1 < calls.length ? calls[i + 1].lead : endLead) - k.lead);
    const worth = Math.abs(gain) < 1 ? "level with the ghost" : `${gain > 0 ? "+" : "−"}${Math.abs(gain).toLocaleString("en-US")} km on the ghost`;
    return `Day ${d1(k.day)} · ${k.chose} · ${worth}`;
  });
}

/** A choice's button label, short: "Hold course: fastest, but…" -> "Held course". */
export function callName(label: string): string {
  const head = label.split(":")[0].trim();
  const past: [RegExp, string][] = [
    [/^Hold course/i, "Held course"],
    [/^Dodge (.*)/i, "Dodged $1"],
    [/^Slow down.*/i, "Slowed down to ride it out"],
    [/^Ease off(.*)/i, "Eased off$1"],
    [/^Keep the power up/i, "Kept the power up"],
    [/^Follow the planned route.*/i, "Took the route that rides the Stream"],
    [/^Carry on as I am/i, "Carried on"],
  ];
  for (const [re, to] of past) if (re.test(head)) return head.replace(re, to);
  return head;
}

/** Where this leaves you: one line that turns the result into a reason to go again. `rate` is the build's finish rate, 0-1, if known. */
export function leaves(c: Card, rate: number | null, boatName = "This build"): string {
  if (rate === null) return c.boat.outcome === "arrived" ? "One voyage is one roll of the dice. Try another launch day to see more." : "One voyage is one roll of the dice. Play again, or try another launch day.";
  const pct = `${Math.round(rate * 100)}%`;
  const base = `${boatName} finishes ${pct} of launches.`;
  if (c.boat.outcome === "arrived") return `${base} This was one of them.`;
  if (rate >= 0.5) return `${base} This was one of the unlucky ones.`;
  return `${base} Try another design in the Boatyard?`;
}
