/**
 * When the voyage is over for the person at the screen: the speed bar, the pause and the speed keys go.
 *
 * The simulator runs a little ahead of the picture, so "over" in its status comes before the boat on
 * screen gets there. When you steer, that's the moment the clock stops and the last hours play out
 * on their own. When you only watch (a recorded voyage, a race) nothing has stopped for you: the bar
 * stays, at the speed you chose, Real time included, until the picture reaches the voyage's last row.
 */
export function voyageDone(over: boolean, spectating: boolean, hour: number, shownTo: number): boolean {
  if (!over) return false;
  return !spectating || hour >= shownTo - 1e-6;
}

/** Hours of picture to play this frame while a watched voyage runs out: the chosen speed, an hour a second over the last three. */
export function runOutStep(rate: number, dt: number, hour: number, shownTo: number): number {
  const r = shownTo - hour < 3 ? Math.min(rate, 1) : rate;
  return Math.min(shownTo, hour + dt * r);
}

/** A stop with no call in it (a part failing, a pass, a silence): the picture plays its last
 * hours at an hour a second, so at speed the stop is seen arriving, not jumped to (M5, D3). */
export const STOP_SLOW_H = 3;
/** The slow stretch before a stop at voyage hour `h`: where it starts and ends. */
export function stopStretch(h: number, lead = STOP_SLOW_H): { from: number; h: number } {
  return { from: h - lead, h };
}
/** The picture is inside a slow stretch (before a call or a stop). */
export function inStretch(s: { from: number; h: number } | null, hour: number): boolean {
  return !!s && hour >= s.from && hour < s.h;
}
/** Hours of picture to play this frame while the clock is stopped and the picture catches up to
 * the stop: the speed the clock had, an hour a second inside a slow moment or stretch. A fast
 * frame stops at the start of the stretch ahead (`slowFrom`) rather than jumping into it: at four
 * days a second one frame is over an hour and a half. */
export function drainStep(rate: number, dt: number, hour: number, shownTo: number, slow: boolean, slowFrom?: number): number {
  const to = !slow && slowFrom !== undefined && slowFrom > hour ? Math.min(shownTo, slowFrom) : shownTo;
  return Math.min(to, hour + dt * (slow ? Math.min(rate, 1) : rate));
}

/** When you steer, the game looks for a call after every run of the simulator, so a run is never
 * longer than this many voyage hours: a gale is looked for 2 days ahead and the first chase only
 * in a crossing's first 5 days, and at 4 days a second a 72-hour run stepped right over both. */
export const CALL_CHECK_H = 24;
/** Voyage hours for one run of the simulator, ahead of the picture: about a second and a half of
 * play at the chosen speed, at least an hour, at most 72 (watching) or CALL_CHECK_H (steering). */
export function runHours(rate: number, steering: boolean): number {
  return Math.min(steering ? CALL_CHECK_H : 72, Math.max(1, rate * 1.5));
}

/** While the navigator looks at the forecast (route check, chase, the Stream), the simulator
 * waits, so the picture can only play what it already has (`ahead` hours). It used to play that
 * at full speed and then stop dead until the look was done: 3 to 8 s, and over 30 s in Firefox,
 * at 4 days a second on the test computers (Nina, 14 Nov). Now it spreads what it has over the
 * time the look is expected to take, so the picture slows and keeps moving instead of freezing.
 * Returns the speed to play at (hours a second): never above `rate`, and at least `floor` so the
 * picture never quite stops. leftS: seconds of look still expected. */
export function lookPace(rate: number, ahead: number, leftS: number, floor = 0.05): number {
  if (!(ahead > 0)) return 0;
  return Math.min(rate, Math.max(floor, ahead / Math.max(0.5, leftS)));
}

/** How long a look is expected to take (s): the last ones, smoothed; the first guess is 3 s. */
export function lookExpect(prevS: number | null, tookS: number): number {
  return prevS === null ? tookS : 0.5 * prevS + 0.5 * tookS;
}
