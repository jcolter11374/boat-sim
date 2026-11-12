// No money in the game (John, 12 Nov): the Boatyard shows what a part does, never
// what it costs. The catalog JSON keeps its prices (nothing else breaks); this
// decides what a player sees. Leo's words: finish-layer-copy.md, "No money in the game".
import type { CatalogOption, CatalogSlot } from "./design";

/** A choice that only ever differed in price: the simulator sails it exactly like the
 *  slot's planned part (no effect yet, or no setting and no weight changed). */
export function deadChoice(o: CatalogOption): boolean {
  if (o.def) return false;
  if (o.effect === "no effect yet") return true;
  return Array.isArray(o.simKeys) && o.simKeys.length === 0 && !o.kg;
}

/** The options a player picks from; a slot with nothing left to choose shows none. */
export function shownOptions(slot: CatalogSlot): CatalogOption[] {
  const live = slot.opts.filter((o) => !deadChoice(o));
  if (live.length <= 1 && slot.opts.every((o) => o.effect === "no effect yet")) return [];
  return live;
}

const signed = (x: number, unit: string, digits = 0) => {
  const v = Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return `${x > 0 ? "+" : "−"}${v} ${unit}`;
};

/** What a part changes against the slot's planned part, small and dim on its row:
 *  "−0.45 kg", "+50 W", "+1,280 Wh"; "~" before an estimate. "" when nothing changes. */
export function partFigure(slot: CatalogSlot, o: CatalogOption): string {
  const plan = slot.opts.find((x) => x.def) ?? slot.opts[0];
  const bits: string[] = [];
  if (o.kg) bits.push(signed(o.kg, "kg", 2));
  if (o.wp !== undefined && plan.wp !== undefined && o.wp !== plan.wp) bits.push(signed(o.wp - plan.wp, "W"));
  if (o.bat !== undefined && plan.bat !== undefined && o.bat !== plan.bat) bits.push(signed(o.bat - plan.bat, "Wh"));
  if (!bits.length) return "";
  return (o.est ? "~" : "") + bits.join(", ");
}

const MONEY = /\$|\bprices?\b|\bcosts?\b|\bcheaper\b|\bbill\b|\bUSD\b|price TBD/i;
/** Money words in on-screen text (the tests use it). */
export function moneyWords(text: string): string[] {
  const m = MONEY.exec(text);
  return m ? [m[0]] : [];
}
