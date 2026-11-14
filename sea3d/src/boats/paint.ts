/**
 * Paint jobs (Hana, 14 Nov 2026; John: "maybe different paint jobs too?").
 *
 * A scheme is four real marine paints: the hull above the water (the topsides), the deck,
 * the boot stripe (the thin band at the waterline) and the bottom paint below it. Paint is
 * looks only: nothing here reaches the simulator. Elena's bar: plain real colours, no neon,
 * metallic or patterns; decks off-white, grey or sand; every hull must read against the sea.
 *
 * The detailed boat models carry their paint as one picture laid out along and around the
 * hull (blender/common.py _hull_paint). repaintHull() works out, for each dot of that
 * picture, which paint it is (from the hull's own shape, as the build did) and gives it the
 * scheme's colour, keeping the picture's own lights and darks: the shadows under the deck
 * kit, the non-skid pattern, the registration letters. No new models, no new files.
 *
 * This file is plain numbers (tested without graphics); paintApply.ts puts it on a model.
 */

export interface PaintScheme {
  id: string;
  /** The name under the swatch, in plain words. */
  name: string;
  /** Colours as 0xRRGGBB, as they'd be read off a paint chart. */
  hull: number;
  deck: number;
  boot: number;
  bottom: number;
}

/** The schemes, in the picker's order. All free, all open from the start. */
export const PAINTS: PaintScheme[] = [
  { id: "orange", name: "Safety orange", hull: 0xf26a1b, deck: 0xe8e5dc, boot: 0xf4f4ee, bottom: 0x2f383f },
  { id: "yellow", name: "Signal yellow", hull: 0xf2c21b, deck: 0xe8e5dc, boot: 0x1b2430, bottom: 0x1f3a5f },
  { id: "white", name: "Classic white", hull: 0xf4f3ef, deck: 0xe6e2d6, boot: 0xb3261e, bottom: 0x1d2f4d },
  { id: "grey", name: "Pale grey", hull: 0xc9ced3, deck: 0xe8e5dc, boot: 0x1b2430, bottom: 0x7a1f1f },
  { id: "navy", name: "Navy", hull: 0x1f3769, deck: 0xf0eee6, boot: 0xf4f4ee, bottom: 0x7a1f1f },
  { id: "green", name: "Racing green", hull: 0x0f4d32, deck: 0xe6e2d6, boot: 0xf0e6c8, bottom: 0x7a1f1f },
  { id: "red", name: "Deep red", hull: 0x9e1b1b, deck: 0xe8e5dc, boot: 0xf4f4ee, bottom: 0x1b1d21 },
  { id: "black", name: "Black", hull: 0x1b1d21, deck: 0xc9ced3, boot: 0xf4f4ee, bottom: 0x7a1f1f },
  { id: "sky", name: "Sky blue", hull: 0x7fb6de, deck: 0xf0eee6, boot: 0xf4f4ee, bottom: 0x1d2f4d },
  { id: "sand", name: "Sand", hull: 0xd9c39a, deck: 0xf0eee6, boot: 0x5a3a22, bottom: 0x1f3a5f },
];

/** The scheme with this id, or null: "" and anything unknown mean the boat keeps her own colours. */
export function paintOf(id: string | null | undefined): PaintScheme | null {
  return PAINTS.find((p) => p.id === id) ?? null;
}

/** What the picker says under its swatches. */
export const PAINT_NOTE = "Paint is looks only: it changes nothing about how she sails.";

export type Rgb = [number, number, number];
export const rgbOf = (hex: number): Rgb => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
/** How light a colour looks, 0..1 (on the screen's own scale; good enough for "dark or light hull"). */
export const lightness = (c: Rgb) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;

/** Registration letters: dark on a light hull, white on a dark one (Elena). */
export const INK_DARK = 0x0d1116;
export const INK_LIGHT = 0xf4f4ee;
export const inkFor = (hull: number) => (lightness(rgbOf(hull)) < 0.3 ? INK_LIGHT : INK_DARK);

/** The paint a model was built with (blender/build_*.py), and how its picture is laid out. */
export interface BuiltPaint {
  top: number;
  deck: number;
  boot: number;
  bottom: number;
  /** Rings up each side and across the deck in the picture (hull(nt, nd) in the build). */
  nt: number;
  nd: number;
  /** The ink of letters painted on the bows, when the model has them. */
  ink?: number;
}

/** Keep in step with the PAINT lines of blender/build_kayak.py, build_randolph.py, build_stock.py, build_shapes.py. */
export const BUILT: Record<string, BuiltPaint> = {
  kayak: { top: 0xf26a1b, deck: 0xe0601a, boot: 0xf4f4ee, bottom: 0x2f383f, nt: 32, nd: 18, ink: 0x1b2430 },
  randolph: { top: 0xf1f3f4, deck: 0xdfe5e8, boot: 0x0f8a8a, bottom: 0x2e5566, nt: 32, nd: 18 },
  stock_cruiser31: { top: 0xf4f3ef, deck: 0xe8e5dc, boot: 0x1d2f4d, bottom: 0x23344f, nt: 32, nd: 18 },
  stock_pearson31_2: { top: 0xf3f0e6, deck: 0xe9e5da, boot: 0x1a2a4a, bottom: 0x2b3a55, nt: 32, nd: 18 },
  stock_dinghy14: { top: 0xf5f4ef, deck: 0xf0efea, boot: 0x2c6fb5, bottom: 0xedebe6, nt: 20, nd: 20 },
  stock_beachcat16: { top: 0xf4f4f0, deck: 0xecebe6, boot: 0xd8432b, bottom: 0xf0efea, nt: 26, nd: 12 },
  stock_sail_drone7: { top: 0x3a4756, deck: 0xdadde0, boot: 0xf2b33d, bottom: 0x262a2f, nt: 28, nd: 18 },
  stock_ocean_rower45: { top: 0xf4f4f1, deck: 0x8e949a, boot: 0x2f6fa8, bottom: 0xe4e6e6, nt: 28, nd: 18 },
  // The Boatyard's other hull shapes, painted as the kayak is.
  shape_cat: { top: 0xf26a1b, deck: 0xe0601a, boot: 0xf4f4ee, bottom: 0x2f383f, nt: 26, nd: 12 },
  shape_semisub: { top: 0xf26a1b, deck: 0xe0601a, boot: 0xf4f4ee, bottom: 0x2f383f, nt: 28, nd: 14 },
  shape_board: { top: 0xf26a1b, deck: 0xe0601a, boot: 0xf4f4ee, bottom: 0x2f383f, nt: 20, nd: 20 },
};

/** The part of a hull's shape the paint lines follow (boats/parts.ts HullForm has these). */
export interface PaintForm {
  wl: number;
  kz: (s: number) => number;
  dz: (s: number) => number;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
/** 1 between lo and hi, with soft edges w wide (blender/common.py band()). */
const band = (x: number, lo: number, hi: number, w = 0.0015) => clamp01((x - lo) / w + 0.5) * clamp01((hi - x) / w + 0.5);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const lumOf = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Repaint a hull's picture. px: w x h dots, four bytes each (red, green, blue, alpha), rows
 * in either order (the layout is the same upside down). With the hull's form the paint
 * lines are placed exactly as the build placed them; without it (the Boatyard's other hull
 * shapes) each dot on the sides takes the paint its own colour is nearest to.
 * A boat whose bottom was built the colour of her topsides (a dinghy, a beach cat, the
 * rower: no bottom paint) keeps the hull colour all the way down.
 */
export function repaintHull(px: Uint8ClampedArray, w: number, h: number, built: BuiltPaint, to: PaintScheme, form?: PaintForm): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length);
  const M = 2 * built.nt + built.nd;
  const oTop = rgbOf(built.top);
  const oBoot = rgbOf(built.boot);
  const oBottom = rgbOf(built.bottom);
  const oDeck = rgbOf(built.deck);
  const nTop = rgbOf(to.hull);
  const nBoot = rgbOf(to.boot);
  const nDeck = rgbOf(to.deck);
  // No bottom paint on the boat as built: none now.
  const bare = Math.hypot(oTop[0] - oBottom[0], oTop[1] - oBottom[1], oTop[2] - oBottom[2]) < 30;
  const nBottom = bare ? nTop : rgbOf(to.bottom);
  const oInk = built.ink === undefined ? null : rgbOf(built.ink);
  const nInk = rgbOf(inkFor(to.hull));
  // Dark letters on a light hull thin out to grey when the boat is small on screen (white on dark doesn't):
  // they get a bolder stroke, two dots wider all round.
  const bolder = oInk !== null && form !== undefined && lightness(nInk) < 0.3;
  const mask = bolder ? new Float32Array(w * h) : null;
  const topL = Math.max(lumOf(oTop[0], oTop[1], oTop[2]), 1);
  const oDeckL = lumOf(oDeck[0], oDeck[1], oDeck[2]);
  // Along the hull the lines only depend on the column: work the keel and deck heights out once.
  const kz = new Float32Array(w);
  const dz = new Float32Array(w);
  if (form)
    for (let x = 0; x < w; x++) {
      const s = (x + 0.5) / w;
      kz[x] = form.kz(s);
      dz[x] = form.dz(s);
    }
  const near = (r: number, g: number, b: number, c: Rgb) => Math.exp(-((r - c[0]) ** 2 + (g - c[1]) ** 2 + (b - c[2]) ** 2) / (2 * 40 * 40));
  for (let y = 0; y < h; y++) {
    const k = ((y + 0.5) / h) * M;
    const side = k <= built.nt || k >= built.nt + built.nd;
    const j = k <= built.nt ? k : M - k;
    const t = side ? Math.pow(j / built.nt, 1.6) : 1;
    for (let x = 0; x < w; x++) {
      const i = 4 * (y * w + x);
      const r = px[i];
      const g = px[i + 1];
      const b = px[i + 2];
      out[i + 3] = px[i + 3];
      const l = lumOf(r, g, b);
      if (!side) {
        // The deck: the new deck colour with the picture's own shadows and non-skid pattern.
        const shade = Math.min(1.15, l / oDeckL);
        out[i] = nDeck[0] * shade;
        out[i + 1] = nDeck[1] * shade;
        out[i + 2] = nDeck[2] * shade;
        continue;
      }
      let wb: number;
      let ws: number;
      let wt: number;
      if (form) {
        const height = kz[x] + t * (dz[x] - kz[x]);
        wb = band(height, -1, form.wl - 0.004);
        ws = band(height, form.wl - 0.004, form.wl + 0.022);
        wt = Math.max(0, 1 - wb - ws);
      } else {
        wb = near(r, g, b, oBottom);
        ws = near(r, g, b, oBoot);
        wt = near(r, g, b, oTop);
        const sum = wb + ws + wt || 1;
        wb /= sum;
        ws /= sum;
        wt /= sum;
      }
      // Letters on the topsides: how far this dot is from the hull colour towards the ink.
      let ink = 0;
      if (oInk && form && wt > 0.5) {
        // The letters are stamped on the hull as a much darker hull colour, darker than any shadow baked on the
        // topsides: how dark this dot is against the hull's own colour says how much of it is ink.
        ink = 1 - smooth(0.3, 0.6, l / topL);
        if (mask && ink > 0) mask[y * w + x] = ink;
      }
      const oL = wb * lumOf(oBottom[0], oBottom[1], oBottom[2]) + ws * lumOf(oBoot[0], oBoot[1], oBoot[2]) + wt * lumOf(oTop[0], oTop[1], oTop[2]);
      // The picture's own light and dark (shadows baked under the kit, the blotchy bottom paint).
      const shade = ink > 0 ? 1 : Math.max(0.35, Math.min(1.2, l / Math.max(oL, 1)));
      for (let c = 0; c < 3; c++) {
        const paint = (wb * nBottom[c] + ws * nBoot[c] + wt * nTop[c]) * shade;
        out[i + c] = paint + (nInk[c] - paint) * ink;
      }
    }
  }
  if (mask) {
    const R = 2;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const own = mask[y * w + x];
        if (own >= 1) continue;
        let m = own;
        for (let dy = -R; dy <= R && m < 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -R; dx <= R; dx++) {
            const v = mask[yy * w + ((x + dx + w) % w)];
            if (v > m) m = v;
          }
        }
        if (m <= own) continue;
        const k = (m - own) / (1 - own);
        const i = 4 * (y * w + x);
        for (let c = 0; c < 3; c++) out[i + c] += (nInk[c] - out[i + c]) * k;
      }
  }
  return out;
}

/** A plain-coloured picture (the kayak's foam dome) in a new colour, keeping its lights and darks. */
export function retint(px: Uint8ClampedArray, from: number, to: number): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length);
  const f = rgbOf(from);
  const n = rgbOf(to);
  const fl = lumOf(f[0], f[1], f[2]);
  for (let i = 0; i < px.length; i += 4) {
    const shade = Math.min(1.2, lumOf(px[i], px[i + 1], px[i + 2]) / fl);
    out[i] = n[0] * shade;
    out[i + 1] = n[1] * shade;
    out[i + 2] = n[2] * shade;
    out[i + 3] = px[i + 3];
  }
  return out;
}

/**
 * The plain-coloured parts that take a scheme's paint, by the material's name in the
 * models: [which paint, the colour it was built in for a retint or null to set it outright].
 * Everything else (cabin, teak, rigging, the Randolph boat's teal trim) is left alone.
 */
export const PAINTED_PARTS: Record<string, "hull" | "deck" | "boot" | "bottom"> = {
  transom: "hull",
  dome: "deck",
  cove_stripe: "boot",
  antifoul: "bottom",
};
