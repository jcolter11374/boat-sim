import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { animalAt, animalsNear, ANIMALS, LOOK, rateAt, Wildlife, type Animal, type WildlifeMap } from "../src/wildlife";
import { metresTo } from "../src/traffic";

/** A 2 x 2 degree patch of sea with the same life everywhere. */
function flat(per: Partial<Record<Animal, number>>): WildlifeMap {
  const n = 4;
  const groups = Object.fromEntries(ANIMALS.map((k) => [k, new Array(n * n).fill(per[k] ?? 0)])) as Record<Animal, number[]>;
  return { lat0: 39, lon0: -41, res: 0.5, nlat: n, nlon: n, groups };
}

test("groups come as often as the map says", () => {
  for (const kind of ANIMALS) {
    const rho = 0.05; // groups per km²
    const m = flat({ [kind]: rho });
    const r = LOOK[kind].seen;
    let n = 0;
    const runs = 300;
    for (let q = 0; q < runs; q++) n += animalsNear(m, 40, -40, 1.75e9 + q * 977, 1).length;
    const want = rho * Math.PI * (r / 1000) ** 2;
    assert.ok(Math.abs(n / runs / want - 1) < 0.25, `${kind}: ${(n / runs).toFixed(3)} groups in sight, expected ${want.toFixed(3)}`);
  }
});

test("none where the map has none, or on land", () => {
  assert.equal(animalsNear(flat({}), 40, -40, 1.75e9).length, 0);
  const m = flat({ dolphins: 0.5 });
  assert.equal(animalsNear(m, 40, -40, 1.75e9, 1.2, () => false).length, 0);
  assert.equal(rateAt(m, "dolphins", 10, -40), 0, "off the map");
});

test("the same time and place shows the same animals", () => {
  const m = flat({ dolphins: 0.2, whales: 0.05, birds: 0.3 });
  const a = animalsNear(m, 40, -40, 1.75e9).map((e) => e.id);
  assert.deepEqual(a, animalsNear(m, 40, -40, 1.75e9).map((e) => e.id));
  assert.ok(a.length > 0);
});

test("nothing pops into or out of sight", () => {
  const w = Wildlife.from(flat({ dolphins: 0.3, whales: 0.05, birds: 0.3 }));
  type E = Parameters<typeof animalAt>[0];
  let t = 1.75e9;
  const seeing = 5000;
  const inView = () => {
    const m = new Map<string, E>();
    for (const [id, l] of (w as unknown as { live: Map<string, { e: E }> }).live) {
      const d = metresTo(40, -40, animalAt(l.e, t));
      if (d < Math.min(LOOK[l.e.kind].seen, seeing)) m.set(id, l.e);
    }
    return m;
  };
  w.update(40, -40, t, seeing, 1);
  let before = inView();
  let seen = 0;
  for (let q = 0; q < 600; q++) {
    t += 4;
    w.update(40, -40, t, seeing, 1);
    const now = inView();
    for (const [id, e] of now) if (!before.has(id)) assert.ok(metresTo(40, -40, animalAt(e, t - 4)) >= Math.min(LOOK[e.kind].seen, seeing) - 1, `${id} appeared in view`);
    for (const [id, e] of before) if (!now.has(id)) assert.ok(metresTo(40, -40, animalAt(e, t)) >= Math.min(LOOK[e.kind].seen, seeing) - 1, `${id} vanished in view`);
    seen += now.size;
    before = now;
  }
  assert.ok(seen > 50, `animals were in view (${seen})`);
});

test("the built map: more life over the shelf than mid-ocean", { skip: !existsSync(new URL("../public/wildlife.json", import.meta.url)) }, () => {
  const m = JSON.parse(readFileSync(new URL("../public/wildlife.json", import.meta.url), "utf8")) as WildlifeMap;
  for (const k of ANIMALS) assert.equal(m.groups[k].length, m.nlat * m.nlon, k);
  const shelf = rateAt(m, "dolphins", 39.5, -72.5); // off New Jersey, the AMAPPS survey's water
  const mid = rateAt(m, "dolphins", 38.0, -45.0);
  assert.ok(shelf > 2 * mid, `dolphins: shelf ${shelf}, mid-ocean ${mid}`);
  assert.ok(rateAt(m, "birds", 39.5, -72.5) > 0.01, "seabirds off New Jersey");
});
