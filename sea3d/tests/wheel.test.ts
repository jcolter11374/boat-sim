import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CRUISER_HANDLING, Wheel, bestSheet, look, type TrimTable } from "../src/helm/wheel.ts";

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
