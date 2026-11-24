// The Randolph boat's look (24 Nov 2026): her colours stay in step between the Blender build, the
// repaint table and the drawn-in-code boat, and the fittings copied from the Randolph team's own
// model (blender/randolph_fittings.json, made by scripts/randolph_fittings.py) stay small, in
// place, and few enough to draw cheaply. See docs/qa/boat-look-2026-11.md.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILT } from "../src/boats/paint";

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const hex = (n: number) => `0x${n.toString(16).padStart(6, "0")}`;

test("the Randolph boat's colours agree in the build, the repaint table and the drawn-in-code boat", () => {
  const b = BUILT.randolph;
  const build = read("../blender/build_randolph.py").toLowerCase();
  const paint = /paint = hullpaint\(top=(\w+), deck=(\w+), boot=(\w+), bottom=(\w+)\)/.exec(build);
  assert.ok(paint, "build_randolph.py still has its PAINT line");
  const val = (s: string) => (s === "hivis" ? Number(/hivis = (0x[0-9a-f]+)/.exec(build)![1]) : Number(s));
  assert.deepEqual(paint.slice(1).map(val), [b.top, b.deck, b.boot, b.bottom]);
  const model = read("../src/boats/model.ts");
  assert.ok(model.includes(`kit.hull(R, { top: ${hex(b.top)}, deck: ${hex(b.deck)}, bottom: ${hex(b.bottom)}, boot: ${hex(b.boot)} })`), "model.ts buildRandolph paints the same hull");
});

interface Part {
  id: string;
  group: string;
  mat: string;
  nv: number;
  nf: number;
  pos: string;
  idx: string;
}
const file = JSON.parse(read("../blender/randolph_fittings.json")) as { source: string; their_version: string; parts: Part[] };
const i16 = (b64: string) => {
  const u = Buffer.from(b64, "base64");
  return new Int16Array(u.buffer, u.byteOffset, u.byteLength / 2);
};
const u16 = (b64: string) => {
  const u = Buffer.from(b64, "base64");
  return new Uint16Array(u.buffer, u.byteOffset, u.byteLength / 2);
};

test("the copied fittings say where they came from", () => {
  assert.match(file.source, /sheltonr2\/drone-boat/);
  assert.match(file.source, /MIT/);
  assert.ok(file.their_version);
  assert.match(read("../../THIRD_PARTY_NOTICES.md"), /randolph_fittings\.json/);
});

test("the fittings are whole, on the boat, and thin enough to draw cheaply", () => {
  let triangles = 0;
  for (const p of file.parts) {
    const pos = i16(p.pos);
    const idx = u16(p.idx);
    assert.equal(pos.length, p.nv * 3, p.id);
    assert.equal(idx.length, p.nf * 3, p.id);
    assert.ok(idx.every((i) => i < p.nv), `${p.id}: every corner is a point it has`);
    triangles += p.nf;
    for (let i = 0; i < pos.length; i += 3) {
      const [x, y, z] = [pos[i] / 1e4, pos[i + 1] / 1e4, pos[i + 2] / 1e4]; // m: aft from the bow, up from the hull bottom, to port
      assert.ok(x > 0.2 && x < 1.75 && y > -0.5 && y < 0.8 && Math.abs(z) < 0.2, `${p.id}: a point at ${x}, ${y}, ${z} is off the boat`);
    }
  }
  assert.ok(triangles <= 9000, `${triangles} triangles: their print-ready parts are meant to be thinned to a few hundred each`);
});

test("the fittings add few things to draw, and move with the right part", () => {
  const groups = new Set(file.parts.map((p) => `${p.group}/${p.mat}`));
  // One mesh per group and material; each is drawn every frame, and again for shadows.
  assert.ok(groups.size <= 8, [...groups].join(" "));
  const of = (id: string) => file.parts.find((p) => p.id === id)!.group;
  assert.equal(of("P02"), "vane"); // the wind-vane arm turns with the vane
  assert.equal(of("P10a"), "flap"); // the tail fin is found by name (boats/gear.ts)
  assert.equal(of("P10b"), "flap");
  assert.equal(of("P08"), "wing"); // the spar clamp turns with the wing
  // One rudder on the centreline: the Boatyard copies it and moves each 0.1 m out for the twin.
  for (const p of file.parts.filter((q) => q.group === "rudder")) {
    const pos = i16(p.pos);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 2; i < pos.length; i += 3) {
      lo = Math.min(lo, pos[i]);
      hi = Math.max(hi, pos[i]);
    }
    assert.ok(Math.abs(lo + hi) / 2e4 < 0.002, `${p.id} sits on the centreline`);
  }
});
