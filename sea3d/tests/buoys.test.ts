// The practice marks float like real inflatable racing marks (Sam, backlog item 1):
// they ride the sea under them, a beat behind, lean downwind and stay real size.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Buoys, DRAFT_M, windLeanDeg } from "../src/helm/buoys";
import { components, heightAt } from "../src/waves";

const sea = components({ name: "test", hs: 2, tp: 7, meanDirection: 0.4 }, 24, 3);

test("a mark sits at the water's height, its draft under the surface", () => {
  const b = new Buoys();
  b.set([{ x: 120, y: 340 }]);
  b.update({ x: 0, y: 0 }, 10, 0, sea);
  const m = b.group.children[0];
  assert.ok(Math.abs(m.position.y + DRAFT_M - heightAt(sea, 120, -340, 10)) < 1e-9);
  assert.equal(m.scale.x, 1); // real size at any distance
});

test("it follows the water a beat behind, not stuck to it", () => {
  const b = new Buoys();
  b.set([{ x: 50, y: 50 }]);
  b.update({ x: 0, y: 0 }, 0, 0, sea);
  let maxGap = 0;
  let travel = 0;
  let last = b.group.children[0].position.y;
  for (let t = 0.05; t < 30; t += 0.05) {
    b.update({ x: 0, y: 0 }, t, 0, sea);
    const y = b.group.children[0].position.y;
    travel += Math.abs(y - last);
    last = y;
    maxGap = Math.max(maxGap, Math.abs(y + DRAFT_M - heightAt(sea, 50, -50, t)));
  }
  assert.ok(travel > 5, `it rides the waves (moved ${travel.toFixed(1)} m)`);
  assert.ok(maxGap > 0.01 && maxGap < 0.6, `lags a little (${maxGap.toFixed(2)} m)`);
});

test("in flat water the wind leans it downwind", () => {
  const b = new Buoys();
  b.set([{ x: 0, y: 100 }]);
  // Wind blowing toward the east at 8 m/s: the top tips east (+x), a negative turn about z.
  for (let t = 0; t < 10; t += 0.1) b.update({ x: 0, y: 0 }, t, 0, [], 8, 0);
  const r = b.group.children[0].rotation;
  assert.ok(Math.abs(r.z + (windLeanDeg(8) * Math.PI) / 180) < 0.01);
  assert.ok(Math.abs(r.x) < 1e-9);
  // Toward the north (scene -z): the top tips to -z, a negative turn about x.
  b.set([{ x: 0, y: 100 }]);
  for (let t = 0; t < 10; t += 0.1) b.update({ x: 0, y: 0 }, t, 0, [], 0, 8);
  assert.ok(b.group.children[0].rotation.x < -0.1);
});

test("lean grows with the wind and stops at 15 degrees", () => {
  assert.ok(windLeanDeg(2) < windLeanDeg(10));
  assert.equal(windLeanDeg(40), 15);
});

test("rounded marks go, and the finish shows once the first mark is rounded (Rosa)", () => {
  const b = new Buoys();
  b.set([{ x: 0, y: 400 }, { x: 300, y: 200 }, { x: 0, y: 0 }]);
  const vis = () => b.group.children.map((c) => c.visible);
  b.update({ x: 0, y: 0 }, 0, 0);
  assert.deepEqual(vis(), [true, true, false]);
  b.update({ x: 0, y: 0 }, 1, 1);
  assert.deepEqual(vis(), [false, true, true]);
});
