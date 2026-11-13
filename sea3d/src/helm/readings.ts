// The side panel's readings at the moment the picture shows.
//
// The simulator runs ahead of the picture in short runs and hands back one status per run (up to 72 hours
// of voyage after playing fast). The panel used to show the last status the picture had passed, so its
// wind, battery, distance and lead could be a day or more behind the strip, which reads the track's rows at
// the picture's hour. This makes the status the panel draws from those same rows, so one screen gives one
// answer. Pure: no DOM here.

import { angleAt, distanceKm, lastHour, valueAt, type Replay } from "../replay/data";
import type { BoatNow, Status } from "./game";

/** A boat's readings from its own rows at `hour`; the status's own where the track has none yet. */
function boatAt(now: BoatNow, rep: Replay, hour: number): BoatNow {
  const end = lastHour(rep);
  const h = Math.min(hour, end);
  const lat = valueAt(rep, rep.lat, h);
  const lon = valueAt(rep, rep.lon, h);
  if (lat == null || lon == null) return now;
  const radius = rep.course.target_radius_m / 1000;
  const there = hour >= end - 1e-6; // the picture has reached this boat's last row
  return {
    ...now,
    lat,
    lon,
    heading: angleAt(rep, rep.heading, h) ?? now.heading,
    stw: valueAt(rep, rep.stw, h) ?? now.stw,
    soc: valueAt(rep, rep.soc, h) ?? now.soc,
    km_to_finish: there && now.outcome === "arrived" ? 0 : Math.max(distanceKm([lat, lon], rep.course.target as [number, number]) - radius, 0),
    // How she ends isn't told before the picture gets there.
    outcome: there ? now.outcome : "at_sea",
  };
}

/**
 * The status as the picture shows it at `hour`: the boats' positions, speed, battery, distance to go, the
 * lead and the weather come from the tracks' rows at that hour, whether the status is ahead of the picture
 * (the simulator's latest) or behind it (the last one the picture passed). At the status's own moment the
 * status is returned as it is: the simulator's figures are the exact ones.
 */
export function statusAtPicture(s: Status, boat: Replay | null, ghost: Replay | null, hour: number): Status {
  if (!boat || !boat.h.length || Math.abs(hour - s.day * 24) < 0.02) return s;
  const b = boatAt(s.boat, boat, hour);
  if (b === s.boat) return s; // nothing logged yet
  const g = ghost && ghost.h.length ? boatAt(s.ghost, ghost, hour) : s.ghost;
  const h = Math.min(hour, lastHour(boat));
  const at = (col: Replay["hs"]) => valueAt(boat, col, h);
  const [wu, wv, hs, cu, cv] = [at(boat.wind_u), at(boat.wind_v), at(boat.hs), at(boat.current_u), at(boat.current_v)];
  const weather = s.weather && wu != null && wv != null ? { ...s.weather, wind_u: wu, wind_v: wv, hs: hs ?? s.weather.hs, current_u: cu ?? s.weather.current_u, current_v: cv ?? s.weather.current_v } : s.weather;
  return { ...s, boat: b, ghost: g, lead_km: g.km_to_finish - b.km_to_finish, weather };
}
