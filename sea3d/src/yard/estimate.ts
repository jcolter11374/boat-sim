// A quick estimate of a build's odds, so "Your build" can answer within a
// moment of each part change instead of only after a full test (Maya / Leo,
// 11 Nov 2026). Fitted to the Boatyard grid (boatyard/index.json): every tested
// build's odds over 100 launches.
//
// How it works:
//  - A tested build is its own answer.
//  - Otherwise start from the planned build's odds (our kayak, or Randolph's
//    boat as built) and add each changed part's measured effect, taken from the
//    tested build that differs from the planned build in that part alone. Effects
//    add in log-odds (log(p / (1 - p))), so they can't push the odds past 0 or 100%.
//  - Parts that guard against the same kind of failure overlap: a second power
//    upgrade helps less once the first has fixed the battery running flat. So
//    within a group (power, drive, links home, hull) the biggest change counts in
//    full and the others at OVERLAP. Groups add up in full. OVERLAP is a GUESS fitted
//    to the four tested multi-part kayak builds (all four within 5 points; see
//    tests/estimate.test.ts).
//  - If a tested build has some of the same changes, the estimate takes its
//    measured interaction too (its odds minus what the rule above says for it),
//    in proportion to how many of this build's changes it covers.
//  - A part that no tested build measures gives no estimate: we say so, never guess.
//
// Only grid numbers go in; the page shows the result with textContent.

import { plannedDesign, sailOnly, type Catalog, type CatalogOption, type Design } from "./design";
import { gridBase, gridDistance, type GridBuild } from "./launch";

/** How much a second change in the same group counts, against the first (GUESS, fitted). */
export const OVERLAP = 0.25;
/** Which kind of failure each slot guards against. Slots not listed are their own group. */
export const GROUPS: Record<string, string> = {
  cruise: "power",
  sol: "power",
  bat: "power",
  mppt: "power",
  paint: "power", // a fouled hull is slower: more energy per mile
  rsol: "power",
  rbat: "power",
  thr: "drive",
  drive: "drive",
  rudder: "drive",
  brain: "links",
  beacon: "links",
  ais: "links",
  sat: "links",
  tracker: "links",
  material: "hull",
  shape: "hull",
  lead: "hull",
  keel: "hull",
  // The keelboats' sails (M4 wave 1): a third reef, storm sails and a cutter's staysail
  // all answer the same gale, so they overlap.
  rig: "sails",
  cloth: "sails",
  reef: "sails",
  storm: "sails",
  spare: "links",
};
/** A part that only changes the weight by this little (kg) can't move the odds measurably. */
const NEGLIGIBLE_KG = 1;

export interface Estimate {
  /** 0..1, or null when some part has no measurement. */
  p: number | null;
  /** True when this exact build was tested (p is the grid's own odds). */
  tested: boolean;
  /** The planned build's odds (our kayak, or their boat as built), for "+4 vs our kayak". */
  planned: number;
  /** The part that has no measurement, when p is null. */
  missing?: string;
}

const logit = (p: number) => {
  const q = Math.min(Math.max(p, 0.005), 0.995); // 0 or 100 of 100 launches: keep it finite
  return Math.log(q / (1 - q));
};
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

type Change = { slot: string; opt: string | number };
const key = (c: Change) => `${c.slot}=${c.opt}`;

/** The odds model for one boat's catalog and the grid's builds. */
export class OddsModel {
  private readonly cat: Catalog;
  private readonly builds: GridBuild[];
  private readonly planned: Design;
  private readonly anchor: GridBuild | null;
  private readonly effect = new Map<string, number>(); // "slot=opt" -> log-odds change
  private readonly cruise: [number, number][] = []; // [watts, log-odds change], sorted
  private readonly combos: { changes: Change[]; residual: number }[] = [];

  constructor(cat: Catalog, builds: GridBuild[]) {
    this.cat = cat;
    this.planned = plannedDesign(cat);
    const base = this.planned.base ?? "kayak";
    this.builds = builds.filter((b) => gridBase(b) === base && b.odds && b.odds.voyages > 0);
    this.anchor = this.builds.find((b) => this.same(b, this.planned)) ?? null;
    if (!this.anchor) return;
    const a = logit(this.anchor.odds!.odds);
    const multi: { changes: Change[]; l: number }[] = [];
    for (const b of this.builds) {
      if (b === this.anchor) continue;
      const ch = this.changes(this.designOf(b));
      const l = logit(b.odds!.odds);
      if (ch.length === 1) {
        if (ch[0].slot === "cruise") this.cruise.push([Number(ch[0].opt), l - a]);
        else this.effect.set(key(ch[0]), l - a);
      } else if (ch.length > 1) multi.push({ changes: ch, l });
    }
    this.cruise.push([this.planned.cruiseW, 0]);
    this.cruise.sort((x, y) => x[0] - y[0]);
    // What each tested multi-part build adds beyond the rule: its measured interaction.
    for (const m of multi) {
      const raw = this.rawLogit(m.changes);
      if (raw !== null) this.combos.push({ changes: m.changes, residual: m.l - raw });
    }
    this.combos.sort((x, y) => y.changes.length - x.changes.length);
  }

  /** The odds for a design: tested, estimated, or null p with the part that has no data. */
  odds(d: Design): Estimate | null {
    if (!this.anchor) return null;
    const planned = this.anchor.odds!.odds;
    const tested = this.builds.find((b) => this.same(b, d));
    if (tested) return { p: tested.odds!.odds, tested: true, planned };
    const ch = this.changes(d);
    const raw = this.rawLogit(ch);
    if (raw === null) return { p: null, tested: false, planned, missing: this.missingName(ch) };
    // The biggest tested build whose changes are all in this design: take its interaction.
    const have = new Set(ch.map(key));
    const sub = this.combos.find((c) => c.changes.every((x) => have.has(key(x))));
    // Scaled by how much of this build it covers: its interaction is among its own parts.
    const fix = sub ? (sub.residual * sub.changes.length) / ch.length : 0;
    return { p: sigmoid(raw + fix), tested: false, planned };
  }

  private same(b: GridBuild, d: Design): boolean {
    const [s, w] = gridDistance(b, this.cat, d);
    return s === 0 && w === 0;
  }

  /** A grid build as a Design on this catalog. */
  private designOf(b: GridBuild): Design {
    const d: Design = { ...this.planned, picks: { ...this.planned.picks } };
    for (const s of this.cat.slots) {
      const v = b.options[s.id];
      if (typeof v === "string" && s.opts.some((o) => o.id === v)) d.picks[s.id] = v;
    }
    d.cruiseW = Number(b.options.cruise_w ?? this.planned.cruiseW);
    return d;
  }

  /** What the simulator sails in a slot: a part it doesn't model, or one that only
   *  moves the weight by under NEGLIGIBLE_KG, sails as the planned part. */
  private sails(slot: string, opt: string): string {
    const s = this.cat.slots.find((x) => x.id === slot);
    const def = this.planned.picks[slot];
    const o: CatalogOption | undefined = s?.opts.find((x) => x.id === opt);
    if (!o || (o.effect ?? "wired") !== "wired") return def;
    const keys = o.simKeys;
    if (keys && keys.every((k) => k === "hull.mass_kg") && Math.abs(o.kg ?? 0) < NEGLIGIBLE_KG) return def;
    return opt;
  }

  /** The changes from the planned build that the simulator sails differently. */
  private changes(d: Design): Change[] {
    const out: Change[] = [];
    const sail = sailOnly(d);
    for (const s of this.cat.slots) {
      if (sail && s.id === "thr") continue; // no motors on a sail-only build
      const want = this.sails(s.id, d.picks[s.id] ?? this.planned.picks[s.id]);
      if (want !== this.planned.picks[s.id]) out.push({ slot: s.id, opt: want });
    }
    // Cruise power: only our kayak's motors use it, and not with the wing sail only.
    if ((d.base ?? "kayak") === "kayak" && !sail && d.cruiseW !== this.planned.cruiseW) out.push({ slot: "cruise", opt: d.cruiseW });
    return out;
  }

  /** The rule's log-odds for these changes (no interaction), or null if a part has no measurement. */
  private rawLogit(ch: Change[]): number | null {
    const groups = new Map<string, number[]>();
    for (const c of ch) {
      const e = c.slot === "cruise" ? this.cruiseEffect(Number(c.opt)) : this.effect.get(key(c));
      if (e === undefined || e === null) return null;
      const g = GROUPS[c.slot] ?? c.slot;
      groups.set(g, [...(groups.get(g) ?? []), e]);
    }
    let total = logit(this.anchor!.odds!.odds);
    for (const es of groups.values()) {
      for (const xs of [es.filter((e) => e < 0).sort((a, b) => a - b), es.filter((e) => e > 0).sort((a, b) => b - a)])
        if (xs.length) total += xs[0] + OVERLAP * xs.slice(1).reduce((a, b) => a + b, 0);
    }
    return total;
  }

  /** Cruise power's effect, straight-line between the tested powers; null outside them. */
  private cruiseEffect(w: number): number | null {
    const c = this.cruise;
    if (c.length < 2 || w < c[0][0] || w > c[c.length - 1][0]) return null;
    for (let i = 0; i < c.length - 1; i++) {
      const [w0, e0] = c[i];
      const [w1, e1] = c[i + 1];
      if (w >= w0 && w <= w1) return w1 === w0 ? e0 : e0 + ((e1 - e0) * (w - w0)) / (w1 - w0);
    }
    return null;
  }

  private missingName(ch: Change[]): string {
    for (const c of ch) {
      if (c.slot === "cruise" ? this.cruiseEffect(Number(c.opt)) !== null : this.effect.has(key(c))) continue;
      if (c.slot === "cruise") return `${c.opt} W cruising power`;
      const s = this.cat.slots.find((x) => x.id === c.slot);
      return s?.opts.find((o) => o.id === c.opt)?.n ?? String(c.opt);
    }
    return "";
  }
}
