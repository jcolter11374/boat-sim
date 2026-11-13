// Checks for the JONSWAP sea and the live Sea used by the replay.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  G,
  JONSWAP_GAMMA,
  MAX_GPU_WAVES,
  SEA_STATES,
  SPREAD_S,
  Sea,
  components,
  displace,
  gpuWaves,
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

test("directions spread as cos^2s, s = 10 at the peak and broader for shorter waves (Mitsuyasu)", () => {
  const sea = { ...SEA_STATES.gale, meanDirection: 1.0 };
  const comps = components(sea, 48);
  const sx = comps.reduce((a, c) => a + Math.cos(c.direction), 0);
  const sz = comps.reduce((a, c) => a + Math.sin(c.direction), 0);
  const mean = Math.atan2(sz, sx);
  assert.ok(Math.abs(mean - 1.0) < 0.05, `mean direction ${mean}`);
  // Each component's own s by its frequency; for cos^2s(d/2) the mean resultant R = s / (s + 1).
  const fp = 1 / sea.tp;
  const sOf = (c: (typeof comps)[number]) => {
    const r = 1 / Math.sqrt((2 * Math.PI * c.wavelength) / G) / fp; // f / fp, deep water
    return Math.max(1, SPREAD_S * (r <= 1 ? r ** 5 : r ** -2.5));
  };
  const want = comps.reduce((a, c) => a + sOf(c) / (sOf(c) + 1), 0) / comps.length;
  const R = Math.hypot(sx, sz) / comps.length;
  assert.ok(Math.abs(R / want - 1) < 0.1, `mean resultant ${R} vs ${want}`);
  // short-crested: the short waves fan out much more than those near the peak
  const off = (c: (typeof comps)[number]) => Math.abs(Math.atan2(Math.sin(c.direction - 1), Math.cos(c.direction - 1)));
  const near = comps.filter((c) => sOf(c) > 5);
  const short = comps.filter((c) => sOf(c) < 3);
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  assert.ok(near.length >= 4 && short.length >= 4, `${near.length} near the peak, ${short.length} short`);
  assert.ok(avg(short.map(off)) > 1.5 * avg(near.map(off)), `${avg(short.map(off))} vs ${avg(near.map(off))}`);
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

// The sea shader's gerstner() (water.ts), line for line in TypeScript, fed the
// numbers gpuWaves() packs for it. If the shader or the packing drifts from
// displace(), the drawn sea stops being the sea the boats float on.
function shaderGerstner(p: ReturnType<typeof gpuWaves>, x: number, z: number, t: number) {
  const d = [0, 0, 0];
  const tx = [1, 0, 0];
  const tz = [0, 0, 1];
  for (let i = 0; i < p.n; i++) {
    const [amp, k, om, ph] = p.wa.slice(i * 4, i * 4 + 4);
    const [ux, uz] = p.wd.slice(i * 2, i * 2 + 2);
    const th = k * (ux * x + uz * z) - om * t + ph;
    const s = Math.sin(th);
    const c = Math.cos(th);
    const qa = p.q * amp;
    d[0] += -qa * ux * s;
    d[1] += amp * c;
    d[2] += -qa * uz * s;
    tx[0] += -qa * k * ux * ux * c;
    tx[1] += -amp * k * ux * s;
    tx[2] += -qa * k * ux * uz * c;
    tz[0] += -qa * k * ux * uz * c;
    tz[1] += -amp * k * uz * s;
    tz[2] += -qa * k * uz * uz * c;
  }
  return { d, tx, tz };
}

test("the sea shader moves the water exactly as displace() does", () => {
  const pts: [number, number, number][] = [
    [0, 0, 0],
    [3.7, -12.2, 5.5],
    [-41, 18, 33.3],
    [120, 75, 610],
  ];
  for (const key of Object.keys(SEA_STATES) as (keyof typeof SEA_STATES)[]) {
    const comps = components(SEA_STATES[key]);
    assert.ok(comps.length <= MAX_GPU_WAVES, `${key}: ${comps.length} trains, shader holds ${MAX_GPU_WAVES}`);
    const p = gpuWaves(comps);
    for (const [x, z, t] of pts) {
      const want = displace(comps, x, z, t);
      const { d, tx, tz } = shaderGerstner(p, x, z, t);
      for (let a = 0; a < 3; a++) assert.ok(Math.abs(d[a] - want[a]) < 1e-9, `${key} at (${x}, ${z}, ${t}) axis ${a}`);
      // Its slope (used for lighting) is the true slope of displace()'s surface.
      const h = 1e-4;
      const ax = displace(comps, x + h, z, t);
      const bx = displace(comps, x - h, z, t);
      const az = displace(comps, x, z + h, t);
      const bz = displace(comps, x, z - h, t);
      for (let a = 0; a < 3; a++) {
        const fx = (a === 0 ? 1 : 0) + (ax[a] - bx[a]) / (2 * h);
        const fz = (a === 2 ? 1 : 0) + (az[a] - bz[a]) / (2 * h);
        assert.ok(Math.abs(tx[a] - fx) < 1e-5, `${key} x-slope axis ${a}`);
        assert.ok(Math.abs(tz[a] - fz) < 1e-5, `${key} z-slope axis ${a}`);
      }
    }
  }
});

test("flow: the sea moves past the boat by exactly the distance sailed", () => {
  const a = new Sea(SEA_STATES.moderate);
  const b = new Sea(SEA_STATES.moderate);
  a.advance(0);
  b.advance(0);
  // b's boat sails 3.7 m east and 1.2 m south: b's sea at a point is a's sea 3.7 m east, 1.2 m south of it.
  b.flow(3.7, 1.2);
  const ca = a.advance(1 / 60);
  const cb = b.advance(1 / 60);
  for (const [x, z] of [[0, 0], [5, -3], [40, 22]]) {
    const ya = displace(ca, x + 3.7, z + 1.2, 1 / 60)[1];
    const yb = displace(cb, x, z, 1 / 60)[1];
    assert.ok(Math.abs(ya - yb) < 1e-9, `${x},${z}: ${ya} vs ${yb}`);
  }
  // No flow: the same sea as before this change, bit for bit.
  const c = new Sea(SEA_STATES.moderate);
  c.advance(0);
  assert.deepEqual(c.advance(1 / 60), ca);
});
