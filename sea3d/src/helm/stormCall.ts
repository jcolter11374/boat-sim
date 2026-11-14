// The storm call's options (Rosa's feel write-up, 14 Nov; Maya's pick 2): "turn away" is offered
// only when the forecast says it really is calmer. On 1 April 2020 every storm card asked "Hold
// course / Turn south-east / Slow down", and turning was no calmer (5.6 m against 5.4 m, and
// 145 km lost for 0.5 m less in a 9 m gale), so holding course won on every number shown and
// the card asked nothing. The price is the route check's own: 0.75 m of worst waves.
//
// Pure rules, no page: tests/stormCall.test.ts.

/** Turning away is a choice only if its worst waves over the look are this much lower. */
export const DODGE_CALMER_M = 0.75;

/** Which of the storm card's options to keep, given each one's worst waves over the 4-day look
 * (null: no forecast for it). The options are, in order: hold course, turn away, and (with
 * motors) slow down. Holding course is always kept; slowing down is a trade of time for battery
 * and stays; turning away stays only when it is calmer. No forecast at all: keep them all. */
export function stormKeep(hsMax: (number | null | undefined)[]): boolean[] {
  const hold = hsMax[0];
  return hsMax.map((hs, i) => i !== 1 || hold == null || hs == null || hold - hs >= DODGE_CALMER_M);
}

/** When only "hold course" is left there is nothing to ask: a note, and she holds course. */
export function stormNote(intro: string): string {
  return `${intro} The forecast shows no calmer way round, so she holds course.`;
}
