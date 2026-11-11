// Gate for the wave-motion model (Phase 1): roll period and righting curve agree
// with each boat's stability numbers, and both boats right themselves from
// upside down. Run with `npm run test:unit` (bundled by esbuild, run by node:test).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BoatMotion,
  KAYAK_GM,
  KAYAK_MASS_ITEMS,
  KAYAK_V4,
  RANDOLPH_REVB,
  RANDOLPH_REVC,
  REVC_GM,
  REVC_MASS_ITEMS,
  REVC_POINT_MASS,
  REVB_GM,
  derive,
  gmOf,
  gz,
  massProperties,
  type HullParams,
} from "../src/motion";
import { G, SEA_STATES, components, type WaveComponent } from "../src/waves";

const D2R = Math.PI / 180;
const CALM: WaveComponent[] = [];
const BOATS: HullParams[] = [KAYAK_V4, RANDOLPH_REVB, RANDOLPH_REVC];

function run(m: BoatMotion, comps: WaveComponent[], seconds: number, every = 0.01) {
  const out: { t: number; heave: number; pitch: number; roll: number }[] = [];
  for (let t = every; t <= seconds + 1e-9; t += every) {
    m.advance(comps, t);
    out.push({ t, heave: m.heave, pitch: m.pitch, roll: m.roll });
  }
  return out;
}

/** Mean time between upward zero crossings. */
function period(series: number[], dt: number): number {
  const ups: number[] = [];
  for (let i = 1; i < series.length; i++) {
    if (series[i - 1] < 0 && series[i] >= 0) {
      ups.push((i - 1 + -series[i - 1] / (series[i] - series[i - 1])) * dt);
    }
  }
  assert.ok(ups.length >= 3, "needs at least two full swings");
  return (ups[ups.length - 1] - ups[0]) / (ups.length - 1);
}

test("kayak mass budget matches the design doc: 123 kg, CG 0.38 m below the waterline", () => {
  const mp = massProperties(KAYAK_MASS_ITEMS);
  assert.equal(mp.mass, 123);
  assert.ok(Math.abs(mp.cg - -0.38) < 0.01, `CG ${mp.cg.toFixed(3)} m`);
  assert.equal(KAYAK_V4.mass, 123);
  assert.ok(Math.abs(KAYAK_V4.cgBelowWaterline - 0.38) < 0.01);
});

test("righting curve reproduces the design doc table for the kayak", () => {
  const doc: [number, number][] = [
    [30, 0.35],
    [60, 0.44],
    [90, 0.43],
    [120, 0.3],
    [150, 0.19],
    [170, 0.09],
  ];
  for (const [a, g] of doc) {
    assert.ok(Math.abs(gz(KAYAK_V4, a * D2R) - g) < 1e-9, `GZ at ${a} deg`);
    // righting moment, doc gives N m at 123 kg
    assert.ok(Math.abs(123 * G * gz(KAYAK_V4, a * D2R) - 123 * 9.81 * g) < 1);
  }
  assert.ok(Math.abs(gmOf(KAYAK_V4) - KAYAK_GM) < 1e-3);
});

test("Rev B righting curve matches its published GM 0.201 m and max GZ 0.434 m", () => {
  assert.ok(Math.abs(gmOf(RANDOLPH_REVB) - REVB_GM) < 0.002, `GM ${gmOf(RANDOLPH_REVB)}`);
  let max = 0;
  for (let a = 0; a <= 180; a += 0.5) max = Math.max(max, gz(RANDOLPH_REVB, a * D2R));
  assert.ok(Math.abs(max - 0.434) < 0.002, `max GZ ${max}`);
});

test("Rev B uses the Randolph team's own GZ curve and inertias (#50)", () => {
  // spot values from their docs/data/revB_gz_curve.csv
  for (const [a, g] of [[30, 0.101], [90, 0.2005], [105, 0.4341], [150, 0.2052]]) {
    assert.ok(Math.abs(gz(RANDOLPH_REVB, a * D2R) - g) < 1e-9, `GZ at ${a} deg`);
  }
  // the wing going under: the arm doubles between 90 and 100 deg
  assert.ok(gz(RANDOLPH_REVB, 100 * D2R) > 2 * gz(RANDOLPH_REVB, 90 * D2R));
  assert.equal(RANDOLPH_REVB.rollInertia, 2.487);
  assert.equal(RANDOLPH_REVB.pitchInertia, 4.117);
});

test("Rev C uses the Randolph team's own C3 GZ curve, and its masses add up to 26.9 kg (#179)", () => {
  // spot values from their docs/data/revC_gz_curve.csv
  for (const [a, g] of [[25, 0.0778], [90, 0.1723], [105, 0.3629], [150, 0.159]]) {
    assert.ok(Math.abs(gz(RANDOLPH_REVC, a * D2R) - g) < 1e-9, `GZ at ${a} deg`);
  }
  assert.ok(Math.abs(gmOf(RANDOLPH_REVC) - REVC_GM) < 0.002, `GM ${gmOf(RANDOLPH_REVC)}`);
  // their heel-limit moment in randolph_rev_c.yaml: 26.9 kg x g x GZ(25 deg) = 20.5 N m
  assert.ok(Math.abs(26.9 * 9.81 * gz(RANDOLPH_REVC, 25 * D2R) - 20.5) < 0.1);
  const mp = massProperties(REVC_MASS_ITEMS);
  assert.ok(Math.abs(mp.mass - RANDOLPH_REVC.mass) < 0.1, `mass ${mp.mass}`);
  // heavier bulb and more mass aloft: a bit more inertia than Rev B, and a
  // slightly lower GM (0.182 vs 0.201 m), so it rolls a little slower
  assert.ok(RANDOLPH_REVC.rollInertia > RANDOLPH_REVB.rollInertia && RANDOLPH_REVC.rollInertia < 3.5);
  assert.ok(derive(RANDOLPH_REVC).periodRoll > derive(RANDOLPH_REVB).periodRoll);
  // their inertias and CG (revC_geometry.json, C3); our point masses agree to 3 %
  assert.equal(RANDOLPH_REVC.rollInertia, 3.1);
  assert.equal(RANDOLPH_REVC.pitchInertia, 5.256);
  assert.ok(Math.abs(RANDOLPH_REVC.cgBelowWaterline - 0.13) < 1e-9);
  assert.ok(Math.abs(REVC_POINT_MASS.cgX / RANDOLPH_REVC.cgX - 1) < 0.03);
  assert.ok(Math.abs(REVC_POINT_MASS.cg - (0.102 - 0.13)) < 0.01);
});

test("both curves are positive all the way to 180 deg (no stable upside-down position)", () => {
  for (const p of BOATS) {
    for (let a = 1; a < 180; a += 1) assert.ok(gz(p, a * D2R) > 0, `${p.name} at ${a} deg`);
    assert.ok(Math.abs(gz(p, Math.PI)) < 1e-9);
    // odd: heeling the other way rights the other way
    assert.ok(Math.abs(gz(p, -0.5) + gz(p, 0.5)) < 1e-12);
  }
});

test("free roll in calm water swings at the period the stability numbers predict", () => {
  for (const p of BOATS) {
    const m = new BoatMotion(p);
    m.roll = 5 * D2R; // small angle: inside the GM sin(phi) part of the curve
    const dt = 0.002;
    const s = run(m, CALM, 8 * derive(p).periodRoll, dt);
    const d = derive(p);
    const tExpected = d.periodRoll / Math.sqrt(1 - p.zetaRoll ** 2); // damped period
    const tSim = period(
      s.map((r) => r.roll),
      dt,
    );
    assert.ok(Math.abs(tSim / tExpected - 1) < 0.03, `${p.name}: ${tSim.toFixed(3)} s vs ${tExpected.toFixed(3)} s`);
    // and it's the period you get from first principles: 2 pi sqrt(I / (W GM))
    const direct = 2 * Math.PI * Math.sqrt((p.rollInertia * (1 + p.addedRoll)) / (p.mass * G * gmOf(p)));
    assert.ok(Math.abs(direct - d.periodRoll) < 1e-9);
  }
});

test("roll periods are in a believable range for these boats", () => {
  // Kayak: very stiff (50 kg of lead 0.9 m down): about 1.3 s. Rev B: about 2 s.
  const k = derive(KAYAK_V4).periodRoll;
  const r = derive(RANDOLPH_REVB).periodRoll;
  assert.ok(k > 0.9 && k < 1.8, `kayak ${k}`);
  assert.ok(r > 1.4 && r < 2.8, `Rev B ${r}`);
});

test("both boats right themselves from upside down within 10 s (the pool test)", () => {
  for (const p of BOATS) {
    for (const side of [1, -1]) {
      const m = new BoatMotion(p);
      m.roll = side * 179 * D2R;
      const s = run(m, CALM, 10);
      const end = s[s.length - 1];
      assert.ok(Math.abs(end.roll) < 5 * D2R, `${p.name}: ended at ${(end.roll / D2R).toFixed(1)} deg`);
    }
  }
});

test("a knockdown to 90 deg comes back upright", () => {
  for (const p of BOATS) {
    const m = new BoatMotion(p);
    m.roll = 90 * D2R;
    const s = run(m, CALM, 10);
    const late = s.filter((r) => r.t > 6).map((r) => Math.abs(r.roll));
    assert.ok(Math.max(...late) < 10 * D2R, `${p.name}: still swinging ${(Math.max(...late) / D2R).toFixed(1)} deg after 6 s`);
    assert.ok(Math.abs(s[s.length - 1].roll) < 3 * D2R, p.name);
  }
});

test("in long swell the boat rides the surface (heave follows the wave)", () => {
  // One 10 s swell, 1 m high: far longer than either boat, so heave ~ the wave.
  const swell: WaveComponent[] = [
    { amplitude: 0.5, wavelength: (G * 100) / (2 * Math.PI), direction: 0, phase: 0 },
  ];
  for (const p of BOATS) {
    const m = new BoatMotion(p);
    const s = run(m, swell, 60).filter((r) => r.t > 20);
    const range = Math.max(...s.map((r) => r.heave)) - Math.min(...s.map((r) => r.heave));
    assert.ok(Math.abs(range - 1.0) < 0.08, `${p.name}: heave range ${range.toFixed(3)} m`);
  }
});

test("short chop much smaller than the hull barely moves it", () => {
  // 1 s waves are 1.6 m long, shorter than the kayak: averaging over the hull filters them.
  const chop: WaveComponent[] = [{ amplitude: 0.1, wavelength: 1.56, direction: 0, phase: 0 }];
  const m = new BoatMotion(KAYAK_V4);
  const s = run(m, chop, 20).filter((r) => r.t > 10);
  const range = Math.max(...s.map((r) => r.heave)) - Math.min(...s.map((r) => r.heave));
  assert.ok(range < 0.05, `heave range ${range}`);
});

test("stays finite and sensible in a gale, from any heading", () => {
  const gale = components(SEA_STATES.gale);
  for (const p of BOATS) {
    for (const yaw of [0, Math.PI / 2, 2]) {
      const m = new BoatMotion(p, { x: 10, z: -5, yaw });
      const s = run(m, gale, 120, 0.05);
      for (const r of s) {
        assert.ok(Number.isFinite(r.heave) && Number.isFinite(r.pitch) && Number.isFinite(r.roll));
        assert.ok(Math.abs(r.heave) < 6, `${p.name} heave ${r.heave}`);
        assert.ok(Math.abs(r.pitch) < 50 * D2R, `${p.name} pitch ${r.pitch}`);
      }
    }
  }
});
