// Going by the Azores (John, 24 Nov 2026: "There doesn't seem to be enough land. You are just floating in
// the middle of water the whole time"; asked which land to add, he chose "Azores and a dock in Portugal").
// The autopilot's route is the great circle, which passes 160 to 500 km north of the islands, out of sight.
// Once a crossing, in mid-ocean, the player is asked whether to go by them. A yes hands her to the autopilot
// with two marks on its route (src/boatsim/autonomy/helm.py AZORES_MARKS): open water south of Flores, then
// 30 km south of Pico, whose mountain (2,351 m) stands 41 km to the north as she passes. Then the finish,
// which is where the race's rules put it, as ever. It is a real order the simulator sails in the real
// weather, and it costs real days: the numbers below are measured (docs/qa/azores-pass-2026-11.md).

/** Asked between these longitudes (degrees east): far enough out to make the turn gently, and west of where the simulator still takes the order (33W). */
export const AZORES_ASK = { west: -44, east: -36 };
/** The mark south of Pico, for the distance on the card. */
export const AZORES_OFF_PICO: [number, number] = [38.1, -28.35];
/**
 * What going by the Azores cost against the autopilot's own route (measured, all 91 launch days of April to
 * June 2020; the order was taken on 71). Days: the middle crossing of the 58 that finished both ways (3.9),
 * the range 8 in 10 of them fell in (1.3 to 7.0) and the worst (10.3). Lost: of the 64 the autopilot's route
 * finished, 6 did not finish by the islands (5 taken or snagged by fishing boats, which the simulator risks
 * within 150 km of any land; 1 disqualified, out of time).
 */
export const AZORES_COST = { typical: 4, low: 1, high: 7, worst: 10, lostOneIn: 10 };

/** Whether the call is due at this longitude. */
export function azoresDue(lon: number, asked: boolean, via: boolean): boolean {
  return !asked && !via && lon >= AZORES_ASK.west && lon < AZORES_ASK.east;
}

/** The card's words. `km`: how far off the islands are. */
export function azoresText(km: number): string {
  const n = Math.round(km / 50) * 50;
  return (
    `The Azores are about ${n.toLocaleString("en-GB")} km ahead and to the south: volcanic islands, the only land between America and Europe. ` +
    `The autopilot's route passes far to the north of them, out of sight. Going by them takes about ${AZORES_COST.typical} days longer, and near land there are fishing boats: about 1 crossing in ${AZORES_COST.lostOneIn} that went this way did not finish. Go by them?`
  );
}

/** The yes option: what you get and what it costs, in one line. */
export function azoresYes(): string {
  return `Go by the Azores: land in sight, about ${AZORES_COST.typical} days longer, and a risk`;
}
/** The yes option's small print (the button's title). */
export function azoresSmallPrint(): string {
  return (
    `The autopilot takes her 30 km south of Pico, under its 2,351 m mountain, then on to the same finish line. ` +
    `Most of our test crossings took ${AZORES_COST.low} to ${AZORES_COST.high} days longer than the autopilot's own route, and the worst ${AZORES_COST.worst}, so the ghost will pull ahead. ` +
    `Islands mean fishing boats and their gear: about 1 crossing in ${AZORES_COST.lostOneIn} that would have finished did not, most of them taken or snagged within 150 km of the islands.`
  );
}

/** The note once she has turned. `days`: about how long until the islands. */
export function azoresNote(days: number): string {
  const d = Math.max(1, Math.round(days));
  return `Going by the Azores. The autopilot now steers south of Pico; its mountain should come into sight in about ${d} day${d === 1 ? "" : "s"}. Then on to the finish.`;
}
