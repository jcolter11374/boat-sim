// The Boatyard's quick odds estimate (src/yard/estimate.ts) against the real grid.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { plannedDesign, withSim, type Catalog, type Design, type SimSlots } from "../src/yard/design";
import { randolphCatalog } from "../src/yard/bases";
import { OddsModel } from "../src/yard/estimate";
import type { GridBuild } from "../src/yard/launch";

const cat = withSim(JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog, JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots);
const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;
const builds = (JSON.parse(readFileSync("public/boatyard/index.json", "utf8")) as { builds: GridBuild[] }).builds;
const odds = (id: string) => builds.find((b) => b.id === id)!.odds!.odds;
const plan = plannedDesign(cat);
const with_ = (d: Design, picks: Record<string, string>, cruiseW = d.cruiseW): Design => ({ ...d, picks: { ...d.picks, ...picks }, cruiseW });

test("a tested build is its own answer, on every boat", () => {
  const m = new OddsModel(cat, builds);
  const e = m.odds(plan)!;
  assert.deepEqual([e.p, e.tested, e.planned], [odds("k-p25"), true, odds("k-p25")]);
  assert.equal(m.odds(with_(plan, { thr: "one-t200" }))!.p, odds("k-p25-thr.one-t200"));
  assert.equal(m.odds(with_(plan, {}, 15))!.p, odds("k-p15"));
  for (const key of ["revc", "revb"] as const) {
    const rc = randolphCatalog(key, sim, cat)!;
    const r = new OddsModel(rc, builds).odds(plannedDesign(rc))!;
    assert.deepEqual([r.p, r.tested], [odds(key), true]);
  }
});

// Leave one out: a tested multi-part build, with itself taken out of the grid,
// estimated from the rest, lands within 5 points of what it measured.
const COMBOS: [string, Record<string, string>, number][] = [
  ["k-p25-brain.one-box-beacon.none", { brain: "one-box", beacon: "none" }, 25],
  ["k-p25-sol.solar-300-bat.two-100ah", { sol: "solar-300", bat: "two-100ah" }, 25],
  ["k-p30-sol.solar-300-bat.two-100ah", { sol: "solar-300", bat: "two-100ah" }, 30],
  [
    "k-p15-thr.one-t200-sol.solar-200-bat.one-50ah-mppt.one-mppt-brain.one-box-beacon.none-ais.none-paint.none",
    { thr: "one-t200", sol: "solar-200", bat: "one-50ah", mppt: "one-mppt", brain: "one-box", beacon: "none", ais: "none", paint: "none" },
    15,
  ],
];
for (const [id, picks, cw] of COMBOS)
  test(`estimate of ${id.slice(0, 40)}... with it left out is within 5 points`, () => {
    const m = new OddsModel(cat, builds.filter((b) => b.id !== id));
    const e = m.odds(with_(plan, picks, cw))!;
    assert.equal(e.tested, false);
    assert.ok(e.p !== null, `no estimate: ${e.missing}`);
    assert.ok(Math.abs(e.p! - odds(id)) <= 0.05, `${id}: estimate ${(e.p! * 100).toFixed(1)}%, tested ${(odds(id) * 100).toFixed(0)}%`);
  });

test("a part no tested build measures gives no estimate, and names it", () => {
  const m = new OddsModel(cat, builds);
  const e = m.odds(with_(plan, { ais: "dy-ait1500", thr: "one-t200" }))!;
  assert.equal(e.p, null);
  assert.match(e.missing!, /\S/);
  // A part the simulator doesn't sail (radar reflector) changes nothing.
  assert.equal(m.odds(with_(plan, { radar: "davis-echomaster" }))!.p, odds("k-p25"));
});

test("estimates move the right way and stay inside 0..100%", () => {
  const m = new OddsModel(cat, builds);
  // Untested: one motor and no beacon. Worse than either alone.
  const both = m.odds(with_(plan, { thr: "one-t200", beacon: "none" }))!.p!;
  assert.ok(both < odds("k-p25-thr.one-t200") && both < odds("k-p25-beacon.none") && both > 0, String(both));
  // Untested: bigger batteries and 20 W cruise: between the two.
  const p = m.odds(with_(plan, { bat: "two-100ah" }, 20))!.p!;
  assert.ok(p > 0.7 && p < 0.9, String(p));
});
