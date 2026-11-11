import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAP, decodeShips, densityAt, HOUR, laneHeading, shipAt, shipsNear, metresTo, Traffic, type ShipGrid } from "../src/traffic";
import { shipLights } from "../src/boats/ships";
import { GREEN, inArc, RED, WHITE } from "../src/boats/navlights";

const buf = readFileSync(new URL("../public/ships.bin", import.meta.url));
const real = decodeShips(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));

/** A flat 2 x 2 degree sea with the same traffic everywhere (or a lane along one row). */
function flat(perKm2: number, lane?: { row: number; perKm2: number }): ShipGrid {
  const n = 20;
  const b = (d: number) => Math.round((Math.log10(d) + 7) * 32) + 1;
  const cells = new Uint8Array(n * n).fill(b(perKm2));
  if (lane) for (const dr of [-1, 0, 1]) for (let j = 0; j < n; j++) cells[(lane.row + dr) * n + j] = b(lane.perKm2 / (dr ? 10 : 1));
  return { lat0: 39, lon0: -41, res: 0.1, nlat: n, nlon: n, cells };
}

test("the traffic map: busy where ships are, empty inland", () => {
  assert.ok(densityAt(real, 50.0, -2.0) > 0.005, `English Channel ${densityAt(real, 50.0, -2.0)}`);
  assert.ok(densityAt(real, 40.0, -45.0) < 1e-4, `mid-Atlantic ${densityAt(real, 40.0, -45.0)}`);
  assert.ok(densityAt(real, 40.0, -45.0) > 0, "but not empty");
  assert.equal(densityAt(real, 40.4, -3.7), 0, "Madrid");
  assert.equal(densityAt(real, 39.0, -100), 0, "off the map");
});

test("ships come where the map says, as many as it says (capped in harbours)", () => {
  const count = (g: ShipGrid) => {
    let n = 0;
    const runs = 120;
    for (let q = 0; q < runs; q++) n += shipsNear(g, 40, -40, 1.75e9 + q * 5000, 15000).length;
    return n / runs;
  };
  const area = Math.PI * 15 ** 2; // km²
  const d = 0.005;
  const busy = count(flat(d));
  assert.ok(Math.abs(busy / (d * area) - 1) < 0.2, `${busy.toFixed(2)} ships within 15 km, expected ${(d * area).toFixed(2)}`);
  const harbour = count(flat(0.3));
  assert.ok(Math.abs(harbour / (CAP * area) - 1) < 0.2, `${harbour.toFixed(2)} in a harbour, capped near ${(CAP * area).toFixed(2)}`);
  assert.ok(count(flat(1e-5)) < 0.05, "hardly any mid-ocean");
});

test("the same hour and place always shows the same ships", () => {
  const g = flat(0.005);
  const a = shipsNear(g, 40, -40, 1.75e9).map((s) => s.id);
  const b = shipsNear(g, 40, -40, 1.75e9).map((s) => s.id);
  assert.deepEqual(a, b);
  assert.ok(a.length > 0);
});

test("no ship sails over land", () => {
  for (let q = 0; q < 30; q++) {
    for (const s of shipsNear(real, 38.65, -9.4, 1.75e9 + q * 1300)) {
      for (const dt of [-HOUR / 2, 0, HOUR / 2]) {
        const p = shipAt(s, s.tMid + dt);
        assert.ok(densityAt(real, p.lat, p.lon) > 0, `${s.id} at ${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`);
      }
    }
  }
});

test("merchant ships follow the lane; a lane running east-west sends them east or west", () => {
  const g = flat(1e-4, { row: 10, perKm2: 0.01 });
  // Just off the lane's axis, where the traffic falls away to the north.
  const h = laneHeading(g, 11, 10)!;
  assert.ok(Math.min(Math.abs(h - 90), Math.abs(h - 270)) < 1, `lane at ${h}`);
  assert.equal(laneHeading(flat(0.005), 10, 10), null, "no grain in flat traffic");
  let n = 0;
  for (let q = 0; q < 40; q++)
    for (const s of shipsNear(g, 40.05, -40, 1.75e9 + q * 3000, 20000)) {
      if (s.kind === "fishing" || s.anchored) continue;
      const i = Math.floor((shipAt(s, s.tMid).lat - g.lat0) / g.res);
      if (laneHeading(g, i, 10) == null) continue;
      n++;
      const off = Math.min(Math.abs(s.heading - 90), Math.abs(s.heading - 270), Math.abs(s.heading - 450));
      assert.ok(off <= 16, `heading ${s.heading.toFixed(0)}`);
    }
  assert.ok(n > 5, `${n} lane ships`);
});

test("nothing pops into or out of sight", () => {
  type S = Parameters<typeof shipAt>[0];
  const tr = Traffic.from(flat(0.01));
  let t = 1.75e9;
  const seeing = 4000;
  tr.update(40, -40, t, seeing, 1);
  assert.ok(tr.shown.ships > 0);
  const inView = () => {
    const m = new Map<string, S>();
    for (const [id, l] of (tr as unknown as { live: Map<string, { s: S }> }).live) if (metresTo(40, -40, shipAt(l.s, t)) < seeing) m.set(id, l.s);
    return m;
  };
  let before = inView();
  let seen = 0;
  for (let q = 0; q < 400; q++) {
    t += 30;
    tr.update(40, -40, t, seeing, 1);
    const now = inView();
    // A ship may only enter or leave the view across its edge, never in the middle of it.
    for (const [id, s] of now) if (!before.has(id)) assert.ok(metresTo(40, -40, shipAt(s, t - 30)) >= seeing, `${id} appeared in view`);
    for (const [id, s] of before) if (!now.has(id)) assert.ok(metresTo(40, -40, shipAt(s, t)) >= seeing, `${id} vanished in view`);
    seen += now.size;
    before = now;
  }
  assert.ok(seen > 100, `ships were in view (${seen})`);
});

test("big ships' lights by the rules: two masthead lights, the aft one higher; sidelights; sternlight; anchor lights", () => {
  for (const kind of ["container", "tanker"] as const) {
    const { underway, anchored } = shipLights(kind);
    const mast = underway.filter((l) => l.arcs[0].colour === WHITE && l.arcs[0].from === 247.5);
    assert.equal(mast.length, 2, `${kind}: two masthead lights`);
    const [fwd, aft] = [...mast].sort((a, b) => a.at.x - b.at.x);
    assert.ok(aft.at.y - fwd.at.y >= 4.5, `${kind}: the aft one at least 4.5 m higher (Rule 23)`);
    const m = mast[0].arcs[0];
    for (const b of [0, 90, 112, 248, 300]) assert.ok(inArc(m, b), `masthead seen at ${b}`);
    for (const b of [113, 180, 247]) assert.ok(!inArc(m, b), `masthead hidden at ${b}`);
    const red = underway.find((l) => l.arcs[0].colour === RED)!;
    const green = underway.find((l) => l.arcs[0].colour === GREEN)!;
    assert.ok(red.at.z > 0 && green.at.z < 0, `${kind}: red to port (+z), green to starboard`);
    assert.ok(underway.some((l) => l.arcs[0].colour === WHITE && l.arcs[0].from === 112.5 && l.arcs[0].to === 247.5), "sternlight");
    assert.equal(anchored.length, 2, "at anchor: two all-round whites");
    const [a0, a1] = [...anchored].sort((a, b) => a.at.x - b.at.x);
    assert.ok(a0.at.y > a1.at.y, "the forward anchor light higher");
  }
  const f = shipLights("fishing").underway;
  const g = f.find((l) => l.arcs[0].colour === GREEN && l.arcs[0].to === 360 && l.arcs[0].from === 0)!;
  const w = f.find((l) => l.arcs[0].colour === WHITE && l.arcs[0].to === 360)!;
  assert.ok(g.at.y > w.at.y, "trawling: green over white (Rule 26)");
});
