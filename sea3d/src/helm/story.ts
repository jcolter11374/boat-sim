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

/** How each outcome reads at the start of a "neither finished" headline. */
const FATE: Record<string, string> = {
  lost: "Lost",
  aground: "Washed ashore",
  disqualified: "Out for going silent",
  timeout: "Still at sea when the clock ran out",
  at_sea: "Still at sea",
  left_data_box: "Off the edge of our weather map",
  landfall: "Ashore before the finish",
  sunk: "Sunk",
};

/** Whether each boat crossed the race's start line (the western line, about 500 km out). Under the
 * Microtransat rules the race only begins there: a voyage that ends before it never started (Sam). */
export interface Started {
  me: boolean;
  ghost: boolean;
}
const BOTH: Started = { me: true, ghost: true };
const NO_START = "The race begins at a line far out in the ocean, and she never reached it.";

/** One line, who won. */
export function headline(c: Card, started: Started = BOTH): string {
  const me = c.boat;
  const gh = c.ghost;
  const m = c.margin_days;
  if (c.verdict === "draw") return "Level with the autopilot: within a day.";
  if (c.verdict === "won") return m !== null ? `You beat the autopilot by ${days(m)}.` : `You made it to Portugal, and the autopilot didn't.`;
  if (c.verdict === "lost")
    return m !== null ? `The autopilot beat you by ${days(-m)}.` : started.me ? `The autopilot made it to Portugal, and you didn't.` : "The autopilot made it to Portugal. You never reached the start line.";
  if (!started.me) return started.ghost ? `Never reached the start line, on day ${d1(endDay(me))}.` : `Neither boat reached the start line.`;
  // Neither finished.
  const mine = FATE[me.outcome] ?? "Out of the race";
  if (me.outcome === gh.outcome && Math.abs(endDay(me) - endDay(gh)) < 0.05) return `${mine} on day ${d1(endDay(me))}, and so was the ghost.`;
  if (me.outcome === gh.outcome) return `${mine} on day ${d1(endDay(me))}; the ghost too, on day ${d1(endDay(gh))}.`;
  return `${mine} on day ${d1(endDay(me))}. Neither boat finished.`;
}

/**
 * The simulator's cause of a loss, in plain words (Leo): "both electronics boxes dead: silent and
 * uncontrolled" is "Both of her computers failed, and she went silent." `{w}` is where (and when)
 * it happened. First match wins; anything else (the joke fleet's own words) is said as it is.
 */
const PLAIN: [RegExp, string][] = [
  [/^both electronics boxes dead/, "Both of her computers failed{w}, and she went silent."],
  [/^electronics box dead/, "Her computer failed{w}, and she went silent."],
  [/^taken or snagged/, "Caught in fishing gear{w}."],
  [/^early-life defect/, "An early fault we can't name ended it{w}: the kind a shakedown trial is there to catch."],
  [/^capsized and stayed upside down/, "A breaking wave rolled her over{w}{hs}, and with nobody aboard she couldn't right herself."],
  [/^stuck inverted or keel lost/, "Rolled over{w}{hs}, and she stayed upside down."],
  [/^rolled by a breaking wave: dismasted and flooded/, "A breaking wave rolled her over{w}{hs}: she lost her mast and filled with water."],
  [/^broached and stayed over/, "A wave threw her on her side{w}, and she stayed over."],
  [/^capsized in a gust/, "A gust knocked her flat{w}, and she stayed over."],
  [/^flooded: the bilge pump lost power/, "She filled with water{w} once the pump lost power."],
  [/^flooded and sank/, "She filled with water and sank{w}."],
  [/^sail \(blown out/, "Her sail blew out{w}."],
  [/^silent more than (\d+) days in a row/, "Silent for more than $1 days in a row{w}, which is out under the race rules."],
  [/^silent more than (\d+) days in total/, "Silent for more than $1 days in all{w}, which is out under the race rules."],
  [/^swamped/, "Waves swamped her{w}."],
];
const FROM_OUTCOME: Record<string, string> = {
  aground: "She washed ashore{w}.",
  timeout: "She was still sailing{w} when the clock ran out.",
  at_sea: "She was still sailing{w}.",
  left_data_box: "She sailed off the edge of our weather map{w}.",
  lost: "She was lost at sea{w}.",
};

/** One sentence of how a boat's voyage ended. `when` adds the day ("on day 9.0"). */
export function plainEnding(e: Ending, outcome: string, when = ""): string {
  const where = [e.where, when].filter(Boolean).join(" ");
  const w = where ? ` ${where}` : "";
  if (outcome === "arrived") return `She crossed the finish line west of Lisbon${when ? ` ${when}` : ""}.`;
  // Running aground names only the spot ("38.62N 27.91W").
  if (/^\d+(\.\d+)?[NS]\s/.test(e.words)) return `She washed ashore at ${e.words}${when ? `, ${when}` : ""}.`;
  for (const [re, to] of PLAIN) {
    const m = re.exec(e.words);
    // The sea that did it, when the simulator says ("breaking seas, Hs 3.6 m").
    const hs = /Hs (\d+(?:\.\d+)?) m/.exec(e.words);
    if (m) return to.replace("$1", m[1] ?? "").replace("{w}", w).replace("{hs}", hs ? `, in waves of ${hs[1]} m` : "");
  }
  if (FROM_OUTCOME[outcome] && (e.words === "" || /^(lost at sea|washed up|still sailing|sailed out)/.test(e.words))) return FROM_OUTCOME[outcome].replace("{w}", w);
  return `${cap(e.words)}${w}.`;
}

/** One or two sentences of what happened, said once when both boats ended the same way; the day is left to the headline when it has it. */
export function story(c: Card, started: Started = BOTH): string {
  const me = c.boat;
  const gh = c.ghost;
  const tail = started.me ? "" : ` ${NO_START}`;
  if (me.outcome === "arrived" && gh.outcome === "arrived")
    return `Both boats crossed the line west of Lisbon: you after ${days(me.days)}, the ghost after ${days(gh.days)}.`;
  const same = me.ending && gh.ending && me.outcome === gh.outcome && me.ending.words === gh.ending.words && me.ending.where === gh.ending.where;
  if (same) {
    const luck = !c.breakdowns_differ ? " The ghost had the same bad luck: breakdowns roll the same dice for both boats." : " The ghost ended the same way.";
    return `${plainEnding(me.ending!, me.outcome)}${tail}${luck}`;
  }
  const dated = c.verdict !== "neither_finished" || !started.me;
  const say = (x: Side, who: string) => {
    if (!x.ending) return "";
    if (x.outcome === "arrived") return `${who} crossed the finish line west of Lisbon after ${days(x.days)}.`;
    const t = plainEnding(x.ending, x.outcome, dated || who === "The ghost" ? `on day ${d1(endDay(x))}` : "");
    return who === "You" ? t : `The ghost: ${t.charAt(0).toLowerCase()}${t.slice(1)}`;
  };
  return [say(me, "You") + tail, say(gh, "The ghost")].filter(Boolean).join(" ").trim();
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

/** "Day 2 · Rode the Gulf Stream · 120 km ahead of the ghost": what each call was worth, until the next one or the end. */
export function callLines(calls: Call[], endLead: number): string[] {
  if (!calls.length) return ["You let the autopilot sail. Next time, make a call when the clock stops."];
  return calls.map((k, i) => {
    const gain = Math.round((i + 1 < calls.length ? calls[i + 1].lead : endLead) - k.lead);
    const worth = Math.abs(gain) < 1 ? "level with the ghost" : `${Math.abs(gain).toLocaleString("en-US")} km ${gain > 0 ? "ahead of" : "behind"} the ghost`; // no signs (Elena)
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
export function leaves(c: Card, rate: number | null, boatName = "This build", started = true): string {
  if (!started) return rate === null ? "This one never reached the start, so it doesn't count as a race." : `${boatName} finishes ${Math.round(rate * 100)}% of launches. This one never reached the start, so it doesn't count as a race.`;
  if (rate === null) return c.boat.outcome === "arrived" ? "One voyage is one roll of the dice. Try another launch day to see more." : "One voyage is one roll of the dice. Play again, or try another launch day.";
  const pct = `${Math.round(rate * 100)}%`;
  const base = `${boatName} finishes ${pct} of launches.`;
  if (c.boat.outcome === "arrived") return `${base} This was one of them.`;
  if (rate >= 0.5) return `${base} This was one of the unlucky ones.`;
  return `${base} Try another design in the Boatyard?`;
}
