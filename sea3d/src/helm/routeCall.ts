// The second-half routing note (Rosa, 14 Nov; John's mid-ocean pick: weather routing only).
// Measured in gameplay/m5-cards/routing-findings.md with callsim.py's "router" player, who took
// every faster line the route check found at no price and steered it until the next look:
// lines the forecast put under 90 km ahead over 4 days lost on the median (34 km from day 15 on),
// because the autopilot re-routes all the time and a held heading doesn't. Lines of 90 km or more
// paid 7 times in 8 (one lost 95 km). So the small ones are no longer told, and the navigator's note
// for a big one says it is a gamble and gives the odds (the same note as before, honest words).

/** A free line the forecast puts this far ahead (km, over the 4-day look) is still told. Measured, 8 cases. */
export const ROUTE_BIG_KM = 90;

/** The note's words (Elena, 14 Nov). `deg` like "095°"; `km` the forecast's gain on the ghost over 4 days.
 *  Plain heading words, right whether she is on the autopilot or a set heading. */
export function routeBigText(deg: string, km: number): string {
  const n = Math.max(5, Math.round(km / 5) * 5);
  return (
    `Navigator's note: the forecast says steering ${deg} would gain about ${n} km on the ghost over the next 4 days, in no worse seas. ` +
    "It's a gamble: she'd hold that heading for days, and forecasts can be wrong. " +
    "In our test crossings, a lead forecast this big paid off 7 times in 8; the other time she lost about 95 km. To try it, change her heading in Orders."
  );
}
