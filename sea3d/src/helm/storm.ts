// Where a challenge's storm is, from the boat (Ravi, for Sandy's shadow). One function
// for both the goal chip ("storm centre 380 km", Rosa) and the storm wall on the
// horizon (Hana), so the two always agree. The track is the stars check's
// storm_hourly: [ISO time, lat, lon], one row an hour (tools/challenge_stars.py).

export type StormRow = [string, number, number];

const R_KM = 6371;
const rad = (d: number) => (d * Math.PI) / 180;

/** The storm centre at time t (ms since 1970), straight-line between rows; null outside the track. */
export function centreAt(track: StormRow[], t: number): { lat: number; lon: number } | null {
  if (!track.length) return null;
  const ts = track.map((r) => Date.parse(r[0]));
  if (t < ts[0] || t > ts[ts.length - 1]) return null;
  let i = 0;
  while (i < ts.length - 2 && ts[i + 1] < t) i++;
  const f = ts[i + 1] === ts[i] ? 0 : (t - ts[i]) / (ts[i + 1] - ts[i]);
  const [, a0, o0] = track[i];
  const [, a1, o1] = track[Math.min(i + 1, track.length - 1)];
  return { lat: a0 + f * (a1 - a0), lon: o0 + f * (o1 - o0) };
}

/** Compass bearing (0 = north, clockwise) and great-circle km from the boat to the storm centre at t. */
export function stormFromBoat(track: StormRow[], t: number, lat: number, lon: number): { bearing: number; km: number } | null {
  const c = centreAt(track, t);
  if (!c) return null;
  const p1 = rad(lat), p2 = rad(c.lat), dl = rad(c.lon - lon);
  const a = Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const km = 2 * R_KM * Math.asin(Math.sqrt(a));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return { bearing, km };
}
