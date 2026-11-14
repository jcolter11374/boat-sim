import { test } from "node:test";
import assert from "node:assert/strict";
import { FILL } from "../src/seastate";
import { DROP_POINT, STALE_H, pointName, samplesAt, todayWords, type TodayHeader } from "../src/helm/today";

// Today's real weather on the Set sail card: NOAA's forecast at the drop point, in plain words.

const FIELDS = ["wind_u", "wind_v", "ws_hs", "s1_hs", "s2_hs"].map((name) => ({ name, scale: 0.01 }));
const H: TodayHeader = { issued: "2026-11-14T06:00Z", t0: "2026-11-14T06:00Z", step_h: 3, nt: 3, lat0: 36, lon0: -76, res: 1, nlat: 2, nlon: 3, fields: FIELDS };
/** A forecast with the same numbers everywhere, per time step: [u, v, ws, s1, s2] in m/s and m. */
function grid(steps: number[][]): Int16Array {
  const nf = FIELDS.length;
  const d = new Int16Array(H.nt * nf * H.nlat * H.nlon);
  steps.forEach((vals, t) => vals.forEach((x, k) => d.fill(Number.isNaN(x) ? FILL : Math.round(x / 0.01), (t * nf + k) * 6, (t * nf + k) * 6 + 6)));
  return d;
}
const D = grid([
  [-5, -5, 1.2, 1.6, NaN], // from the north-east at 7.1 m/s (13.7 kn); waves sqrt(1.44 + 2.56) = 2.0 m
  [0, 10, 2, 0, 0], // from the south at 10 m/s
  [3, 0, NaN, NaN, NaN], // from the west, no wave data
]);
const at = (iso: string) => Date.parse(iso);

test("samples: wind speed in knots, where it blows from, the waves' total height; off the grid is null", () => {
  const s = samplesAt(H, D, DROP_POINT[0], DROP_POINT[1])!;
  assert.equal(s.length, 3);
  assert.ok(Math.abs(s[0].windKn - 13.75) < 0.05);
  assert.equal(Math.round(s[0].windFrom), 45);
  assert.ok(Math.abs(s[0].hs! - 2) < 1e-9);
  assert.equal(Math.round(s[1].windFrom), 180);
  assert.equal(s[2].hs, null);
  assert.equal(samplesAt(H, D, 50, -74.9), null);
});

test("the card's words: now, the next days, who issued it and that the crossing is 2020's; nothing when stale", () => {
  const s = samplesAt(H, D, DROP_POINT[0], DROP_POINT[1]);
  const w = todayWords(H, s, at("2026-11-14T07:00Z"))!;
  assert.equal(w[0], "Today at the drop point, for real: wind 14 kn from the north-east, waves 2.0 m. Next day: wind 6 to 19 kn, waves up to 2.0 m.");
  assert.equal(w[1], "NOAA's forecast from 06:00 UTC. Your crossing sails the real weather of 2020.");
  assert.match(todayWords(H, s, at("2026-11-14T12:30Z"))![0], /wind 6 kn from the west\. /, "the step nearest now, and no waves when there are none");
  assert.equal(todayWords(H, s, at("2026-11-14T06:00Z") + (STALE_H + 1) * 3.6e6), null);
  assert.equal(todayWords(H, null, at("2026-11-14T07:00Z")), null);
});

test("compass points in words", () => {
  assert.deepEqual([0, 44, 90, 200, 225, 315, 359].map(pointName), ["north", "north-east", "east", "south", "south-west", "north-west", "north"]);
});
