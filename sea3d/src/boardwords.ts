// The design leaderboard in a player's words (#318, Nina's first-time pass):
// the launch set as a sentence, the comparison with our kayak without
// statistician's notation, and the badges every kayak row shares said once.
// The numbers all come from boatsim.mc.leaderboard's summary; this only words them.

const MONTHS: Record<string, string> = {
  Jan: "January", Feb: "February", Mar: "March", Apr: "April", May: "May", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December",
};

/** "2015-2019-AprJun-every7d-v1" -> "April to June launches every 7 days, 2015 to 2019". Unknown shapes come back as they are. */
export function launchSetWords(id: string): string {
  const m = /^(\d{4})-(\d{4})-([A-Z][a-z]{2})([A-Z][a-z]{2})-every(\d+)d-v\d+$/.exec(id);
  if (!m || !MONTHS[m[3]] || !MONTHS[m[4]]) return id;
  const years = m[1] === m[2] ? m[1] : `${m[1]} to ${m[2]}`;
  return `${MONTHS[m[3]]} to ${MONTHS[m[4]]} launches every ${m[5]} days, ${years}`;
}

/** The hidden check's year(s): "2021", or "2020 to 2021". */
export function launchSetYears(id: string): string {
  const m = /^(\d{4})-(\d{4})-/.exec(id);
  return !m ? id : m[1] === m[2] ? m[1] : `${m[1]} to ${m[2]}`;
}

export interface Versus {
  gap: number;
  ci95: [number, number];
  gained: number;
  lost: number;
  clear: boolean;
}

const per100 = (x: number) => Math.abs(Math.round(x * 100));
const signed = (x: number) => `${x >= 0 ? "+" : "−"}${per100(x)}`;
/** A clear result's range end, rounded away from zero, so it never reads "−0" or "+0" (Ravi). */
const awayFromZero = (x: number) => `${x >= 0 ? "+" : "−"}${Math.max(1, Math.ceil(Math.abs(x) * 100 - 1e-9))}`;

/** A design against our kayak: a plain headline ("good", "bad" or "" for its colour) and a statistics line. */
/** A design against our kayak: a plain headline ("good", "bad" or "" for its colour), a
 *  statistics line, and the short cell words (Milo M8: "Same as ours", "Maybe worse (could
 *  be luck)", "Worse: 12 fewer finishes in 100"); the headline goes behind the cell's "i". */
export function versusWords(v: Versus): { head: string; short: string; tone: "good" | "bad" | ""; detail: string } {
  const n = per100(v.gap);
  const launches = (k: number) => `${k} launch${k === 1 ? "" : "es"}`;
  const end = v.clear ? awayFromZero : signed;
  const detail =
    `Likely range ${end(v.ci95[0])} to ${end(v.ci95[1])} finishes per 100. ` +
    `It finished ${launches(v.gained)} our kayak didn't, and missed ${launches(v.lost)} our kayak made.`;
  if (v.clear && n > 0) {
    const better = v.gap > 0;
    return {
      head: `Clearly ${better ? "better" : "worse"}: about ${n} ${better ? "more" : "fewer"} finishes per 100 launches`,
      short: `${better ? "Better" : "Worse"}: ${n} ${better ? "more" : "fewer"} finishes in 100`,
      tone: better ? "good" : "bad",
      detail,
    };
  }
  // Not clear: we can't tell them apart, which isn't the same as equal (Ravi). "About
  // the same" only when the gap itself is small too.
  if (n < 3) return { head: "About the same as our kayak on these launches", short: "Same as ours", tone: "", detail };
  return {
    head: `Can't tell apart from our kayak on these launches: about ${n} ${v.gap > 0 ? "more" : "fewer"} per 100, which could be luck`,
    short: `Maybe ${v.gap > 0 ? "better" : "worse"} (could be luck)`,
    tone: "",
    detail,
  };
}

/** Badges on every kayak row ("k-..." designs) and on no other row: say them once above the table. */
export function sharedKayakBadges(rows: { design: string; badges: string[] }[]): string[] {
  const kayaks = rows.filter((r) => r.design.startsWith("k-"));
  if (kayaks.length < 2) return [];
  const others = rows.filter((r) => !r.design.startsWith("k-"));
  return kayaks[0].badges.filter((b) => kayaks.every((r) => r.badges.includes(b)) && !others.some((r) => r.badges.includes(b)));
}

/** The leaderboard's headline (Leo, audit item 9): who's best, in a sentence.
 *  top: the top group's names in board order, with their finish rates. */
export function bestHeadline(top: { label: string; finish_rate: number }[], groups: number): string {
  if (!top.length) return "";
  const rates = top.map((r) => r.finish_rate).sort((a, b) => a - b);
  const mid = rates[Math.floor((rates.length - 1) / 2)];
  const pct = `${Math.round(mid * 100)}%`;
  if (groups <= 1) return `Too close to call: every boat finishes about ${pct} of the time.`;
  const first = top[0].label; // as the rows write it, capital O and all (Ines)
  if (top.length === 1) return `Best: ${first}, about ${pct} finish.`;
  const n = top.length - 1;
  return `Best: ${first} and ${n} other${n === 1 ? "" : "s"}, about ${pct} finish.`;
}

/** A group's tier in words (Milo M7, Elena approved): the first group is "Best", the
 *  last "Long shot", any between "Good". Never "Poor": Randolph's team reads this board. */
export function tierName(tier: number, groups: number): string {
  if (tier <= 1) return "Best";
  return tier >= groups ? "Long shot" : "Good";
}

/** A collapsed group's one row (Milo M6). The Best group: "Our kayak and 4 builds just
 *  as good". Any other group never says "just as good" (a 15% boat, and Randolph's team
 *  reads this): two or three builds are named ("Randolph Rev C5 and Rev B"), more are
 *  "{first} and N more". names: lead first (the reference build when it's in the group). */
export function groupSummary(names: string[], best: boolean): string {
  const short = names.map((n) => n.replace(/, as built$/, ""));
  const n = short.length - 1;
  if (n <= 0) return names[0] ?? "";
  if (best) return `${short[0]} and ${n} boat${n === 1 ? "" : "s"} just as good`;
  if (short.length > 3) return `${short[0]} and ${n} more`;
  // "Randolph Rev C5 and Rev B": say the team's name once.
  const team = /^(Randolph )/.exec(short[0])?.[1];
  const rest = short.slice(1).map((x) => (team && x.startsWith(team) ? x.slice(team.length) : x));
  const all = [short[0], ...rest];
  return all.length === 2 ? `${all[0]} and ${all[1]}` : `${all[0]}, ${all[1]} and ${all[2]}`;
}
