// Checks for the working-equipment maths (boats/gear.ts) and the plain-English
// failure text (replay/data.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { apparentFlow, rudderFor, wingAngle } from "../src/boats/gear";
import { failuresAt, partText, type Replay, type ReplayEvent } from "../src/replay/data";
import { stroke } from "../src/boats/rowers";

const near = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} vs ${b}`);

test("motoring in still air: the air comes straight over the bow", () => {
  for (const hdg of [0, 45, 90, 200, 333]) {
    const f = apparentFlow(0, 0, 1.2, hdg);
    near(f.x, -1.2);
    near(f.z, 0);
  }
});

test("wind from the right-hand side blows across to the left", () => {
  // Heading north, wind blowing west (from the east, i.e. from starboard).
  const f = apparentFlow(-5, 0, 0, 0);
  near(f.x, 0);
  near(f.z, -5);
  // Heading east, wind blowing north (from the south, i.e. from starboard).
  const g = apparentFlow(0, 5, 0, 90);
  near(g.x, 0);
  near(g.z, -5, 1e-6);
});

test("the wing lines up with the air flow, tail downwind", () => {
  near(wingAngle({ x: -3, z: 0 }), 0);
  near(wingAngle({ x: -3, z: 0 }, 0), 0);
  // Air flowing to port (z < 0): tail swings to port, which is +z in the builder frame.
  const a = wingAngle({ x: 0, z: -3 }, 0);
  near(Math.cos(a), 0);
  near(-Math.sin(a), 1); // builder z of the tail direction
  // A small angle of attack, never more than asked.
  near(Math.abs(wingAngle({ x: 0, z: -3 }) - a), 0.14);
});

test("rudder follows the turn and stops at 30 degrees", () => {
  assert.ok(rudderFor(-0.2) > 0, "turning to starboard: rudder to starboard");
  assert.ok(rudderFor(0.2) < 0);
  near(rudderFor(0), 0);
  near(rudderFor(50), -Math.PI / 6);
  near(rudderFor(-50), Math.PI / 6);
});

test("failures are read from the log in order, first reason kept", () => {
  const ev = (h: number, detail: string): ReplayEvent => ({ h, kind: "part_failed", detail });
  const rep = {
    events: [
      { h: 1, kind: "message_sent", detail: "" },
      ev(10, "rudder (knockdown)"),
      ev(20, "thruster_port (bearing or motor failure)"),
      ev(30, "rudder (servo failed limp, spring centres it)"),
    ],
  } as unknown as Replay;
  assert.deepEqual([...failuresAt(rep, 5)], []);
  assert.deepEqual([...failuresAt(rep, 25)], [
    ["rudder", "knockdown"],
    ["thruster_port", "bearing or motor failure"],
  ]);
  assert.equal(failuresAt(rep, 99).get("rudder"), "knockdown");
});

test("failure pop-ups are plain English", () => {
  const parts = ["thruster_port", "thruster_starboard", "rudder", "sail", "electronics_main", "electronics_safe", "comms_silent", "beacon", "leak_main_tub", "entangled"];
  for (const p of parts) {
    for (const boat of ["v4 kayak", "Randolph Rev B"]) {
      const s = partText({ h: 0, kind: "part_failed", detail: `${p} (knockdown)` }, boat);
      assert.ok(!/thruster|electronics_|starboard|port\b|knockdown|Iridium|Globalstar|_/.test(s), `${p}: ${s}`);
      assert.match(s, /\.$/);
    }
  }
});

test("rowing stroke: blade forward and in at the catch, aft at the finish, lifted on the way back", () => {
  const catchS = stroke(0.02);
  const finish = stroke(0.4 - 1e-6);
  const back = stroke(0.7);
  assert.ok(catchS.sweep < -0.55 && finish.sweep > 0.4, "the drive sweeps the blade from the bow end to the stern end");
  assert.ok(catchS.seat > 0.45 && finish.seat < 0.05, "slid up to the footplate at the catch, back at the finish");
  assert.ok(catchS.lean > 0.3 && finish.lean < -0.2, "leaning towards the stern at the catch, back at the finish");
  assert.ok(stroke(0.2).dip > 0.06, "blade buried mid-drive");
  assert.ok(back.dip < 0, "blade clear of the water on the recovery");
  assert.ok(back.sweep > catchS.sweep && back.sweep < finish.sweep, "swinging back towards the catch");
  for (let p = 0; p < 1; p += 0.01) assert.ok(Math.abs(stroke(p).sweep - stroke((p + 0.001) % 1).sweep) < 0.05, `smooth at ${p}`);
});
