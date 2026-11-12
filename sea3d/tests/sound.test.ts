import { test } from "node:test";
import assert from "node:assert/strict";
import { beaufort, mixFor, nearGain, rigFor, seeded, type SeaWeather } from "../src/sound.ts";

/** Typical open-sea weather at a Beaufort force (mid-band wind, a matching sea). */
function at(force: number, extra: Partial<SeaWeather> = {}): SeaWeather {
  const wind = 0.836 * Math.pow(force, 1.5);
  const hs = [0, 0.1, 0.3, 0.7, 1.2, 2.2, 3.4, 4.8, 6.4, 8, 10][Math.round(force)] ?? 10;
  return { wind, hs, tp: 3 + 2.5 * Math.sqrt(hs), rain: 0, near: 6, stw: 1.5, ...extra };
}
const loud = (m: ReturnType<typeof mixFor>) => m.windLo + m.windHi + m.rig + m.hull + m.wash + m.sizzle;

test("Beaufort from wind speed: the band edges", () => {
  assert.ok(Math.abs(beaufort(5.5) - 3.5) < 0.1); // the edge between force 3 and 4
  assert.ok(Math.abs(beaufort(6.7) - 4) < 0.1);
  assert.ok(Math.abs(beaufort(17.2) - 7.5) < 0.2);
  assert.ok(beaufort(0) === 0);
});

test("the mix climbs with every step of force, from near silence to a roar", () => {
  let prev = -1;
  for (let f = 0; f <= 10; f++) {
    const v = loud(mixFor(at(f), "shrouds"));
    assert.ok(v > prev, `force ${f} (${v.toFixed(4)}) should be louder than force ${f - 1} (${prev.toFixed(4)})`);
    prev = v;
  }
  const calm = loud(mixFor(at(1), "shrouds"));
  const gale = loud(mixFor(at(8), "shrouds"));
  assert.ok(20 * Math.log10(gale / calm) > 16, "a gale is well above a calm (about 20 dB in the render; Milo lifted the calm end)");
});

test("a calm has no wind hiss, no singing rig and no whitecaps", () => {
  const m = mixFor(at(1), "shrouds");
  assert.equal(m.windHi, 0);
  assert.equal(m.rig, 0);
  assert.equal(m.breaksPerSec, 0);
  assert.equal(m.slam, 0);
});

test("only masted boats sing at force 5; the kayak's whistle starts later and stays smaller", () => {
  assert.equal(rigFor("stock_pearson31_2"), "shrouds");
  assert.equal(rigFor("kayak"), "small");
  assert.equal(rigFor("stock_ocean_rower45"), "small");
  assert.ok(mixFor(at(5), "shrouds").rig > 0);
  assert.equal(mixFor(at(5), "small").rig, 0);
  assert.ok(mixFor(at(8), "small").rig < mixFor(at(8), "shrouds").rig / 2);
});

test("nothing tonal above about 2 kHz, even in a gust at force 10", () => {
  for (const rig of ["shrouds", "small"] as const) {
    const m = mixFor(at(10), rig, 0.8, 1);
    assert.ok(m.rigHz * 1.49 < 2100, `${rig}: ${m.rigHz}`);
    assert.ok(m.windHiHz <= 2200);
  }
});

test("water along the hull follows the boat's speed, but stopped is never silent (Sam)", () => {
  const stopped = mixFor(at(3, { stw: 0 }), "small").hull;
  assert.ok(stopped > 0);
  assert.ok(mixFor(at(3, { stw: 3.5 }), "small").hull > stopped * 3);
  const slow = mixFor(at(3, { stw: 1 }), "small").hull;
  const fast = mixFor(at(3, { stw: 3.5 }), "small").hull;
  assert.ok(slow > 0 && fast > slow * 2);
});

test("the hull never drops more than 12 dB with the camera far away", () => {
  assert.equal(nearGain(3), 1);
  assert.ok(nearGain(5000) >= 0.25);
  assert.ok(nearGain(20) < nearGain(8));
});

test("gusts and lulls move the wind, sets move the sea", () => {
  const w = at(6);
  assert.ok(mixFor(w, "shrouds", 0.6).windLo > mixFor(w, "shrouds", -0.4).windLo * 1.5);
  assert.ok(mixFor(w, "shrouds", 0, 1).wash > mixFor(w, "shrouds", 0, 0).wash * 1.5);
});

test("the wind follows the wind the boat feels: beating is louder than running (Sam)", () => {
  const beat = mixFor(at(5, { apparent: 13 }), "shrouds");
  const run = mixFor(at(5, { apparent: 6 }), "shrouds");
  assert.ok(beat.windLo > run.windLo * 2 && beat.rig > run.rig);
  assert.equal(beat.breaksPerSec, run.breaksPerSec, "the sea doesn't care which way the boat sails");
});

test("light airs: the halyard taps and the boom slats; once the sails fill, both stop", () => {
  const light = mixFor(at(2, { hs: 0.5 }), "shrouds");
  assert.ok(light.tapsPerSec > 0 && light.slat > 0);
  const breeze = mixFor(at(5), "shrouds");
  assert.equal(breeze.tapsPerSec, 0);
  assert.equal(breeze.slat, 0);
  assert.equal(mixFor(at(2, { hs: 0.5 }), "small").slat, 0, "no boom on the kayak");
});

test("rain adds hiss and drops on deck", () => {
  assert.equal(mixFor(at(4), "small").rain, 0);
  const m = mixFor(at(4, { rain: 0.8 }), "small");
  assert.ok(m.rain > 0 && m.dropsPerSec > 10);
});

test("the review render's random numbers repeat for a seed", () => {
  const a = seeded(7), b = seeded(7);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test("a missing reading falls back to calm values instead of NaN", () => {
  const m = mixFor({ wind: 0, hs: 0.3, tp: 6, rain: 0, near: 8 }, "shrouds");
  for (const [k, v] of Object.entries(m)) assert.ok(Number.isFinite(v), k);
});
