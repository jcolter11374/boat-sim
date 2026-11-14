// A rough start, told before and after (Elena, 14 Nov, from Rosa's feel write-up item 7): on
// 1 April 2020 the first thing a player read was "Knocked flat by a breaking wave" at day 0.0,
// with no warning. The knockdown stays (it is that day's sea); the Set sail card now says it is
// coming, and the note says it happened just after the drop and whether she came back upright.
//
// Pure words and data, no page: tests/roughStart.test.ts.

/** Hours after the drop that count as "the start", for the card and for the note. */
export const START_H = 12;
/** Worst waves (m) in the first 12 hours at the drop, for each launch day over 3 m. From the
 * forecast as the game issues it at the drop (forcing_2020.npz, rows at 0, 6 and 12 h):
 * 1 April 4.6, 4.5, 3.7; 1 May 3.8, 3.1, 2.6. Every other launch day is 2.5 m or under. */
export const START_WAVES: Record<string, number> = { "2020-04-01": 4.6, "2020-05-01": 3.8 };
/** Over this, the card warns. */
export const ROUGH_START_M = 3;

/** The line under the day pills, or "" for a launch day without a rough start. */
export function roughStartLine(day: string | null | undefined): string {
  const hs = day ? START_WAVES[day] : undefined;
  if (hs == null || hs <= ROUGH_START_M) return "";
  return `Rough start: waves of ${Math.round(hs)} m at the drop. She may be knocked flat in the first hours.`;
}

/** A knockdown's note. In the first hours it says "just after the drop", and "She came back
 * upright." only when she did (`lost`: the same wave left her upside down for good). Later, the
 * words as before. times: knockdowns in that hour; hs: the waves, as the log gives them. */
export function knockdownNote(h: number, times: number, hs: string, lost: boolean): string {
  const m = "\u00a0m"; // no-break space: "m" never wraps alone (as replay/data.ts)
  if (h > START_H) return `Knocked flat by a breaking wave${times !== 1 ? ` (${times} times)` : ""}, waves ${hs}${m}`;
  const n = times === 1 ? "" : times === 2 ? " twice" : ` ${times} times`;
  return `Knocked flat${n} by a breaking wave just after the drop (waves ${hs}${m}).${lost ? "" : " She came back upright."}`;
}
