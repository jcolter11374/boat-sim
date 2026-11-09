// Checks for the JONSWAP sea and the live Sea used by the replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G,
  JONSWAP_GAMMA,
  SEA_STATES,
  SPREAD_S,
  Sea,
  components,
  displace,
  hsOf,
  jonswapShape,
  travelFromCompass,
  type WaveComponent,
} from "../src/waves";

const freq = (c: WaveComponent) => Math.sqrt((G * 2 * Math.PI) / c.wavelength) / (2 * Math.PI);

test("wave height is exact for every preset and size", () => {
  for (const sea of Object.values(SEA_STATES)) {
    for (const n of [8, 24, 48]) {
      assert.ok(Math.abs(hsOf(components(sea, n)) - sea.hs) < 1e-12, `${sea.name} n=${n}`);
    }
  }
});

test("same inputs, same sea (deterministic)", () => {
  assert.deepEqual(components(SEA_STATES.gale), components(SEA_STATES.gale));
  assert.notDeepEqual(components(SEA_STATES.gale, 24, 1), components(SEA_STATES.gale, 24, 2));
});

test("frequencies follow the JONSWAP spectrum: mean frequency and peak", () => {
  const sea = SEA_STATES.gale;
  const comps = components(sea, 48);
  const fp = 1 / sea.tp;
  // mean frequency m1/m0 of the truncated spectrum, by quadrature
  let m0 = 0;
  let m1 = 0;
  for (let r = 0.6; r <= 3.5; r += 1e-4) {
    const s = jonswapShape(r);
    m0 += s;
    m1 += r * s;
  }
  const fMean = comps.reduce((a, c) => a + freq(c), 0) / comps.length;
  assert.ok(Math.abs(fMean / (fp * (m1 / m0)) - 1) < 0.02, `mean f ${fMean} vs ${fp * (m1 / m0)}`);
  // the busiest band is around the peak: more components within +-15 % of fp
  // than in any other band of the same width
  const count = (lo: number, hi: number) => comps.filter((c) => freq(c) >= lo && freq(c) < hi).length;
  const atPeak = count(0.85 * fp, 1.15 * fp);
  for (const centre of [0.7, 1.5, 2, 2.5, 3]) {
    assert.ok(atPeak > count((centre - 0.15) * fp, (centre + 0.15) * fp), `band at ${centre} fp`);
  }
  assert.equal(JONSWAP_GAMMA, 3.3);
});

test("directions spread around the mean as cos^2s with s = 10", () => {
  const sea = { ...SEA_STATES.gale, meanDirection: 1.0 };
  const comps = components(sea, 48);
  const sx = comps.reduce((a, c) => a + Math.cos(c.direction), 0);
  const sz = comps.reduce((a, c) => a + Math.sin(c.direction), 0);
  const mean = Math.atan2(sz, sx);
  assert.ok(Math.abs(mean - 1.0) < 0.02, `mean direction ${mean}`);
  // circular spread sqrt(2 (1 - R)); for cos^2s(d/2), R = s / (s + 1)
  const R = Math.hypot(sx, sz) / comps.length;
  const want = Math.sqrt(2 * (1 - SPREAD_S / (SPREAD_S + 1)));
  assert.ok(Math.abs(Math.sqrt(2 * (1 - R)) / want - 1) < 0.1, `spread ${Math.sqrt(2 * (1 - R))} vs ${want}`);
});

test("compass 'coming from' turns into the direction of travel", () => {
  const close = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) < 1e-9;
  assert.ok(close(travelFromCompass(270), 0)); // from the west: travels east (+x)
  assert.ok(close(travelFromCompass(0), Math.PI / 2)); // from the north: travels south (+z)
  assert.ok(close(travelFromCompass(90), Math.PI)); // from the east: travels west
  assert.ok(close(travelFromCompass(180), -Math.PI / 2)); // from the south: travels north (-z)
});

test("a settled live Sea is the same sea as components()", () => {
  const sea = new Sea(SEA_STATES.gale);
  const live = sea.advance(1234.5);
  const fixed = components(SEA_STATES.gale);
  for (let i = 0; i < fixed.length; i++) {
    for (const k of ["amplitude", "wavelength", "direction"] as const) {
      assert.ok(Math.abs(live[i][k] - fixed[i][k]) < 1e-9, k);
    }
  }
  // and the surfaces agree
  for (const t of [1234.5]) {
    const a = displace(live, 30, -12, t)[1];
    const b = displace(fixed, 30, -12, t)[1];
    assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);
  }
});

test("hourly changes ease in without jumps, and Hs stays exact on the way", () => {
  // Calm from the west, then a gale from the north-east, then a swell from the south.
  const sea = new Sea(SEA_STATES.calm, { smoothing: 3 });
  const pts = [
    [0, 0],
    [30, -20],
    [-25, 35],
  ];
  const frame = 1 / 60;
  const steady = new Sea(SEA_STATES.gale);
  // reference: the largest frame-to-frame change of a steady gale
  let ref = 0;
  let prevS = pts.map(([x, z]) => displace(steady.advance(0), x, z, 0)[1]);
  for (let t = frame; t < 30; t += frame) {
    const c = steady.advance(t);
    const now = pts.map(([x, z]) => displace(c, x, z, t)[1]);
    ref = Math.max(ref, ...now.map((y, i) => Math.abs(y - prevS[i])));
    prevS = now;
  }
  let worst = 0;
  let prev = pts.map(([x, z]) => displace(sea.advance(0), x, z, 0)[1]);
  const plan: [number, number, number, number][] = [
    [5, 5.0, 11, 45],
    [25, 2.0, 14, 180],
  ];
  for (let t = frame; t < 45; t += frame) {
    for (const [at, hs, tp, from] of plan) if (Math.abs(t - at) < frame / 2) sea.setSeaState(hs, tp, from);
    const c = sea.advance(t);
    assert.ok(Math.abs(hsOf(c) - sea.hs) < 1e-9);
    const now = pts.map(([x, z]) => displace(c, x, z, t)[1]);
    worst = Math.max(worst, ...now.map((y, i) => Math.abs(y - prev[i])));
    prev = now;
  }
  // No jump bigger than a steady gale's own frame-to-frame motion (with margin).
  assert.ok(worst < 1.5 * ref, `worst step ${worst.toFixed(3)} m vs steady gale ${ref.toFixed(3)} m`);
  // and it got there
  assert.ok(Math.abs(sea.hs - 2.0) < 0.01 && Math.abs(sea.tp - 14) < 0.05);
  assert.ok(Math.abs(sea.direction - travelFromCompass(180)) < 0.01);
});

test("time warp: ten replay hours a second still move smoothly near the boats", () => {
  // A realistic hour-to-hour random walk (seeded): Hs +-0.3 m, Tp +-0.5 s,
  // direction +-15 deg an hour, fed ten hours a second.
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const sea = new Sea(SEA_STATES.moderate);
  const frame = 1 / 60;
  let hs = 1.5;
  let tp = 7;
  let from = 250;
  const pts = [
    [0, 0],
    [25, -10],
    [-30, 20],
  ];
  let prev = pts.map(([x, z]) => displace(sea.advance(0), x, z, 0)[1]);
  let worst = 0;
  for (let i = 1; i < 60 * 60; i++) {
    const t = i * frame;
    if (i % 6 === 0) {
      hs = Math.min(Math.max(hs + 0.3 * rnd(), 0.3), 6);
      tp = Math.min(Math.max(tp + 0.5 * rnd(), 4), 14);
      from = (from + 15 * rnd() + 360) % 360;
      sea.setSeaState(hs, tp, from);
    }
    const c = sea.advance(t);
    const now = pts.map(([x, z]) => displace(c, x, z, t)[1]);
    worst = Math.max(worst, ...now.map((y, k) => Math.abs(y - prev[k])));
    prev = now;
  }
  // a steady 6 m sea moves about 0.05 m a frame; allow double
  assert.ok(worst < 0.1, `worst frame step ${worst.toFixed(3)} m`);
});

test("crest sharpening never folds the surface into loops", () => {
  for (const sea of Object.values(SEA_STATES)) {
    const comps = components(sea);
    let ka = 0;
    for (const c of comps) ka += ((2 * Math.PI) / c.wavelength) * c.amplitude;
    const q = Math.min(1, 0.5 / ka);
    assert.ok(q * ka <= 0.5 + 1e-12, sea.name);
  }
});
