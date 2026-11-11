import { test } from "node:test";
import assert from "node:assert/strict";
import { beaufort, foamStreaks, spindrift, sprayVisibility, whiteSea, whitecaps } from "../src/storm";

const KN = 0.514444; // m/s per knot
// The Beaufort scale's lower bound for each force, in knots (WMO).
const FORCE_KN: Record<number, number> = { 4: 11, 6: 22, 7: 28, 8: 34, 9: 41, 10: 48, 11: 56, 12: 64 };

test("Beaufort force from the wind: each force starts where the scale says", () => {
  for (const [f, kn] of Object.entries(FORCE_KN)) {
    const b = beaufort(kn * KN);
    assert.ok(Math.abs(b - (Number(f) - 0.5)) < 0.35, `force ${f} at ${kn} kn gives ${b.toFixed(2)}`);
  }
  assert.equal(beaufort(0), 0);
});

test("the sea whitens as the scale describes", () => {
  const at = (f: number) => whiteSea((FORCE_KN[f] + 3) * KN);
  assert.ok(at(4) < 0.02, `force 4: a few whitecaps (${at(4)})`);
  assert.ok(at(6) > 0.01 && at(6) < 0.08, `force 6: white crests more extensive (${at(6)})`);
  assert.equal(foamStreaks(26 * KN), 0, "no blown streaks below force 7");
  assert.ok(foamStreaks(31 * KN) > 0, "force 7: foam begins to be blown in streaks");
  assert.ok(at(8) > 0.08 && at(8) < 0.3, `force 8: well-marked streaks (${at(8)})`);
  assert.ok(at(10) > 0.45, `force 10: the sea takes on a white appearance (${at(10)})`);
  assert.ok(at(12) > 0.85, `force 12: completely white (${at(12)})`);
  for (let u = 0; u < 40; u += 0.5) {
    assert.ok(whiteSea(u + 0.5) >= whiteSea(u), "never less white in more wind");
    assert.ok(whitecaps(u) <= 0.3);
  }
});

test("spindrift starts at force 8, and spray closes the view in from force 9", () => {
  assert.equal(spindrift(30 * KN), 0, "force 7: none");
  assert.ok(spindrift(37 * KN) > 0.05, "force 8: crests break into spindrift");
  assert.ok(spindrift(52 * KN) > 0.8, "force 10: thick");
  assert.equal(sprayVisibility(38 * KN), Infinity, "force 8: no effect on how far you see");
  const v9 = sprayVisibility(45 * KN);
  const v10 = sprayVisibility(52 * KN);
  const v12 = sprayVisibility(70 * KN);
  assert.ok(v9 > 2500 && v9 < 6000, `force 9 ${v9}`);
  assert.ok(v10 > 700 && v10 < 2000, `force 10 ${v10}`);
  assert.ok(v12 > 250 && v12 < 600, `force 12 ${v12}`);
});
