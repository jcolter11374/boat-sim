// Checks for the sky almanac (src/sky.ts) against well-known moments of 2020.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIGHT_STARS, moonEquatorial, moonPhase, sunEquatorial, toHorizon } from "../src/sky";

const near = (a: number, b: number, tol: number, what: string) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a.toFixed(2)} vs ${b}`);
const angGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

test("the sun crosses the equator at the March equinox and tops out at the June solstice", () => {
  near(sunEquatorial(Date.UTC(2020, 2, 20, 3, 50)).dec, 0, 0.1, "equinox declination");
  near(sunEquatorial(Date.UTC(2020, 5, 20, 21, 44)).dec, 23.44, 0.1, "solstice declination");
});

test("the sun is due south at local noon, highest at 90 - latitude + declination", () => {
  // Greenwich, 20 Jun 2020: noon is about 12:01 UTC (equation of time).
  const h = toHorizon(sunEquatorial(Date.UTC(2020, 5, 20, 12, 1)).ra, sunEquatorial(Date.UTC(2020, 5, 20, 12, 1)).dec, Date.UTC(2020, 5, 20, 12, 1), 51.48, 0);
  near(h.el, 90 - 51.48 + 23.44, 0.5, "noon elevation");
  near(angGap(h.az, 180), 0, 1.5, "noon bearing");
});

test("moon phases of spring 2020 come out right", () => {
  assert.ok(moonPhase(Date.UTC(2020, 3, 23, 2, 26)).lit < 0.02, "new moon 23 Apr");
  assert.ok(moonPhase(Date.UTC(2020, 4, 7, 10, 45)).lit > 0.98, "full moon 7 May");
  const fq = moonPhase(Date.UTC(2020, 3, 30, 20, 38));
  near(fq.lit, 0.5, 0.05, "first quarter 30 Apr");
  assert.equal(fq.waxing, true);
  assert.equal(moonPhase(Date.UTC(2020, 4, 14, 14, 3)).waxing, false, "last quarter 14 May wanes");
  // At full moon the moon sits opposite the sun.
  const t = Date.UTC(2020, 4, 7, 10, 45);
  near(angGap(moonEquatorial(t).ra, sunEquatorial(t).ra), 180, 3, "full moon opposite the sun");
});

test("the North Star stands due north at an elevation equal to the latitude", () => {
  const polaris = BRIGHT_STARS.find((s) => s.name.startsWith("North Star"))!;
  for (const [lat, lon] of [[36.65, -74.94], [39.5, -13.5], [42, -45]] as const)
    for (let hr = 0; hr < 24; hr += 5) {
      const h = toHorizon(polaris.ra * 15, polaris.dec, Date.UTC(2020, 4, 1, hr), lat, lon);
      near(h.el, lat, 0.8, `elevation at ${lat}N`);
      near(angGap(h.az, 0), 0, 1.2, `bearing at ${lat}N`);
    }
});

/** Bearing of the sun as its centre crosses the horizon (geometric sunrise, no refraction), searching a UTC day. */
function sunriseBearing(day: number, lat: number, lon: number): number {
  const at = (ms: number) => {
    const s = sunEquatorial(ms);
    return toHorizon(s.ra, s.dec, ms, lat, lon);
  };
  for (let ms = day; ms < day + 86400e3; ms += 60e3) {
    if (at(ms).el < 0 && at(ms + 60e3).el >= 0) return at(ms + 30e3).az;
  }
  throw new Error("no sunrise");
}

test("sunrise bearings off Washington DC match the almanac to within a degree", () => {
  // Equinox: the sun rises due east everywhere. June solstice at 38.9N: about 59 degrees
  // (cos az = sin 23.44 / cos 38.9; NOAA's solar calculator gives 59 for Washington, 20 Jun 2020).
  near(sunriseBearing(Date.UTC(2020, 2, 20), 38.9, -77.04), 90, 1, "equinox sunrise");
  near(sunriseBearing(Date.UTC(2020, 5, 20), 38.9, -77.04), 59.3, 1, "solstice sunrise");
});

test("the star catalogue: the Yale Bright Star Catalogue, brightest first, at the right places", async () => {
  const { readFileSync } = await import("node:fs");
  const { decodeStars } = await import("../src/sky");
  const b = readFileSync(new URL("../public/stars.bin", import.meta.url));
  const stars = decodeStars(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
  assert.ok(stars.length > 9000, `${stars.length} stars`);
  for (let i = 1; i < stars.length; i++) assert.ok(stars[i].mag >= stars[i - 1].mag, "brightest first");
  // Sirius: RA 6h 45m 09s, Dec -16 43', magnitude -1.46.
  assert.ok(Math.abs(stars[0].ra - 101.29) < 0.05 && Math.abs(stars[0].dec + 16.72) < 0.05 && stars[0].mag === -1.46, JSON.stringify(stars[0]));
  assert.ok(stars.filter((s) => s.mag <= 6.5).length > 8000, "about 9,000 stars to the eye's limit");
});

test("star colours run from orange (cool) to blue-white (hot), and moonlight hides the faint ones", async () => {
  const { starColour, nakedEyeLimit } = await import("../src/sky");
  const cool = starColour(3500);
  const sun = starColour(5800);
  const hot = starColour(20000);
  assert.ok(cool[0] > cool[2] && hot[2] >= hot[0], `${cool} / ${hot}`);
  assert.ok(sun[0] > 0.9 && sun[1] > 0.9 && sun[2] > 0.85, `the sun's kind is near white: ${sun}`);
  assert.deepEqual(starColour(0), [1, 1, 1]);
  assert.equal(nakedEyeLimit(-30, 0), 6.5);
  assert.ok(Math.abs(nakedEyeLimit(-30, 1) - 4.3) < 1e-9, "a full moon washes out the faint stars");
  assert.ok(nakedEyeLimit(-6, 0) < 1.5, "civil twilight: only the brightest");
});
