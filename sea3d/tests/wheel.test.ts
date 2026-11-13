import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRUISER_HANDLING, Guide, Wheel, bestSheet, look, rollFromWheel, trimGauge, type TrimTable } from "../src/helm/wheel.ts";

const T: TrimTable = JSON.parse(readFileSync(new URL("../../configs/polars/cruiser31_trim.json", import.meta.url), "utf8"));
const POLAR = JSON.parse(readFileSync(new URL("../../configs/polars/cruiser31.json", import.meta.url), "utf8"));
const SPELL = { markM: 50_000, markBearing: 0 };

function sail(w: Wheel, secs: number, inp = { helm: 0, sheet: 0 }, dt = 1 / 30): void {
  for (let t = 0; t < secs; t += dt) w.step(dt, inp);
}

test("the best sheet sails the voyage's polar (a crew's speed: no autopilot factor)", () => {
  for (const [tws, twa] of [[8, 60], [12, 90], [16, 120], [20, 150]]) {
    const i = POLAR.tws_kn.indexOf(tws);
    const j = POLAR.twa_deg.indexOf(twa);
    const polar = POLAR.plans.full.speed_kn[i][j] / T.autopilot_factor;
    const b = bestSheet(T, "full", tws, twa);
    assert.ok(Math.abs(b.speedKn / polar - 1) < 0.03, `${tws} kn ${twa} deg: ${b.speedKn} vs ${polar}`);
    assert.ok(b.lo <= b.sheet && b.sheet <= b.hi);
  }
});

test("held at the best sheet, the boat settles at the best speed", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90, speedKn: 0 }, SPELL);
  sail(w, 60);
  const b = w.best();
  assert.ok(Math.abs(w.s.speedKn - b.speedKn) < 0.1, `${w.s.speedKn} vs ${b.speedKn}`);
  assert.equal(w.sailState(), "good");
});

test("nothing a player does sails faster than the best trim", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let run = 0; run < 5; run++) {
    const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 14, fromDeg: 0 }, { heading: 100 }, SPELL);
    let inp = { helm: 0, sheet: 0 };
    for (let t = 0; t < 120; t += 1 / 30) {
      if (Math.random() < 0.02) inp = { helm: rnd() * 0.3, sheet: rnd() };
      w.step(1 / 30, inp);
      const b = bestSheet(T, w.s.plan, 14, w.twa());
      assert.ok(w.s.speedKn <= Math.max(b.speedKn, bestSheet(T, w.s.plan, 14, 180).speedKn) * 1.02 + 0.05);
    }
    assert.ok(w.share() <= 1);
  }
});

test("eased right out on a beat the sails flap and the boat stops", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 45 }, SPELL);
  sail(w, 30, { helm: 0, sheet: 1 }); // hold Down: ease all the way
  assert.equal(w.sailState(), "flapping");
  assert.ok(w.s.speedKn < 0.5, `${w.s.speedKn}`);
  sail(w, 30, { helm: 0, sheet: -1 }); // hold Up: pull in all the way
  sail(w, 30);
  assert.ok(w.s.speedKn > 4, `pulled in: ${w.s.speedKn}`);
});

test("sheeted hard on a run the sail stalls and it's slower", () => {
  const eased = look(T, "full", 12, 160, 85).speedKn;
  const tight = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 160 }, SPELL);
  sail(tight, 20, { helm: 0, sheet: -1 });
  sail(tight, 60);
  assert.equal(tight.sailState(), "stalled");
  assert.ok(tight.s.speedKn < eased * 0.95);
});

test("the rudder turns the boat and centres when let go", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90 }, { ...SPELL });
  sail(w, 3, { helm: 1, sheet: 0 });
  assert.ok(w.s.heading > 100 && w.s.heading < 130, `turned to ${w.s.heading}`);
  sail(w, 0.35);
  assert.equal(w.s.rudder, 0);
});

test("turning through the wind is a tack, and costs speed", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 45, autoTrim: true }, SPELL);
  sail(w, 30);
  const before = w.s.speedKn;
  let slowest = before;
  for (let t = 0; t < 40 && !(w.s.heading > 300 && w.s.heading < 320); t += 1 / 30) {
    w.step(1 / 30, { helm: -1, sheet: 0 });
    slowest = Math.min(slowest, w.s.speedKn);
  }
  assert.equal(w.s.tacks, 1);
  assert.ok(slowest < before * 0.8, `${slowest} vs ${before}`);
});

test("full sail upwind in a gale is overpowered and rounds up; reefed, it isn't", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 25, fromDeg: 0 }, { heading: 60, plan: "full" }, SPELL);
  w.s.sheet = T.sheet_deg[0];
  sail(w, 3);
  assert.ok(w.s.roundUps >= 1, "rounded up");
  assert.ok(w.s.heading < 60, `bow pushed toward the wind: ${w.s.heading}`);
  const r = new Wheel(T, CRUISER_HANDLING, { twsKn: 25, fromDeg: 0 }, { heading: 60, plan: "reef2" }, SPELL);
  r.s.sheet = T.sheet_deg[0];
  sail(r, 10, { helm: 0, sheet: 0 });
  assert.equal(r.s.roundUps, 0);
  assert.equal(r.reef(1), true, "reef2 -> storm");
  assert.equal(r.reef(-1), false, "busy tucking it in");
  assert.equal(r.s.plan, "storm");
});

test("stopped head to wind, the bow falls off by itself", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 5, speedKn: 0 }, SPELL);
  sail(w, 15);
  assert.ok(Math.abs(w.twa()) > 35, `still in irons at ${w.twa()}`);
});

test("auto-trim sails at the best speed, and the spell ends at the mark", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 270 }, { heading: 0, autoTrim: true }, { markM: 300, markBearing: 0 });
  sail(w, 200);
  assert.ok(w.share() > 0.95, `${w.share()}`);
  assert.equal(w.s.done, true);
  assert.ok(w.distToMark() < 40);
});

test("the guided first spell waits for each thing to be done", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90 }, SPELL);
  const g = new Guide();
  const run = (secs: number, inp: { helm: number; sheet: number }) => {
    for (let t = 0; t < secs; t += 1 / 30) {
      w.step(1 / 30, inp);
      g.update(w, 1 / 30);
    }
  };
  run(5, { helm: 0, sheet: 0 });
  assert.equal(g.step, "steer", "waits: nothing done yet");
  run(2.5, { helm: -1, sheet: 0 });
  assert.equal(g.step, "trim");
  assert.equal(w.s.sheet, 90, "the guide lets the sail out");
  run(5, { helm: 0, sheet: 0 });
  assert.equal(g.step, "trim", "still loose");
  // pull in until the needle is in the band, then hold
  for (let t = 0; t < 10 && w.sailState() !== "good"; t += 1 / 30) {
    w.step(1 / 30, { helm: 0, sheet: -1 });
    g.update(w, 1 / 30);
  }
  run(2, { helm: 0, sheet: 0 });
  assert.equal(g.step, "reef");
  assert.ok(w.reef(1));
  g.reefed();
  assert.equal(g.step, "go");
  run(7, { helm: 0, sheet: 0 });
  assert.equal(g.done, true);
});

test("with auto-trim on, the guide skips the trim step", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90, autoTrim: true }, SPELL);
  const g = new Guide();
  for (let t = 0; t < 3; t += 1 / 30) {
    w.step(1 / 30, { helm: 1, sheet: 0 });
    g.update(w, 1 / 30);
  }
  assert.equal(g.step, "reef");
});

test("she leans away from the wind: wind from port rolls her to starboard, and the other way", () => {
  // Heading east with the wind from the north (on her port side): she leans to starboard (roll > 0).
  const port = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90, speedKn: 5 }, SPELL);
  sail(port, 20);
  assert.ok(port.s.heelDeg > 3, `she should heel in 12 kn on a reach (${port.s.heelDeg})`);
  assert.ok(rollFromWheel(port.heelSigned()) > 0, "wind from port: roll to starboard");
  // Heading west, the same wind is on her starboard side: she leans to port.
  const stbd = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 270, speedKn: 5 }, SPELL);
  sail(stbd, 20);
  assert.ok(rollFromWheel(stbd.heelSigned()) < 0, "wind from starboard: roll to port");
});

test("pointing straight into the wind the sail says so, never 'Drawing well'", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 5 }, SPELL);
  assert.equal(w.sailState(), "irons");
});

test("the sail gauge is a level: the needle is inside the green exactly when the sail is drawing well", () => {
  assert.equal(trimGauge(20, 15, 25).needle, 50);
  for (const sheet of [14.5, 15, 25, 25.5]) {
    const n = trimGauge(sheet, 15, 25).needle;
    assert.ok(n >= 42 && n <= 58, `${sheet}: well inside the band (${n})`);
  }
  assert.ok(trimGauge(14, 15, 25).needle < 40, "pulled in too far: left of the band");
  assert.ok(trimGauge(26, 15, 25).needle > 60, "let out too far: right of the band");
  assert.equal(trimGauge(-90, 15, 25).needle, 0);
  assert.equal(trimGauge(200, 15, 25).needle, 100);
  assert.equal(trimGauge(12, 12, 12).needle, 50, "a band of one angle");
});

test("the sails luff when let out too far or head to wind, and not when drawing well", () => {
  const w = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 90, speedKn: 5 }, SPELL);
  w.s.sheet = w.best().sheet;
  assert.equal(w.luffTarget(), 0, "trimmed: no luff");
  w.s.sheet = w.awa() - 1; // eased until the sail is nearly edge-on
  assert.ok(w.luffTarget() > 0.6, `flapping: ${w.luffTarget()}`);
  const irons = new Wheel(T, CRUISER_HANDLING, { twsKn: 12, fromDeg: 0 }, { heading: 5, speedKn: 0 }, SPELL);
  assert.equal(irons.luffTarget(), 1, "head to wind: flogging");
  sail(w, 3);
  assert.ok(w.s.luff > 0.3, "the eased value follows");
});
