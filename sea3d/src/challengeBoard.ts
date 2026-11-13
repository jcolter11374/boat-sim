// The leaderboard's "Weather challenges" tab (M3 piece L2; John, W5: weather challenges have
// their own tab, not the main board). Each challenge with your best try beside the autopilot's,
// from what this browser has kept (helm/challengeBest.ts). Pure: the page only lays these rows out.

import { startLabel, type Challenge } from "./helm/challenges";
import { runWords, type ChallengeBest } from "./helm/challengeBest";

export type BoardTab = "designs" | "challenges";

/** Which tab a link opens: leaderboard.html#challenges; anything else is the designs board (a build's name marks its row there). */
export function boardTab(hash: string): BoardTab {
  return hash.replace(/^#/, "") === "challenges" ? "challenges" : "designs";
}

export const CHALLENGE_BOARD_WORDS = {
  tabs: { designs: "Designs", challenges: "Weather challenges" },
  sub: {
    designs: "Which builds reach the finish most often, on the same launches with the same luck.",
    challenges: "Your best try at each weather challenge, beside the autopilot's on the same weather.",
  },
  kept: "Your results are kept in this browser only. Nobody else sees them, and clearing the browser's data clears them.",
  none: "Not sailed yet",
  noAutopilot: "",
  sail: "Sail it",
  again: "Try again",
  missing: "The weather challenges aren't on this copy of the game.",
} as const;

export interface ChallengeRow {
  id: string;
  title: string;
  /** "22 Oct 2012": the real weather it sails. */
  when: string;
  /** Has it been sailed in this browser? */
  tried: boolean;
  /** "★★☆ in 6.0 days", or "Not sailed yet". */
  yours: string;
  /** The boat that sailed your best (the player's own name for her: text only), and how many tries: "Petrel · 3 tries". */
  detail: string;
  /** The autopilot on that same try; "" when the card didn't say or it hasn't been sailed. */
  autopilot: string;
  /** Did your best beat the autopilot's? null when there is nothing to compare. */
  ahead: boolean | null;
  /** The Set sail card with this challenge picked. */
  href: string;
  link: string;
}

/** The tab's rows, in the challenges' own order (their number). */
export function challengeRows(list: Challenge[], bests: Record<string, ChallengeBest>): ChallengeRow[] {
  const W = CHALLENGE_BOARD_WORDS;
  return [...list]
    .sort((a, b) => a.n - b.n)
    .map((c) => {
      const b = bests[c.id];
      const tries = b ? `${b.tries} ${b.tries === 1 ? "try" : "tries"}` : "";
      const a = b?.autopilot ?? null;
      const ahead = !b || !a ? null : (b.best.stars ?? -1) !== (a.stars ?? -1) ? (b.best.stars ?? -1) > (a.stars ?? -1) : b.best.finished !== a.finished ? b.best.finished : b.best.finished ? b.best.days < a.days : null;
      return {
        id: c.id,
        title: c.title,
        when: startLabel(c),
        tried: !!b,
        yours: b ? runWords(b.best) : W.none,
        detail: b ? [b.boat, tries].filter(Boolean).join(" · ") : "",
        autopilot: a ? runWords(a) : W.noAutopilot,
        ahead,
        href: `./helm.html?challenge=${encodeURIComponent(c.id)}`,
        link: b ? W.again : W.sail,
      };
    });
}
