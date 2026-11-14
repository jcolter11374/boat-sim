/**
 * The paint picker (Hana, 14 Nov 2026): small hull-profile swatches with the name under
 * each, used in the Boatyard and in the "Your boat" picker. A click paints the player's
 * boat at once, everywhere she is drawn. Looks only, and the picker says so. Everything
 * is free and open: no locks, no prices.
 */
import { BUILT, PAINTS, PAINT_NOTE, type PaintScheme } from "../boats/paint";
import { loadPaint, savePaint } from "../myboat";

const CSS = `
.paintpick { margin-top: 10px; }
.paintpick .ph { font-size: 11px; letter-spacing: .6px; text-transform: uppercase; color: #9fb3c8; margin: 0 0 5px; }
.paintpick .sw { display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 4px; }
/* !important: the pages' own panel rules for buttons (#sum button and the like) would win otherwise. */
.paintpick .sw button { display: block; margin: 0; padding: 5px 2px 4px !important; border-radius: 9px; border: 1px solid rgba(160,200,255,.18) !important; background: rgba(20,36,58,.5) !important; color: #e9f1fb; cursor: pointer; font: 500 10.5px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif !important; text-align: center; }
.paintpick .sw button:hover { border-color: #8ab4ff !important; }
.paintpick .sw button[aria-pressed="true"] { border-color: #ff8a2a !important; background: rgba(255,138,42,.2) !important; box-shadow: inset 0 0 0 1px #ff8a2a; }
.paintpick svg { display: block; margin: 0 auto 3px; }
.paintpick .note { color: #9fb3c8; font-size: 12px; margin: 6px 0 0; }
`;

const hex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** A hull seen from the side: deck, topsides, boot stripe, bottom. */
export function swatchSvg(c: { hull: number; deck: number; boot: number; bottom: number }): string {
  // The outline: bow to the right, a little sheer, the bottom rising to the bow and stern.
  const body = "M2 5 L54 4 Q52 12 44 18 L10 18 Q4 14 2 5 Z";
  return `<svg width="50" height="18" viewBox="0 0 56 20" aria-hidden="true"><defs><clipPath id="pp-c"><path d="${body}"/></clipPath></defs>
<g clip-path="url(#pp-c)"><rect x="0" y="0" width="56" height="20" fill="${hex(c.hull)}"/><rect x="0" y="12.2" width="56" height="1.8" fill="${hex(c.boot)}"/><rect x="0" y="14" width="56" height="6" fill="${hex(c.bottom)}"/><rect x="0" y="0" width="56" height="5.6" fill="${hex(c.deck)}"/></g>
<path d="${body}" fill="none" stroke="rgba(0,0,0,.45)" stroke-width=".8"/></svg>`;
}

/** The picker's choices for a boat: her own colours first, then every scheme. built: her key in paint.ts BUILT. */
export function paintChoices(built: string): { id: string; name: string; colours: { hull: number; deck: number; boot: number; bottom: number } }[] {
  const b = BUILT[built] ?? BUILT.kayak;
  const own = { id: "", name: "Her own colours", colours: { hull: b.top, deck: b.deck, boot: b.boot, bottom: b.bottom } };
  // A scheme in her own hull colour would be the same boat twice (Elena: our kayak is already safety orange).
  return [own, ...PAINTS.filter((p) => p.hull !== b.top).map((p: PaintScheme) => ({ id: p.id, name: p.name, colours: p }))];
}

let styled = false;
/** Build a picker for the player's boat. built: her key in paint.ts BUILT (for the "own colours" swatch). */
export function paintPicker(built: string, doc: Document = document): HTMLElement {
  if (!styled) {
    styled = true;
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  const box = doc.createElement("div");
  box.className = "paintpick";
  box.append(Object.assign(doc.createElement("div"), { className: "ph", textContent: "Paint" }));
  const sw = doc.createElement("div");
  sw.className = "sw";
  sw.setAttribute("role", "group");
  sw.setAttribute("aria-label", "Paint");
  const now = loadPaint();
  for (const c of paintChoices(built)) {
    const b = doc.createElement("button");
    b.type = "button";
    b.dataset.paint = c.id;
    b.setAttribute("aria-pressed", String(c.id === now));
    b.innerHTML = swatchSvg(c.colours); // our own fixed markup, no player text
    b.append(c.name);
    b.addEventListener("click", () => {
      savePaint(c.id);
      sw.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    });
    sw.append(b);
  }
  box.append(sw, Object.assign(doc.createElement("p"), { className: "note", textContent: PAINT_NOTE }));
  return box;
}
