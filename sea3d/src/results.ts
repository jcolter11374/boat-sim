// The Results card's "where this leaves you" part (one-game plan, step 3): the
// race result, where the build stands on the design leaderboard, and the ways on
// (back to the Boatyard, race it, the leaderboard). Shared by the pages that end
// a voyage. All the numbers come from files the simulator wrote (the board from
// boatsim.mc.leaderboard, the odds from boatsim.mc.boatyard); this module only
// picks the right ones and words them. Text goes in with textContent only.

/** A leaderboard row (leaderboard/board.json summary.rows), as much as we need. */
export interface BoardRow {
  tier: number;
  design: string;
  label: string;
  finish_rate: number;
  ci95: [number, number];
  launches: number;
}
export interface Board {
  /** made: when the board was run ("2026-11-11T20:15Z"), sha: the sim commit; older boards lack both. */
  board: { launch_set: string; sample?: boolean; made?: string; sha?: string };
  summary?: { fair: boolean; rows: BoardRow[] };
}
/** A precomputed Boatyard build (boatyard/index.json builds[]), as much as we need. */
export interface GridBuild {
  id: string;
  label: string;
  odds?: { voyages: number; finished: number; odds: number; low95: number; high95: number; median_days?: number | null };
}
export interface Grid {
  odds_source?: { years: [number, number] };
  builds: GridBuild[];
}

/** Where a build stands. "board": on the leaderboard; "odds": only the Boatyard's odds; "none": neither. */
export type Standing =
  | { kind: "board"; rank: number; of: number; tier: number; tiers: number; inTier: number; row: BoardRow; launchSet: string; made: string | null }
  | { kind: "odds"; build: GridBuild; years: [number, number] | null }
  | { kind: "none" };

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Where `build` (a Boatyard build id, catalog.grid_id) stands. The board wins
 * when the build is on it and the board is fair (and not the sample board); its
 * rank counts the rows with a strictly higher finish rate, so equal rates share
 * a place. The Boatyard's odds come from another launch set (2012-2021, against
 * the board's own years), so they are never given a board place.
 */
export function standing(build: string, board: Board | null, grid: Grid | null): Standing {
  const rows = board?.summary?.fair && !board.board.sample ? board.summary.rows : [];
  const row = rows.find((r) => r.design === build);
  if (row && board) {
    return {
      kind: "board",
      rank: 1 + rows.filter((r) => r.finish_rate > row.finish_rate).length,
      of: rows.length,
      tier: row.tier,
      tiers: Math.max(...rows.map((r) => r.tier)),
      inTier: rows.filter((r) => r.tier === row.tier).length,
      row,
      launchSet: board.board.launch_set,
      made: board.board.made ?? null,
    };
  }
  const g = grid?.builds.find((b) => b.id === build && b.odds);
  if (g) return { kind: "odds", build: g, years: grid?.odds_source?.years ?? null };
  return { kind: "none" };
}

/** The standing in plain words: one sentence, and a second line of detail.
 *  Board wording leads with the group, not the place (Ravi): boats in one group
 *  can't be told apart on the board's launches, so a place alone overclaims. */
export function standingText(s: Standing): { head: string; detail: string } {
  if (s.kind === "board") {
    const r = s.row;
    const when = boardDay(s.made);
    const on = when ? `On the board of ${when}` : "On the leaderboard (board date unknown)";
    const rate = `It finishes ${pct(r.finish_rate)} of ${r.launches} launches.`;
    const range = `Likely range ${pct(r.ci95[0])} to ${pct(r.ci95[1])}.`;
    if (s.tiers <= 1)
      return {
        head: `${on}: all ${s.of} boats are in one group, which these launches can't tell apart. ${rate}`,
        detail: range,
      };
    const others = s.inTier - 1;
    const group = `${s.tier === 1 ? "the top" : `the ${ordinal(s.tier)}`} of ${s.tiers} groups`;
    const with_ = others === 0 ? "on its own there" : `with ${others} other boat${others === 1 ? "" : "s"} it can't be told apart from`;
    return {
      head: `${on}: in ${group}, ${with_}. ${rate}`,
      detail: `${ordinal(s.rank)} of ${s.of} by finish rate. ${range}`,
    };
  }
  if (s.kind === "odds") {
    const o = s.build.odds!;
    const yrs = s.years ? ` (${s.years[0]} to ${s.years[1]})` : "";
    return {
      head: `Not on the leaderboard yet. The simulator gives it ${pct(o.odds)} over ${o.voyages} launches${yrs}.`,
      detail: `Likely range ${pct(o.low95)} to ${pct(o.high95)}. One voyage is one roll of the dice; these odds are the better guide.`,
    };
  }
  return { head: "No odds for this boat yet.", detail: "One voyage is one roll of the dice: sail it again on another launch to see more." };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-11T20:15Z" -> "11 Nov" (the UTC day, read off the string: no time zone guessing). Null if unreadable. */
export function boardDay(made: string | null): string | null {
  const m = made ? /^(\d{4})-(\d\d)-(\d\d)/.exec(made) : null;
  const mo = m ? Number(m[2]) : 0;
  return m && mo >= 1 && mo <= 12 ? `${Number(m[3])} ${MONTHS[mo - 1]}` : null;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

/** The ways on from Results. `boatyard` is the link that reopens this design
 *  (the remembered "my boat", myboat.ts myBoatYardLink, when there is one). */
export function nextLinks(build: string, boatyard = "./boatyard.html"): { label: string; href: string }[] {
  return [
    { label: "Back to the Boatyard", href: boatyard },
    { label: "Race it", href: "./race.html" },
    { label: "Leaderboard", href: `./leaderboard.html#${encodeURIComponent(build)}` },
  ];
}

/** Fetch a JSON file, or null when it isn't there (the board is published only
 *  when fair) or a host answers with an HTML page instead. */
export async function maybeJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

/** Fill `box` with the standing and the links (textContent only). */
export function renderNext(box: HTMLElement, build: string, s: Standing, boatyard?: string): void {
  const t = standingText(s);
  const head = document.createElement("p");
  head.className = "standing";
  head.textContent = t.head;
  const detail = document.createElement("p");
  detail.className = "muted";
  detail.textContent = t.detail;
  const links = document.createElement("div");
  links.className = "next";
  for (const l of nextLinks(build, boatyard)) {
    const a = document.createElement("a");
    a.href = l.href;
    a.textContent = l.label;
    links.append(a);
  }
  box.replaceChildren(head, detail, links);
}
