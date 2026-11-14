// The second-half routing card (Rosa, 14 Nov; John's mid-ocean pick: weather routing only).
// Measured in gameplay/m5-cards/routing-findings.md with callsim.py's "router" player, who took
// every faster line the route check found at no price and steered it until the next look:
// lines the forecast put under 90 km ahead over 4 days lost on the median (34 km from day 15 on),
// because the autopilot re-routes all the time and a held heading doesn't. Lines of 90 km or more
// paid 7 times in 8 (one lost 95 km). So the small ones are no longer told, and the navigator's note
// for a big one says it is a gamble and gives the odds (the same note as before, honest words).

/** A free line the forecast puts this far ahead (km, over the 4-day look) is still told. Measured, 8 cases. */
export const ROUTE_BIG_KM = 90;

/** The card's words. `deg` like "095°", `ours` like "the autopilot's line", `change` from timeChange. */
export function routeBigText(deg: string, ours: string, change: string): string {
  return (
    `Navigator's note: the forecast puts ${deg} well ahead of ${ours}, ${change} over the next 4 days, in no worse seas. ` +
    "It's a gamble: she'd leave the autopilot's line for days, and a forecast is a guess. " +
    "In our test crossings, lines forecast this far ahead paid off 7 times in 8; the other lost about 95 km. To take it, change it in Orders."
  );
}
