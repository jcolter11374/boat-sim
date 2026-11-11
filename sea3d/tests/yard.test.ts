// Checks for the Boatyard's design arithmetic (src/yard/design.ts) on the real parts catalog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  PLANNED_KG,
  decodeDesign,
  designYaml,
  encodeDesign,
  hintsFor,
  nightHours,
  optionOf,
  plannedDesign,
  simChoices,
  summarise,
  withSim,
  type Catalog,
  type SimSlots,
} from "../src/yard/design";
import { Pool, gridDistance } from "../src/yard/launch";
import { baseFromHash, randolphCatalog } from "../src/yard/bases";
import { replayUrl } from "../src/replay/data";

const cat = JSON.parse(readFileSync("public/parts-catalog.json", "utf8")) as Catalog;
const sim = JSON.parse(readFileSync("public/sim-slots.json", "utf8")) as SimSlots;

test("every option has a stable id, unique in its slot, and each slot has a planned choice", () => {
  for (const s of cat.slots) {
    const ids = s.opts.map((o) => o.id);
    assert.ok(ids.every((id) => typeof id === "string" && /^[a-z0-9-]+$/.test(id)), `${s.id}: ${ids}`);
    assert.equal(new Set(ids).size, ids.length, `${s.id}: duplicate ids`);
    assert.equal(s.opts.filter((o) => o.def).length, 1, `${s.id}: one planned option`);
  }
});

test("the planned build adds up to the catalog's own totals", () => {
  const s = summarise(cat, plannedDesign(cat));
  const parts = cat.base.cost + cat.slots.reduce((a, sl) => a + sl.opts.find((o) => o.def)!.cost, 0);
  assert.ok(Math.abs(s.partsCost - parts) < 0.01);
  assert.equal(s.massKg, PLANNED_KG);
  assert.equal(s.thrusters, 2);
  assert.equal(s.solarW, 250);
  assert.equal(s.batteryWh, 1280);
  assert.equal(s.boxes, 2);
  assert.ok(s.beacon && s.ais && s.antifouling);
});

test("swapping parts changes cost, weight and power the way the catalog says", () => {
  const d = plannedDesign(cat);
  const base = summarise(cat, d);
  d.picks.bat = "two-100ah";
  d.picks.thr = "one-t200";
  const s = summarise(cat, d);
  assert.equal(s.batteryWh, 2560);
  assert.equal(s.thrusters, 1);
  const dkg = optionOf(cat, "bat", d)!.kg + optionOf(cat, "thr", d)!.kg;
  assert.ok(Math.abs(s.massKg - (base.massKg + dkg)) < 1e-9);
  assert.ok(nightHours(s) > nightHours(base) * 1.9, "twice the battery runs about twice as long");
  assert.ok(s.estimates.includes("Batteries"));
});

test("hints say what a swap means, in plain words", () => {
  const bat = cat.slots.find((s) => s.id === "bat")!;
  const two50 = bat.opts.find((o) => o.id === "two-50ah")!;
  const h = hintsFor(two50, bat.opts.find((o) => o.id === "two-100ah")!);
  assert.ok(h.some((x) => /heavier: sits \d+ mm lower/.test(x)), h.join("; "));
  assert.ok(h.some((x) => /longer at night/.test(x)));
  assert.ok(h.some((x) => /estimate/.test(x)));
  const one = hintsFor(two50, bat.opts.find((o) => o.id === "one-50ah")!);
  assert.ok(one.some((x) => /less power at night/.test(x)));
  assert.deepEqual(hintsFor(two50, two50), []);
});

test("share links round-trip and stay short; junk falls back to the planned build", () => {
  const d = plannedDesign(cat);
  assert.equal(encodeDesign(cat, d), "");
  d.picks.sol = "solar-300";
  d.picks.ais = "none";
  d.cruiseW = 15;
  const hash = encodeDesign(cat, d);
  assert.equal(hash, "#sol=solar-300&ais=none&w=15");
  assert.deepEqual(decodeDesign(cat, hash), d);
  assert.deepEqual(decodeDesign(cat, "#sol=solar-9000&w=7&zzz=1"), plannedDesign(cat));
});

test("the design file lists every slot's pick and the totals", () => {
  const y = designYaml(cat, plannedDesign(cat), 'quote "test"');
  for (const s of cat.slots) assert.match(y, new RegExp(`^  ${s.id}: [a-z0-9-]+$`, "m"));
  assert.match(y, /^cruise_w: 25$/m);
  assert.match(y, /^name: "quote \\"test\\""$/m);
});

test("the grid launcher's distance counts differing modelled slots, then cruise watts", () => {
  const c = withSim(cat, sim);
  const plan = plannedDesign(c);
  const b = (options: Record<string, string | number>) => ({ id: "", boat: "v4 kayak", label: "", options, odds: null, replays: [] });
  assert.deepEqual(gridDistance(b({ ...plan.picks, cruise_w: 25 }), c, plan), [0, 0]);
  // A grid build that lists only what differs: unlisted slots are the planned choice.
  assert.deepEqual(gridDistance(b({ thr: "one-t200", cruise_w: 20 }), c, plan), [1, 5]);
  // Options the simulator doesn't model yet don't count against a build.
  const [slot, opt] = c.slots.flatMap((s) => s.opts.filter((o) => o.effect === "no effect yet").map((o) => [s.id, o.id] as const))[0];
  const fancy = { ...plan, picks: { ...plan.picks, [slot]: opt } };
  assert.deepEqual(gridDistance(b({ cruise_w: 25 }), c, fancy), [0, 0]);
  // Wing sail only: no motors, so the thruster choice and cruise power don't count (Theo's k-p0-drive.wing-sail).
  const sail = { picks: { ...plan.picks, drive: "wing-sail", thr: "one-t200" }, cruiseW: 20 };
  assert.deepEqual(gridDistance(b({ drive: "wing-sail", cruise_w: 0 }), c, sail), [0, 0]);
  assert.equal(summarise(c, sail).cruiseW, 0);
});

test("the simulator's notes merge into the catalog without losing prices", () => {
  const c = withSim(cat, sim);
  for (const s of cat.slots) {
    const m = c.slots.find((x) => x.id === s.id)!;
    assert.deepEqual(m.opts.map((o) => [o.id, o.cost, o.kg]), s.opts.map((o) => [o.id, o.cost, o.kg]), s.id);
  }
  for (const id of ["drive", "material", "shape"]) {
    const s = c.slots.find((x) => x.id === id);
    assert.ok(s, `new slot ${id}`);
    assert.equal(s!.opts.filter((o) => o.def).length, 1, `${id} has one planned choice`);
    assert.ok(s!.opts.slice(1).every((o) => o.priceTbd), `${id}: alternatives have no price yet`);
  }
  assert.equal(withSim(cat, null), cat);
  // Share links carry the new slots too.
  const d = plannedDesign(c);
  d.picks.shape = "cat";
  assert.equal(decodeDesign(c, encodeDesign(c, d)).picks.shape, "cat");
  assert.equal(simChoices(d).shape, "cat");
  assert.equal(simChoices(d).cruise_w, 25);
  // Against the planned build only the changes go to the simulator, so a slot it doesn't know yet
  // (a new part left as planned) can't stop a launch.
  const plan = plannedDesign(c);
  assert.deepEqual(simChoices(plan, plan), { cruise_w: 25 });
  assert.deepEqual(simChoices(d, plan), { shape: "cat", cruise_w: 25 });
});

/** A stand-in Web Worker: answers per `script`, or never. */
class FakeWorker {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: { message: string; preventDefault?: () => void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  constructor(private script: (msg: { id: number }, w: FakeWorker) => void) {}
  postMessage(msg: { id: number }) {
    setTimeout(() => this.script(msg, this), 1);
  }
  terminate() {
    this.terminated = true;
  }
  say(data: unknown) {
    if (!this.terminated) this.onmessage?.({ data });
  }
}
const pool = (script: (msg: { id: number }, w: FakeWorker) => void, n = 2, loadMs = 50, runMs = 80) => {
  const ws: FakeWorker[] = [];
  const p = new Pool(n, () => (ws.push(new FakeWorker(script)), ws.at(-1) as unknown as Worker), loadMs, runMs);
  return { p, ws };
};

test("a launch in the browser always ends: answers, errors, crashes and silence", async () => {
  const ok = pool((m, w) => w.say({ id: m.id, ok: true, value: 42 }));
  assert.equal(await ok.p.ask(1, { type: "run" }), 42);

  const err = pool((m, w) => w.say({ id: m.id, ok: false, error: "unknown slot 'shape'" }));
  await assert.rejects(err.p.ask(0, {}), /unknown slot/);

  // The worker script itself fails (old browser, blocked download): every job fails, workers stop.
  const crash = pool((_m, w) => w.onerror?.({ message: "SyntaxError: import declarations" }));
  const a = crash.p.ask(0, {});
  const b = crash.p.ask(1, {});
  await assert.rejects(a, /simulator stopped.*SyntaxError/);
  await assert.rejects(b, /simulator stopped/);
  assert.ok(crash.ws.every((w) => w.terminated));
  await assert.rejects(crash.p.ask(0, {}), /simulator stopped/); // spent

  // Never answers: the loading budget runs out.
  const t0 = Date.now();
  await assert.rejects(pool(() => {}).p.ask(0, {}), /went quiet for 0 s/);
  assert.ok(Date.now() - t0 < 1000);

  // Progress keeps a slow job alive past the loading budget; then the voyage budget applies.
  const slow = pool((m, w) => {
    setTimeout(() => w.say({ type: "progress", text: "Sailing..." }), 30);
    setTimeout(() => w.say({ id: m.id, ok: true, value: "home" }), 100);
  });
  assert.equal(await slow.p.ask(0, {}), "home");
});

test("replays are read from this site only", () => {
  const o = "https://jcolter11374.github.io";
  assert.equal(replayUrl("./voyages", "a.json", o), "./voyages/a.json");
  assert.equal(replayUrl(".", `${o}/boat-sim/boatyard/x.json`, o), `${o}/boat-sim/boatyard/x.json`);
  assert.equal(replayUrl(".", `blob:${o}/1234`, o), `blob:${o}/1234`);
  assert.throws(() => replayUrl(".", "https://example.com/x.json", o));
});

// ---------- the Randolph boats as a starting point (bases.ts) ----------

test("the Randolph bases build from Theo's slot table, as built by default", () => {
  const k = withSim(cat, sim);
  for (const key of ["revc", "revb"] as const) {
    const rc = randolphCatalog(key, sim, k);
    assert.ok(rc, key);
    const plan = plannedDesign(rc!);
    for (const [slot, id] of Object.entries(sim.bases![key].defaults)) if (slot !== "spares") assert.equal(plan.picks[slot], id, `${key} ${slot}`);
    assert.equal(plan.base, key);
    const s = summarise(rc!, plan);
    // As built: their published weight, 40 W of panels, 192 Wh, no motor, the YB3 as backup tracker.
    assert.equal(s.massKg, key === "revc" ? 26.9 : 20.8); // Rev C3 (11 Nov 2026)
    assert.equal(s.solarW, 40);
    assert.equal(s.batteryWh, 192);
    assert.equal(s.thrusters, 0);
    assert.equal(s.beacon, true);
    assert.equal(s.electronicsWhDay, 33); // their 33 Wh a day
    assert.equal(encodeDesign(rc!, plan), "");
    assert.ok(s.partsCost > 2000 && s.partsCost < 3500, `${key} cost ${s.partsCost}`);
  }
});

test("Randolph base: their thruster counts, sinks on a small waterplane, links carry the base", () => {
  const rc = randolphCatalog("revc", sim, withSim(cat, sim))!;
  const d = decodeDesign(rc, "#base=revc&drive=wing-thruster&rbat=lfp-384wh");
  assert.equal(d.picks.drive, "wing-thruster");
  const s = summarise(rc, d);
  assert.equal(s.thrusters, 1);
  assert.equal(s.batteryWh, 384);
  const hints = hintsFor(optionOf(rc, "rbat", plannedDesign(rc)), optionOf(rc, "rbat", d)!, rc.mmPerKg);
  assert.ok(hints.some((h) => /sits [45] mm lower/.test(h)), hints.join("; "));
  assert.equal(baseFromHash("#base=revc&x=1"), "revc");
  assert.equal(baseFromHash("#base=nope"), "kayak");
  assert.equal(baseFromHash(""), "kayak");
});

test("Randolph designs name their base for the simulator, and only match their own grid builds", () => {
  const k = withSim(cat, sim);
  const rc = randolphCatalog("revc", sim, k)!;
  const plan = plannedDesign(rc);
  const d = { ...plan, picks: { ...plan.picks, rudder: "single" } };
  assert.deepEqual(simChoices(d, plan), { base: "revc", rudder: "single", cruise_w: 25 });
  assert.equal(simChoices(plannedDesign(k)).base, undefined);
  const b = (boat: string, options: Record<string, string | number>) => ({ id: "", boat, label: "", options, odds: null, replays: [] });
  assert.deepEqual(gridDistance(b("Randolph Rev C", { base: "revc" }), rc, plan), [0, 0]);
  assert.deepEqual(gridDistance(b("Randolph Rev C", { base: "revc", rudder: "single" }), rc, d), [0, 0]);
  assert.deepEqual(gridDistance(b("Randolph Rev C", { base: "revc" }), rc, d), [1, 0]);
  // Never a kayak build, another base, or an older Randolph build without a base.
  assert.equal(gridDistance(b("v4 kayak", { cruise_w: 25 }), rc, plan)[0], Infinity);
  assert.equal(gridDistance(b("Randolph Rev B", { base: "revb" }), rc, plan)[0], Infinity);
  assert.equal(gridDistance(b("Randolph Rev B", { wing: "published" }), rc, plan)[0], Infinity);
  assert.equal(gridDistance(b("Randolph Rev C", { base: "revc" }), k, plannedDesign(k))[0], Infinity);
});
