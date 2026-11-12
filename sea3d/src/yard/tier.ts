// The leaderboard's groups, for colouring the Boatyard's odds (Milo, 12 Nov): green for
// Best, plain for Good, amber for Long shot. A build not on the board stays plain.

/** Build id to the board's group number (1 = Best). */
export type BoardTiers = Map<string, number>;

export function tierOf(tiers: BoardTiers | null, id: string): "" | "best" | "good" | "long" {
  const t = tiers?.get(id);
  if (!tiers || t === undefined) return "";
  const last = Math.max(...tiers.values());
  if (t === 1) return "best";
  return t === last ? "long" : "good";
}
