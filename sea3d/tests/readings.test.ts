// The side panel's readings at the picture's hour (src/helm/readings.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { statusAtPicture } from "../src/helm/readings.ts";
import { distanceKm, type Replay } from "../src/replay/data.ts";
import type { Status } from "../src/helm/game.ts";

const TARGET: [number, number] = [39.5, -13.5];
/** A boat sailing east along 37N, one row an hour for `n` hours, `kmh` km each hour; the wind backs and the battery runs down. */
function track(n: number, kmh: number, outcome = "at_sea"): Replay {
  const h = Array.from({ length: n + 1 }, (_, i) => i);
  const col = (f: (i: number) => number) => h.map(f);
  return {
    schema: 1, boat: "test", start: "2020-04-15T12:00", end: null, seed: 1, outcome, days: n / 24, t_start_line: null, t_finish_line: null,
    course: { drop: [37, -74], west_line: [], east_line: [], target: TARGET, target_radius_m: 25000 },
    h, lat: col(() => 37), lon: col((i) => -74 + (i * kmh) / 88.8), heading: col(() => 90), stw: col(() => 1), soc: col((i) => 1 - i / 200),
    wind_u: col((i) => 5 + i / 10), wind_v: col(() => 0), hs: col((i) => 1 + i / 100), tp: col(() => 8), wave_dir: col(() => 270), current_u: col(() => 0.1), current_v: col(() => 0), ghi: col(() => 0), events: [],
  };
}
const boat = track(72, 4);
const ghost = track(72, 3);
const now = (rep: Replay, i: number, outcome = "at_sea") => ({ t: "2020-04-18T12:00", lat: 37, lon: rep.lon[i]!, heading: 90, stw: 1, soc: rep.soc[i]!, km_to_finish: distanceKm([37, rep.lon[i]!], TARGET) - 25, outcome });
/** The status at the end of a 72 h run: what the panel used to show the whole way through it. */
const status: Status = {
  day: 3, over: false, boat: now(boat, 72), ghost: now(ghost, 72, "lost"), lead_km: 0, order: { heading: "auto", power: 0.25 }, power_w: 10,
  weather: { wind_u: 12.2, wind_v: 0, hs: 1.72, tp: 8, wave_dir: 270, current_u: 0.1, current_v: 0, ghi: 0, rain: 0 },
} as Status;
status.lead_km = status.ghost.km_to_finish - status.boat.km_to_finish;

test("while the picture is behind the status, the readings are the rows' at the picture's hour", () => {
  const s = statusAtPicture(status, boat, ghost, 12);
  assert.ok(Math.abs(s.boat.soc - (1 - 12 / 200)) < 1e-9);
  assert.ok(Math.abs(s.weather!.wind_u - 6.2) < 1e-9, "the wind 12 hours in, not 72");
  assert.ok(Math.abs(s.weather!.hs - 1.12) < 1e-9);
  assert.ok(Math.abs(s.boat.km_to_finish - (distanceKm([37, boat.lon[12]!], TARGET) - 25)) < 1e-6);
  // 12 hours in the boats are about 12 km apart along their track, not the 72 km of the status.
  assert.ok(s.lead_km > 10 && s.lead_km < 13, `lead ${s.lead_km}`);
  assert.ok(status.lead_km > 60 && status.lead_km < 75, `status lead ${status.lead_km}`);
  assert.equal(s.lead_km, s.ghost.km_to_finish - s.boat.km_to_finish);
});

test("how a boat ends isn't told before the picture gets there", () => {
  assert.equal(statusAtPicture(status, boat, ghost, 12).ghost.outcome, "at_sea");
  assert.equal(statusAtPicture(status, boat, ghost, 71.5).ghost.outcome, "at_sea");
  assert.equal(statusAtPicture(status, boat, ghost, 72).ghost.outcome, "lost");
  assert.equal(statusAtPicture(status, boat, ghost, 75).ghost.outcome, "lost");
});

test("at the status's own moment, the status stands as the simulator gave it", () => {
  assert.equal(statusAtPicture(status, boat, ghost, 72), status);
  assert.equal(statusAtPicture(status, boat, ghost, 72.01), status);
});

test("when the picture has played on past the status, the readings are still the picture's", () => {
  // The last status the picture passed was at hour 24; the picture is at hour 60 of a 72 hour run.
  const passed = { ...status, day: 1, boat: now(boat, 24), ghost: now(ghost, 24) };
  const s = statusAtPicture(passed, boat, ghost, 60);
  assert.ok(Math.abs(s.boat.soc - (1 - 60 / 200)) < 1e-9);
  assert.ok(Math.abs(s.weather!.wind_u - 11) < 1e-9);
  assert.ok(s.lead_km > 50 && s.lead_km < 63, `lead ${s.lead_km}`);
});

test("with no track yet, or before its first row, the status stands", () => {
  assert.equal(statusAtPicture(status, null, null, 5), status);
  assert.equal(statusAtPicture(status, { ...boat, h: [], lat: [], lon: [] }, ghost, 5), status);
});

test("a watched voyage has no second boat: the status's own stays, and the rest follows the picture", () => {
  const s = statusAtPicture(status, boat, null, 24);
  assert.equal(s.ghost, status.ghost);
  assert.ok(Math.abs(s.boat.soc - (1 - 24 / 200)) < 1e-9);
});

test("a boat whose track ended early stays at its last row, and one that arrived has nothing left to go", () => {
  const short = track(10, 3, "lost");
  const s = statusAtPicture({ ...status, ghost: now(short, 10, "lost") }, boat, short, 40);
  assert.equal(s.ghost.lon, short.lon[10]);
  assert.equal(s.ghost.outcome, "lost");
  const home = statusAtPicture({ ...status, day: 5, boat: { ...status.boat, outcome: "arrived", km_to_finish: 0 } }, boat, ghost, 72);
  assert.equal(home.boat.km_to_finish, 0);
  assert.equal(home.boat.outcome, "arrived");
});
