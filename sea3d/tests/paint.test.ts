// Paint jobs (boats/paint.ts, ui/paintPicker.ts, the paint kept in myboat.ts): checked without graphics. Hana, 14 Nov 2026.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BUILT, INK_DARK, INK_LIGHT, PAINTS, PAINT_NOTE, inkFor, lightness, paintOf, repaintHull, retint, rgbOf, type BuiltPaint, type PaintForm, type PaintScheme, type Rgb } from "../src/boats/paint";
import { STOCK } from "../src/boats/specs";
import { MYBOAT_KEY, PAINT_KEY, RANDOLPH_AS_BUILT, loadMyBoat, loadPaint, randolphAsBuilt, saveMyBoat, savePaint, type StorageLike } from "../src/myboat";
import { paintChoices, swatchSvg } from "../src/ui/paintPicker";

const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sat = (c: Rgb) => (Math.max(...c) - Math.min(...c)) / Math.max(1, Math.max(...c));

test("eight to ten schemes, plainly named, each its own; the classics are there", () => {
  assert.ok(PAINTS.length >= 8 && PAINTS.length <= 10, `${PAINTS.length} schemes`);
  assert.equal(new Set(PAINTS.map((p) => p.id)).size, PAINTS.length);
  assert.equal(new Set(PAINTS.map((p) => p.name)).size, PAINTS.length);
  for (const p of PAINTS) {
    assert.match(p.id, /^[a-z]{2,12}$/);
    assert.match(p.name, /^[A-Z][a-z]+( [a-z]+)?$/, p.name);
  }
  const navy = paintOf("navy")!;
  assert.ok(lightness(rgbOf(navy.hull)) < 0.2 && lightness(rgbOf(navy.deck)) > 0.8, "navy with a white deck");
  const white = paintOf("white")!;
  const stripe = rgbOf(white.boot);
  assert.ok(lightness(rgbOf(white.hull)) > 0.85 && stripe[0] > 150 && stripe[1] < 80 && stripe[2] < 80, "white with a red stripe");
  assert.equal(paintOf("orange")!.hull, BUILT.kayak.top, "safety orange is the kayak's own orange");
  assert.equal(paintOf(""), null, "no choice: her own colours");
  assert.equal(paintOf("chrome"), null);
  assert.match(PAINT_NOTE, /looks only/);
});

test("real paint: decks off-white, grey or sand; dark bottoms in red, blue or black; a stripe that shows", () => {
  for (const p of PAINTS) {
    const deck = rgbOf(p.deck);
    assert.ok(lightness(deck) > 0.6 && sat(deck) < 0.15, `${p.name}: deck`);
    const bottom = rgbOf(p.bottom);
    assert.ok(lightness(bottom) < 0.3, `${p.name}: bottom paint is dark`);
    assert.ok(Math.abs(lightness(rgbOf(p.boot)) - lightness(rgbOf(p.hull))) > 0.25 || dist(rgbOf(p.boot), rgbOf(p.hull)) > 150, `${p.name}: the stripe stands off the hull`);
    // No neon: no colour at full strength in two channels with the third empty.
    const hull = rgbOf(p.hull);
    assert.ok(!(Math.max(...hull) > 250 && Math.min(...hull) < 5), `${p.name}: not neon`);
  }
});

test("every hull reads against the sea: its own colour stands off the water, or a light deck and stripe outline it", () => {
  // The sea by day, at the dusk title and at night (about what the water shader gives near the boat).
  const seas: Rgb[] = [rgbOf(0x1b4a6b), rgbOf(0x3a4658), rgbOf(0x0a1424)];
  for (const p of PAINTS) {
    const hull = rgbOf(p.hull);
    const outlined = lightness(rgbOf(p.deck)) > 0.75 && lightness(rgbOf(p.boot)) > 0.75;
    for (const sea of seas) assert.ok(dist(hull, sea) > 90 || outlined, `${p.name} against ${sea}`);
  }
});

test("registration letters: dark on a light hull, white on a dark one", () => {
  for (const id of ["navy", "green", "black", "red"]) assert.equal(inkFor(paintOf(id)!.hull), INK_LIGHT, id);
  for (const id of ["orange", "yellow", "white", "grey", "sky", "sand"]) assert.equal(inkFor(paintOf(id)!.hull), INK_DARK, id);
});

test("every boat a player can have has its built paint on record", () => {
  for (const k of ["kayak", "randolph", ...Object.keys(STOCK), "shape_cat", "shape_semisub", "shape_board"]) {
    const b = BUILT[k];
    assert.ok(b, k);
    assert.ok(b.nt >= 16 && b.nd >= 8);
  }
});

// ---- the hull's picture, made here as the build makes it (blender/common.py _hull_paint) ----
const FORM: PaintForm = { wl: 0.11, kz: (s) => (s < 0.3 ? 0.16 * (1 - s / 0.3) ** 2 : 0), dz: (s) => 0.34 + 0.06 * Math.max(1 - s / 0.25, 0) ** 2 };
const W = 256;
const H = 328; // four rows to a ring
function builtPicture(b: BuiltPaint, cols: { top: number; deck: number; boot: number; bottom: number }, shadow = 1): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4);
  const M = 2 * b.nt + b.nd;
  const band = (x: number, lo: number, hi: number, w = 0.0015) => Math.min(1, Math.max(0, (x - lo) / w + 0.5)) * Math.min(1, Math.max(0, (hi - x) / w + 0.5));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = (x + 0.5) / W;
      const k = ((y + 0.5) / H) * M;
      const side = k <= b.nt || k >= b.nt + b.nd;
      const j = k <= b.nt ? k : M - k;
      let c: number[];
      if (!side) c = rgbOf(cols.deck).map((v) => v * ((x + y) % 2 ? 0.94 : 1.0)); // non-skid
      else {
        const height = FORM.kz(s) + Math.pow(j / b.nt, 1.6) * (FORM.dz(s) - FORM.kz(s));
        const wb = band(height, -1, FORM.wl - 0.004);
        const ws = band(height, FORM.wl - 0.004, FORM.wl + 0.022);
        const wt = 1 - wb - ws;
        c = [0, 1, 2].map((q) => wb * rgbOf(cols.bottom)[q] + ws * rgbOf(cols.boot)[q] + wt * rgbOf(cols.top)[q]);
      }
      // A shadow baked over the right-hand end of the picture.
      const sh = x > W * 0.75 ? shadow : 1;
      px.set([c[0] * sh, c[1] * sh, c[2] * sh, 255], 4 * (y * W + x));
    }
  return px;
}
const as = (p: PaintScheme) => ({ top: p.hull, deck: p.deck, boot: p.boot, bottom: p.bottom });
const at = (px: Uint8ClampedArray, x: number, y: number): Rgb => [px[4 * (y * W + x)], px[4 * (y * W + x) + 1], px[4 * (y * W + x) + 2]];

test("repainting the kayak's picture gives the picture the build would have made in the new colours", () => {
  const K = BUILT.kayak;
  const src = builtPicture(K, K);
  for (const p of PAINTS) {
    const got = repaintHull(src, W, H, K, p, FORM);
    const want = builtPicture(K, as(p));
    let worst = 0;
    for (let i = 0; i < got.length; i += 4) worst = Math.max(worst, Math.abs(got[i] - want[i]), Math.abs(got[i + 1] - want[i + 1]), Math.abs(got[i + 2] - want[i + 2]));
    assert.ok(worst <= 6, `${p.name}: off by ${worst}`);
  }
  // Upside down it is the same picture: the layout has the keel at both edges.
  const flip = (px: Uint8ClampedArray) => {
    const o = new Uint8ClampedArray(px.length);
    for (let y = 0; y < H; y++) o.set(px.subarray(4 * y * W, 4 * (y + 1) * W), 4 * (H - 1 - y) * W);
    return o;
  };
  const navy = paintOf("navy")!;
  assert.deepEqual(flip(repaintHull(flip(src), W, H, K, navy, FORM)), repaintHull(src, W, H, K, navy, FORM));
});

test("the picture's own shadows and non-skid pattern come through the new paint", () => {
  const K = BUILT.kayak;
  const navy = paintOf("navy")!;
  const got = repaintHull(builtPicture(K, K, 0.7), W, H, K, navy, FORM);
  const yTop = Math.round(H * 0.3); // high on the starboard topsides
  const lit = at(got, 100, yTop);
  const shaded = at(got, 220, yTop);
  assert.ok(dist(lit, rgbOf(navy.hull)) < 8, `topsides ${lit}`);
  assert.ok(Math.abs(lightness(shaded) / lightness(lit) - 0.7) < 0.08, "the shadow is still a shadow");
  const yDeck = Math.round(H * 0.5);
  const a = at(got, 100, yDeck);
  const b = at(got, 101, yDeck);
  assert.ok(dist(a, rgbOf(navy.deck)) < 30 && dist(b, rgbOf(navy.deck)) < 30 && a[0] !== b[0], "the deck keeps its pattern");
});

test("letters painted on the bows keep their shape and flip to the ink that shows", () => {
  const K = BUILT.kayak;
  const src = builtPicture(K, K);
  const y = Math.round(H * 0.3);
  for (let x = 40; x < 60; x++) src.set([...rgbOf(K.ink!), 255], 4 * (y * W + x));
  const onNavy = repaintHull(src, W, H, K, paintOf("navy")!, FORM);
  assert.ok(dist(at(onNavy, 50, y), rgbOf(INK_LIGHT)) < 6, "white letters on navy");
  assert.ok(dist(at(onNavy, 70, y), rgbOf(paintOf("navy")!.hull)) < 6);
  const onYellow = repaintHull(src, W, H, K, paintOf("yellow")!, FORM);
  assert.ok(dist(at(onYellow, 50, y), rgbOf(INK_DARK)) < 6, "dark letters on yellow");
});

test("a boat built with no bottom paint (a dinghy, a beach cat, the rower) is the hull colour all the way down", () => {
  const D = BUILT.stock_dinghy14;
  const got = repaintHull(builtPicture(D, D), W, H, D, paintOf("navy")!, FORM);
  // Row 1: the keel. Well below the waterline.
  assert.ok(dist(at(got, 128, 1), rgbOf(paintOf("navy")!.hull)) < 8, `${at(got, 128, 1)}`);
  const P = BUILT.stock_pearson31_2;
  const yacht = repaintHull(builtPicture(P, P), W, H, P, paintOf("navy")!, FORM);
  assert.ok(dist(at(yacht, 128, 1), rgbOf(paintOf("navy")!.bottom)) < 8, "a yacht has her bottom paint");
});

test("without the hull's shape (the Boatyard's other hulls) each dot takes the paint its colour is nearest", () => {
  const C = BUILT.shape_cat;
  const got = repaintHull(builtPicture(C, C), W, H, C, paintOf("green")!);
  const green = paintOf("green")!;
  assert.ok(dist(at(got, 128, 1), rgbOf(green.bottom)) < 10, "bottom");
  assert.ok(dist(at(got, 128, Math.round(H * 0.33)), rgbOf(green.hull)) < 10, "topsides");
  assert.ok(dist(at(got, 128, Math.round(H * 0.5)), rgbOf(green.deck)) < 30, "deck");
});

test("a plain part in a new colour keeps its lights and darks", () => {
  const px = new Uint8ClampedArray([242, 106, 27, 255, 121, 53, 13, 255]);
  const out = retint(px, 0xf26a1b, 0xf0eee6);
  assert.ok(dist([out[0], out[1], out[2]], rgbOf(0xf0eee6)) < 4);
  assert.ok(Math.abs(out[4] / out[0] - 0.5) < 0.03);
  assert.equal(out[7], 255);
});

test("the paint is kept beside the boat: it stays when the boat changes and leaves saved boats as they were", () => {
  const data = new Map<string, string>();
  const s: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
  assert.equal(loadPaint(s), "");
  savePaint("navy", s);
  assert.equal(loadPaint(s), "navy");
  assert.equal(data.get(PAINT_KEY), "navy");
  assert.equal(data.has(MYBOAT_KEY), false, "choosing a paint saves no boat: no boat saved is still our kayak");
  saveMyBoat({ ...RANDOLPH_AS_BUILT.revc }, s);
  assert.equal(randolphAsBuilt(loadMyBoat(s)), "revc", "an as-built Randolph design is still one");
  assert.equal(loadPaint(s), "navy", "another boat, the same paint");
  savePaint("", s);
  assert.equal(data.has(PAINT_KEY), false);
  data.set(PAINT_KEY, '<img src=x onerror="1">');
  assert.equal(loadPaint(s), "", "anything that isn't a plain id is no paint");
});

test("the picker: her own colours first, then every scheme; a swatch shows all four paints", () => {
  const c = paintChoices("stock_pearson31_2");
  assert.equal(c.length, PAINTS.length + 1);
  assert.deepEqual([c[0].id, c[0].name], ["", "Her own colours"]);
  assert.equal(c[0].colours.hull, BUILT.stock_pearson31_2.top);
  assert.deepEqual(c.slice(1).map((x) => x.id), PAINTS.map((p) => p.id));
  const svg = swatchSvg(paintOf("navy")!);
  for (const k of ["hull", "deck", "boot", "bottom"] as const) assert.ok(svg.includes(`#${paintOf("navy")![k].toString(16).padStart(6, "0")}`), k);
  assert.equal(paintChoices("nonsense")[0].colours.hull, BUILT.kayak.top);
});
