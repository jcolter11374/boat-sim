// Checks for the cloud and fog rules (clouds.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { clearSkyGhi, cloudFromSun, cumulusHeaps, fogChance } from "../src/clouds";

test("clear-sky sunlight is about 1000 W/m² with the sun high, nothing below the horizon", () => {
  assert.ok(clearSkyGhi(90) > 1000 && clearSkyGhi(90) < 1100);
  assert.equal(clearSkyGhi(-5), 0);
});

test("cloud cover from the logged sunlight", () => {
  assert.equal(cloudFromSun(clearSkyGhi(50), 50), 0); // full clear-sky sun: no cloud
  assert.equal(cloudFromSun(0.25 * clearSkyGhi(50), 50), 1); // a quarter of it: overcast
  const half = cloudFromSun(0.6 * clearSkyGhi(40), 40)!;
  assert.ok(half > 0.4 && half < 0.7, `${half}`);
  assert.equal(cloudFromSun(100, 3), null); // sun too low to tell
  assert.equal(cloudFromSun(null, 40), null);
});

test("fog: only on cold water in light wind, and only on some days", () => {
  const days = Array.from({ length: 60 }, (_, i) => 18400 + i);
  const cold = days.map((d) => fogChance(42, -55, 4, d + 0.3));
  const foggy = cold.filter((f) => f > 0.5).length;
  assert.ok(foggy > 5 && foggy < 40, `${foggy} foggy days of 60`);
  for (const d of days) {
    assert.equal(fogChance(42, -55, 25, d), 0); // a blow clears it
    assert.equal(fogChance(33, -55, 4, d), 0); // warm water south of the Gulf Stream
    assert.equal(fogChance(42, -25, 4, d), 0); // the warmer eastern Atlantic
  }
  assert.equal(fogChance(NaN, -55, 4, 18400), 0);
});

test("the cumulus heaps are on at sea, off on the title and on Low, and the address can force either", () => {
  assert.equal(cumulusHeaps(true, "high", ""), true);
  assert.equal(cumulusHeaps(true, "ultra", ""), true);
  assert.equal(cumulusHeaps(true, "low", ""), false); // Low keeps the earlier cumulus
  assert.equal(cumulusHeaps(false, "high", ""), false); // the title keeps its signed-off clouds
  assert.equal(cumulusHeaps(true, "high", "?cumulus=old"), false);
  assert.equal(cumulusHeaps(false, "low", "?cumulus=new"), true);
});
