// The FFT short waves (src/seaFFT.ts): the transform, the energy, the cap, foam.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BIG_WAVES_UP_TO, Cascade, FFT2, FOAM_HALF_LIFE, ShortWaves, jonswap } from "../src/seaFFT";
import { G } from "../src/waves";

test("the inverse FFT turns one wavevector into one plane wave", () => {
  const n = 16;
  const f = new FFT2(n);
  const re = new Float32Array(n * n);
  const im = new Float32Array(n * n);
  re[2] = 1; // k = (2, 0)
  f.inverse(re, im);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      assert.ok(Math.abs(re[j * n + i] - Math.cos((2 * Math.PI * 2 * i) / n)) < 1e-5);
      assert.ok(Math.abs(im[j * n + i] - Math.sin((2 * Math.PI * 2 * i) / n)) < 1e-5);
    }
});

test("the JONSWAP density integrates to Hs^2 / 16", () => {
  let s = 0;
  for (let f = 0.001; f < 3; f += 0.0005) s += jonswap(f, 4, 9) * 0.0005;
  assert.ok(Math.abs(s / 1 - 1) < 0.01, `m0 ${s}`);
});

for (const [name, sea] of [["force 5", { hs: 2, tp: 6.6, direction: 0.4 }], ["force 8", { hs: 5, tp: 10, direction: -1 }]] as const) {
  test(`short waves carry the spectrum's tail, and stay small (${name})`, () => {
    const w = new ShortWaves("high");
    w.setSea(sea);
    w.update(12.3);
    // Expected tail variance above the big waves, below the small patch's Nyquist (by quadrature).
    const fCut = BIG_WAVES_UP_TO / sea.tp;
    const kNyq = (Math.PI * 128) / 31.7;
    const fNyq = Math.sqrt(G * kNyq) / (2 * Math.PI);
    let m0 = 0;
    for (let f = fCut; f < fNyq; f += 1e-4) m0 += jonswap(f, sea.hs, sea.tp) * 1e-4;
    const hsTail = 4 * Math.sqrt(m0);
    const hs = w.hs();
    // One random sea, so within 35 % of the expectation (it's a sample, and the band edges are soft).
    assert.ok(hs > 0.6 * hsTail && hs < 1.5 * hsTail, `short-wave Hs ${hs.toFixed(3)} vs tail ${hsTail.toFixed(3)}`);
    // The cap: the short waves are a small part of the sea, so they can't swamp the hull's waterline.
    assert.ok(hs < 0.2 * sea.hs, `short-wave Hs ${hs} is over a fifth of ${sea.hs}`);
    // Sampling between grid points is smooth and finite.
    for (const [x, z] of [[0.1, 0.2], [13.7, -40.2], [500, 900]]) assert.ok(Number.isFinite(w.heightAt(x, z)));
  });
}

test("a calm makes no short waves and no foam; foam grows with the wind and fades", () => {
  const calm = new ShortWaves("low");
  calm.setSea({ hs: 0.05, tp: 1.5, direction: 0 }, 1.5);
  calm.update(1);
  assert.ok(calm.hs() < 0.005, `calm short-wave Hs ${calm.hs()}`);
  assert.equal(calm.foamCover(), 0);
  const cover = (wind: number, hs: number, tp: number) => {
    const w = new ShortWaves("medium");
    w.setSea({ hs, tp, direction: 0 }, wind);
    let c = 0;
    for (let t = 0; t < 8; t += 1 / 15) w.update(t);
    for (let t = 8; t < 12; t += 1 / 15) {
      w.update(t);
      c += w.foamCover();
    }
    return c / (4 * 15);
  };
  const f5 = cover(9.4, 2, 6.6);
  const f8 = cover(19, 5, 10);
  // Whitecap cover near Monahan's: about 1 % at force 5, 5-10 % at force 8 (storm.ts whitecaps()).
  assert.ok(f5 > 0.002 && f5 < 0.03, `force 5 foam ${f5}`);
  assert.ok(f8 > 0.03 && f8 < 0.2 && f8 > 3 * f5, `force 8 foam ${f8} vs force 5 ${f5}`);
  // Without fresh breaking, foam fades by half in FOAM_HALF_LIFE.
  const c = new Cascade(32, 31.7, 0.2, Infinity, 3);
  c.foam.fill(1);
  c.update(0, -Infinity);
  c.update(FOAM_HALF_LIFE, -Infinity);
  assert.ok(Math.abs(c.foam[0] - 0.5) < 1e-6);
});

test("same seed, same sea; it moves on with time", () => {
  const a = new ShortWaves("medium");
  const b = new ShortWaves("medium");
  a.setSea({ hs: 3, tp: 8, direction: 0 });
  b.setSea({ hs: 3, tp: 8, direction: 0 });
  a.update(5);
  b.update(5);
  assert.equal(a.heightAt(3, 4), b.heightAt(3, 4));
  b.update(5.5);
  assert.notEqual(a.heightAt(3, 4), b.heightAt(3, 4));
});

test("fast enough for every frame", () => {
  for (const d of ["low", "medium", "high"] as const) {
    const w = new ShortWaves(d);
    w.setSea({ hs: 4, tp: 9, direction: 0 });
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) w.update(i / 60);
    const ms = (performance.now() - t0) / 20;
    console.log(`  ${d}: ${ms.toFixed(2)} ms a frame`);
    assert.ok(ms < (d === "high" ? 40 : 15), `${d} ${ms} ms`);
  }
});

test("surfaceAt is the big waves exactly, plus the short waves as drawn", async () => {
  const { Sea } = await import("../src/water");
  const { MixedSea, heightAt } = await import("../src/waves");
  const live = new MixedSea(undefined, { n: 16 });
  live.setSystems({ hs: 2, tp: 7, dirFrom: 250 }, { hs: 1, tp: 11, dirFrom: 300 }, null);
  live.snap();
  const comps = live.advance(3);
  const sea = new Sea("low");
  sea.setDetail("off");
  for (const [x, z] of [[0, 0], [3.2, -7.5], [40, 12]])
    assert.equal(sea.surfaceAt(comps, x, z, 3), heightAt(comps, x, z, 3, 0.5)); // bit-identical with no detail
  sea.setDetail("medium");
  sea.setSea(2.2, 9.4, new (await import("three")).Vector2(1, 0));
  sea.update(comps, 3); // no worker under Node: the short waves run here
  const d = sea.detailHeightAt(1, 1);
  assert.ok(Number.isFinite(d) && Math.abs(d) < 1.5, `short waves ${d} m`);
  assert.equal(sea.surfaceAt(comps, 1, 1, 3), heightAt(comps, 1, 1, 3, 0.5) + d);
  sea.dispose();
});
