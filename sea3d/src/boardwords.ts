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
export function versusWords(v: Versus): { head: string; tone: "good" | "bad" | ""; detail: string } {
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
      tone: better ? "good" : "bad",
      detail,
    };
  }
  // Not clear: we can't tell them apart, which isn't the same as equal (Ravi). "About
  // the same" only when the gap itself is small too.
  if (n < 3) return { head: "About the same as our kayak on these launches", tone: "", detail };
  return {
    head: `Can't tell apart from our kayak on these launches: about ${n} ${v.gap > 0 ? "more" : "fewer"} per 100, which could be luck`,
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
