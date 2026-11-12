import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BREEZES, toTheLight, toXY, triangle, type Breeze, type XY } from "../src/helm/course.ts";
import { CRUISER_HANDLING, Wheel, type TrimTable } from "../src/helm/wheel.ts";
import { robotSail } from "../src/helm/robot.ts";
import { LIGHT_WIND_FROM, ROBOT_SECS, Recorder, clock, ghostAt, medalFor, splitText, turnTrack } from "../src/helm/trial.ts";

const T: TrimTable = JSON.parse(readFileSync(new URL("../../configs/polars/cruiser31_trim.json", import.meta.url), "utf8"));

function sailCourse(kind: "triangle" | "light", b: Breeze, from: number): Wheel {
  const c = kind === "triangle" ? triangle(from) : toTheLight();
  return new Wheel(
    T,
    CRUISER_HANDLING,
    { twsKn: BREEZES[b].kn, fromDeg: from },
    { heading: c.heading, speedKn: 0, plan: b === "fresh" ? "reef1" : "full" },
    { markM: 0, markBearing: 0, marks: c.marks.map((m) => ({ ...toXY(c.start, m), gate: m.gate && ([toXY(c.start, m.gate[0]), toXY(c.start, m.gate[1])] as [XY, XY]) })), markRadiusM: c.radiusM },
  );
}

test("the medal times are the robot's: re-sailed, they're within 3% (so a trim table change can't quietly move them)", () => {
  for (const b of Object.keys(BREEZES) as Breeze[]) {
    const tri = robotSail(sailCourse("triangle", b, 200));
    assert.ok(Math.abs(tri / ROBOT_SECS.triangle[b] - 1) < 0.03, `triangle ${b}: robot ${tri} s vs table ${ROBOT_SECS.triangle[b]}`);
    const light = robotSail(sailCourse("light", b, LIGHT_WIND_FROM));
    assert.ok(Math.abs(light / ROBOT_SECS.light[b] - 1) < 0.03, `light ${b}: robot ${light} s vs table ${ROBOT_SECS.light[b]}`);
  }
});

test("the triangle takes the same time whatever the wind's direction (it's laid to the wind)", () => {
  const t = [0, 135, 290].map((from) => robotSail(sailCourse("triangle", "good", from)));
  for (const x of t) assert.ok(Math.abs(x / t[0] - 1) < 0.02, `${t}`);
});

test("medals: gold just behind the robot, then silver, bronze and none", () => {
  const r = ROBOT_SECS.triangle.good;
  assert.equal(medalFor(r, "triangle", "good"), "gold");
  assert.equal(medalFor(r * 1.04, "triangle", "good"), "gold");
  assert.equal(medalFor(r * 1.1, "triangle", "good"), "silver");
  assert.equal(medalFor(r * 1.3, "triangle", "good"), "bronze");
  assert.equal(medalFor(r * 1.5, "triangle", "good"), null);
  assert.equal(medalFor(100, "harbour", "good"), null);
});

test("the clock and splits read plainly", () => {
  assert.equal(clock(0), "0:00");
  assert.equal(clock(365.7), "6:05");
  assert.equal(clock(3725), "1:02:05");
  assert.equal(splitText(100, 108), "−0:08");
  assert.equal(splitText(130, 108), "+0:22");
});

test("the ghost follows the recorded run, turning the short way, and waits at the finish", () => {
  const rec = new Recorder();
  for (let t = 0; t <= 10; t += 0.25) rec.add(t, t * 3, 0, t < 5 ? 350 : 10, 12);
  const tr = rec.track(10, [4]);
  assert.equal(tr.pts.length / 5, 11, "one sample a second");
  const g = ghostAt(tr, 2.5)!;
  assert.ok(Math.abs(g.x - 7.5) < 0.01);
  const turn = ghostAt(tr, 4.5)!;
  assert.ok(turn.heading > 350 || turn.heading < 10, `turns through north, not round the compass: ${turn.heading}`);
  assert.deepEqual(ghostAt(tr, 99), { x: 30, y: 0, heading: 10, heel: 12 });
});

test("a ghost turns with the wind: kept as if from the north, raced in today's wind", () => {
  const rec = new Recorder();
  rec.add(0, 0, 0, 45, 10);
  rec.add(1, 0, 100, 45, 10); // 100 m north
  const tr = rec.track(1, []);
  const east = turnTrack(tr, 90);
  assert.deepEqual(east.pts.slice(5, 9), [1, 100, 0, 135], "north turned 90 degrees is east");
  const back = turnTrack(east, -90);
  assert.deepEqual(back.pts, tr.pts, "and back again");
});
