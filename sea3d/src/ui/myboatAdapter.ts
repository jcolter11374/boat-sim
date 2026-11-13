/**
 * "My boat" as the top bar and title screen see it: a name, and the Boatyard link
 * that reopens it. A thin seam over src/myboat.ts (the boat remembered in the
 * browser, step 1 of the one-game plan), so the menu code doesn't depend on its shape.
 */
import { loadMyBoat, myBoatYardLink, onMyBoatChange, type MyBoat } from "../myboat";

export interface BoatSummary {
  /** Shown in the bar, e.g. "Rev C, one rudder". */
  name: string;
  /** Boatyard link that reopens this design, relative to the site root. */
  href: string;
  /** A small muted note for the title card's "My boat" line, or none: what a renamed design is built on. */
  note?: string;
}

/** The Randolph team's boats as the Boatyard names them (B2: always "our model" of them). */
const RANDOLPH: Record<string, string> = { revc: "Rev C5", revb: "Rev B" };

/**
 * How "my boat" is named in the top bar's chip and on the title card (Elena, 13 Nov; B2). A design built on
 * the Randolph boat is always shown as our model: one still carrying the stock name ("Rev C", "My Rev C5")
 * reads "Rev C5 (our model)"; one the player renamed shows their name, with a note saying what it's built on.
 */
export function boatNaming(b: Pick<MyBoat, "kind" | "base" | "name"> | null): { name: string; note?: string } {
  if (!b) return { name: "Our kayak" };
  const model = b.kind === "yard" ? RANDOLPH[b.base] : undefined;
  if (!model) return { name: b.name };
  if (/our model/i.test(b.name)) return { name: b.name };
  const stock = /^(my\s+)?(randolph\s+)?rev\s*[bc]\d*$/i.test(b.name.trim());
  return stock ? { name: `${model} (our model)` } : { name: b.name, note: `based on our model of the Randolph team's ${model}` };
}

export function currentBoat(): BoatSummary | null {
  const b = loadMyBoat();
  return b ? { ...boatNaming(b), href: "./" + myBoatYardLink(b) } : null;
}

/** Calls back when my boat changes (in this tab or another). */
export function onBoatChange(cb: () => void): void {
  onMyBoatChange(() => cb());
}
