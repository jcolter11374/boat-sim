// The compass strip along the top of a sailing screen (decision L4): which way the camera looks, with
// ticks every 5 degrees, the compass points, and what's out there along it (the bow, the sun, the moon,
// the North Star). Pure layout, shared by Watch a voyage and the sailing screen; the pages draw the spans.

export interface TapeItem {
  /** CSS class: "tick", "tick big", "lbl", "lbl card", "lbl card n", "mk" or "mk up". */
  cls: string;
  text: string;
  /** Pixels from the strip's left edge. */
  x: number;
  colour?: string;
}

/** A thing to mark on the strip: its compass bearing, its words, its colour. */
export type TapeMark = [bearing: number, text: string, colour: string];

const CARD: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
/** Degrees either side of the view shown on the strip. */
export const TAPE_RANGE = 75;

/** What to draw on a strip `width` px wide when the camera looks along compass bearing `view`. */
export function tapeItems(view: number, width: number, marks: TapeMark[]): TapeItem[] {
  const px = width / (2 * TAPE_RANGE);
  const rel = (b: number) => ((((b - view + 540) % 360) + 360) % 360) - 180;
  const xOf = (b: number) => width / 2 + rel(b) * px;
  const out: TapeItem[] = [];
  for (let b = 0; b < 360; b += 5) {
    if (Math.abs(rel(b)) > TAPE_RANGE) continue;
    const x = xOf(b);
    out.push({ cls: b % 15 === 0 ? "tick big" : "tick", text: "", x });
    // A label is drawn only where it fits whole: clear of the left edge, and of "VIEW" at the right.
    if (b % 15 === 0 && x > 14 && x < width - 40) out.push({ cls: CARD[b] ? `lbl card${b === 0 ? " n" : ""}` : "lbl", text: CARD[b] ?? String(b), x });
  }
  // Marks that would touch go up a row, so "bow" and "sun" never run together.
  const shown = marks.filter(([b]) => Math.abs(rel(b)) <= TAPE_RANGE).map(([b, text, colour]) => ({ x: xOf(b), half: text.length * 3.4 + 6, text, colour }));
  shown.sort((a, c) => a.x - c.x);
  const rowEnd = [-Infinity, -Infinity];
  for (const m of shown) {
    const row = m.x - m.half >= rowEnd[0] ? 0 : m.x - m.half >= rowEnd[1] ? 1 : 0;
    rowEnd[row] = m.x + m.half;
    out.push({ cls: row ? "mk up" : "mk", text: m.text, x: m.x, colour: m.colour });
  }
  return out;
}
