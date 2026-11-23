// The Randolph team's current boat, Rev E1 (#50, 21 Nov 2026): one more Randolph base, wired like
// Rev C5 in every place a player meets it.
//   npm run test:unit
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { RANDOLPH_AS_BUILT, randolphAsBuilt, type MyBoat } from "../src/myboat";
import { RANDOLPH_REVC, RANDOLPH_REVE1 } from "../src/motion";
import { pickerEntries } from "../src/ui/boatPicker";
import { boatNaming } from "../src/ui/myboatAdapter";
import { BASE_KEYS, baseFromHash, isRandolphBase, randolphCatalog } from "../src/yard/bases";
import { withSim, type Catalog, type SimSlots } from "../src/yard/design";
import { racePick } from "../src/helm/raceSource";
import { rivalName } from "../src/helm/whoSteers";
import { watchBase, watchName } from "../src/helm/watchSource";

const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;
const cat = withSim(JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog, sim);

test("Rev E1 is a boat to pick, first of the Randolph team's, and always our model", () => {
  const rows = pickerEntries(null).filter((e) => e.group === "The Randolph team's boats");
  assert.deepEqual(rows.map((e) => e.id), ["reve1", "revc", "revb"]);
  assert.match(rows[0].name, /Rev E1 \(our model\)/);
  assert.match(rows[0].fact, /current/);
  assert.doesNotMatch(rows[1].fact, /\bcurrent\b/, "Rev C5 is no longer called their current design");
  const mine = { ...RANDOLPH_AS_BUILT.reve1, saved: "" } as MyBoat;
  assert.equal(randolphAsBuilt(mine), "reve1");
  assert.deepEqual(boatNaming({ kind: "yard", base: "reve1", name: "Rev E1" }), { name: "Rev E1 (our model)" });
  assert.equal(rivalName("reve1", null), "Randolph Rev E1 (our model)");
  assert.equal(watchBase("Randolph Rev E1"), "reve1");
  assert.equal(watchName("Randolph Rev E1"), "Randolph Rev E1 (our model)");
  assert.equal(watchBase("Randolph Rev C"), "revc");
});

test("Rev E1 is a Boatyard base with Rev C5's slots, as built by default", () => {
  assert.ok(BASE_KEYS.includes("reve1") && isRandolphBase("reve1") && !isRandolphBase("kayak"));
  assert.equal(baseFromHash("#base=reve1&rudder=single"), "reve1");
  const e1 = randolphCatalog("reve1", sim, cat)!;
  const c5 = randolphCatalog("revc", sim, cat)!;
  assert.deepEqual(e1.slots.map((s) => s.id), c5.slots.map((s) => s.id));
  assert.equal(e1.plannedKg, 28.5);
  const picked = Object.fromEntries(e1.slots.map((s) => [s.id, s.opts.find((o) => o.def)?.id]));
  assert.equal(picked.rudder, "twin");
  assert.equal(picked.keel, "bulb-9kg");
  assert.equal(sim.bases!.reve1.design, "configs/randolph_rev_e1.yaml");
});

test("Rev E1 rides like a slightly heavier Rev C5, and can race", () => {
  assert.equal(RANDOLPH_REVE1.mass, 28.5);
  assert.ok(RANDOLPH_REVE1.mass > RANDOLPH_REVC.mass);
  const at = (h: typeof RANDOLPH_REVC, deg: number) => h.gzTable.find(([a]) => a === deg)![1];
  assert.ok(at(RANDOLPH_REVE1, 20) < at(RANDOLPH_REVC, 20) && at(RANDOLPH_REVE1, 20) > 0.9 * at(RANDOLPH_REVC, 20));
  assert.ok(at(RANDOLPH_REVE1, 120) > 0, "still rights itself from upside down");
  assert.deepEqual(racePick("kayak,reve1", "1", null), { a: {}, b: { base: "reve1" }, launch: 1, breakdowns: true });
});
