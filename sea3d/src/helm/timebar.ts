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
