// The Boatyard's design: one option per slot from the parts catalog
// (public/parts-catalog.json, kept by the parts-plan thread; slot and option
// ids are stable), plus the cruise power setting. Everything here is plain
// data and arithmetic, so it can be tested without a browser.

export interface CatalogOption {
  id: string;
  n: string; // name
  d: string; // what it means
  cost: number; // USD
  kg: number; // weight change vs the planned build
  url?: string;
  def?: number; // 1 = the planned build
  est?: number; // 1 = an estimate, not a quoted or measured figure
  wh?: number; // electronics use, Wh per day
  wp?: number; // solar watts
  bat?: number; // battery Wh
  banks?: number;
  thr?: number; // thrusters
  boxes?: number; // electronics boxes
  beacon?: number;
  ais?: number;
  af?: number; // antifouling
  /** From the simulator: what the option does there ("wired", "no effect yet", "fixed") and why. */
  effect?: string;
  basis?: string;
  simEst?: boolean;
  /** No price or weight yet (the simulator's new slots: drive, hull material, hull shape). */
  priceTbd?: boolean;
  [k: string]: unknown;
}
/** The simulator's side of each option (Theo's sim-slots.json, from boatsim.sandbox.catalog.slot_table()). */
export interface SimOption {
  id: string;
  n?: string;
  effect: "wired" | "no effect yet" | "fixed" | string;
  est: boolean;
  basis: string;
  sim?: string[];
}
export interface SimSlots {
  note: string;
  catalog_slots: { id: string; name?: string; opts: SimOption[] }[];
  new_slots: { id: string; name: string; opts: SimOption[] }[];
  /** Other boats to start from (Theo): their own slots, as-built picks, and the kayak slots they share. */
  bases?: Record<string, SimBase>;
}
export interface SimBase {
  design: string; // the simulator config, e.g. configs/randolph_rev_c.yaml
  defaults: Record<string, string>;
  shared_slots: string[];
  slots: { id: string; name: string; opts: SimOption[] }[];
}

export interface CatalogSlot {
  id: string;
  name: string;
  buy?: number;
  opts: CatalogOption[];
}
export interface Catalog {
  note: string;
  /** cost: the parts not in any slot; kg: added to plannedKg (a change from the planned build). */
  base: { label: string; cost: number; kg: number };
  /** Which boat this is built on: "kayak" (default), "revc", "revb". */
  key?: string;
  /** The as-built weight, kg (the kayak's PLANNED_KG when absent). */
  plannedKg?: number;
  /** Fixed numbers for things this boat has no slot for (e.g. thr: 0 on a sail boat). */
  fixed?: Record<string, number>;
  /** How far the boat sinks per kg added, mm (MM_PER_KG for the kayak). */
  mmPerKg?: number;
  /** Where the parts and prices come from, shown under the slots. */
  credit?: { text: string; url: string };
  program: [string, number, string][];
  slots: CatalogSlot[];
}

/** Plain names for the simulator's own options, when its slot table gives only ids. */
const OPTION_NAMES: Record<string, string> = {
  "solar-electric": "Solar-electric (as built)",
  "wing-sail": "Wing sail only",
  hybrid: "Wing sail + motors",
  polyethylene: "Polyethylene (rotomoulded, as built)",
  fibreglass: "Fibreglass",
  carbon: "Carbon fibre",
  "plywood-epoxy": "Plywood and epoxy",
  aluminium: "Aluminium",
  kayak: "10 ft kayak (as built)",
  cat: "Small catamaran, 3.0 x 1.6 m",
  semisub: "Low semi-submerged hull, 3.2 x 0.5 m",
  board: "Surfboard, 3.0 x 0.85 m",
};

/** True when the motors and cruise power don't apply: a wing sail with no motors (ours, or the Randolph boat as built). */
export const sailOnly = (d: Design): boolean => d.picks.drive === "wing-sail" || d.picks.drive === "wing";

/**
 * The catalog with the simulator's notes merged in by slot and option id, and
 * the simulator's new slots (drive, hull material, hull shape) added at the end.
 * Options with no effect in the simulator yet stay in, marked (Maya's call).
 */
export function withSim(cat: Catalog, sim: SimSlots | null): Catalog {
  if (!sim) return cat;
  const by = new Map(sim.catalog_slots.map((s) => [s.id, new Map(s.opts.map((o) => [o.id, o]))]));
  const slots: CatalogSlot[] = cat.slots.map((s) => ({
    ...s,
    opts: s.opts.map((o) => {
      const so = by.get(s.id)?.get(o.id);
      return so ? { ...o, effect: so.effect, basis: so.basis, simEst: so.est } : o;
    }),
  }));
  // The simulator's slots the parts catalog doesn't have yet (drive, hull material, hull shape) go at the end.
  for (const ns of [...sim.catalog_slots, ...sim.new_slots] as { id: string; name?: string; opts: SimOption[] }[]) {
    if (slots.some((s) => s.id === ns.id)) continue;
    slots.push({
      id: ns.id,
      name: ns.name ?? ns.id,
      opts: ns.opts.map((o, i) => ({
        id: o.id,
        n: o.n ?? OPTION_NAMES[o.id] ?? o.id,
        d: o.basis,
        cost: 0,
        kg: 0,
        def: i === 0 ? 1 : undefined, // the first is the kayak as built
        est: o.est ? 1 : undefined,
        effect: o.effect,
        basis: o.basis,
        simEst: o.est,
        priceTbd: i !== 0,
      })),
    });
  }
  return { ...cat, slots };
}

/** The design as the simulator takes it: slot id -> option id, plus cruise_w (Theo's run_voyage). */
/** The design for the simulator: each pick, or with `base` only the picks that differ from it
 * (the simulator's defaults are the planned build), plus the cruise power. */
export function simChoices(d: Design, base?: Design | null): Record<string, string | number> {
  const picks = Object.entries(d.picks).filter(([s, o]) => !base || base.picks[s] !== o);
  return { ...Object.fromEntries(picks), cruise_w: d.cruiseW };
}

/** Choice per slot id (option id), and the cruise power in watts. */
export interface Design {
  picks: Record<string, string>;
  cruiseW: number;
}

export const PLANNED_KG = 123; // the planned build's weight (catalog kg are changes from it)
export const CRUISE_W = [10, 15, 20, 25, 30];
export const DEFAULT_CRUISE_W = 25;

/** The planned build: each slot's def option (else its first). */
export function plannedDesign(cat: Catalog): Design {
  const picks: Record<string, string> = {};
  for (const s of cat.slots) picks[s.id] = (s.opts.find((o) => o.def) ?? s.opts[0]).id;
  return { picks, cruiseW: DEFAULT_CRUISE_W };
}

export function optionOf(cat: Catalog, slot: string, d: Design): CatalogOption | undefined {
  const s = cat.slots.find((x) => x.id === slot);
  return s?.opts.find((o) => o.id === d.picks[slot]) ?? s?.opts[0];
}

/** The numbers that matter, totalled over the design. */
export interface Summary {
  partsCost: number; // the boat: base + every chosen part
  programCost: number; // licences, airtime, trials
  massKg: number;
  thrusters: number;
  solarW: number;
  batteryWh: number;
  electronicsWhDay: number;
  boxes: number;
  beacon: boolean;
  ais: boolean;
  antifouling: boolean;
  cruiseW: number;
  estimates: string[]; // slot names whose choice is an estimate
}

export function summarise(cat: Catalog, d: Design): Summary {
  let cost = cat.base.cost;
  let kg = (cat.plannedKg ?? PLANNED_KG) + cat.base.kg;
  const pick = (slot: string) => optionOf(cat, slot, d);
  const estimates: string[] = [];
  let wh = 0;
  for (const s of cat.slots) {
    const o = pick(s.id);
    if (!o) continue;
    cost += o.cost;
    kg += o.kg;
    wh += o.wh ?? 0;
    if (o.est) estimates.push(s.name);
  }
  // The first of these slots that the boat has and that gives the figure (the kayak's
  // slots first, then the Randolph boat's: rsol, rbat, tracker, drive).
  const num = (slots: string | string[], key: string, dflt: number) => {
    for (const slot of typeof slots === "string" ? [slots] : slots) {
      const v = pick(slot)?.[key];
      if (typeof v === "number") return v;
    }
    return cat.fixed?.[key] ?? dflt;
  };
  return {
    partsCost: cost,
    programCost: cat.program.reduce((a, p) => a + p[1], 0),
    massKg: kg,
    thrusters: num(["thr", "drive"], "thr", 2),
    solarW: num(["sol", "rsol"], "wp", 250),
    batteryWh: num(["bat", "rbat"], "bat", 1280),
    electronicsWhDay: wh,
    boxes: num("brain", "boxes", 2),
    beacon: num(["beacon", "tracker"], "beacon", 1) > 0,
    ais: num("ais", "ais", 1) > 0,
    antifouling: num("paint", "af", 1) > 0,
    cruiseW: sailOnly(d) ? 0 : d.cruiseW,
    estimates,
  };
}

// ---------- plain-English hints ----------
/** Rough sink per kg: the kayak's waterplane is about 1.45 m² (3.05 m × 0.79 m × 0.6), in sea water. */
export const MM_PER_KG = 1000 / (1025 * 1.45);
/** Usable share of the battery (the controller stops before it's flat). GUESS. */
const USABLE = 0.8;

/**
 * Hours the battery runs the motors and electronics with no sun, at the chosen cruise power.
 * Rough: ignores the night light and any charge left from the day.
 */
export function nightHours(s: Summary): number {
  const draw = s.cruiseW + s.electronicsWhDay / 24;
  return (s.batteryWh * USABLE) / draw;
}

/** What changes if you swap `from` for `to` in this slot, in plain words. */
export function hintsFor(from: CatalogOption | undefined, to: CatalogOption, mmPerKg = MM_PER_KG): string[] {
  if (!from || from.id === to.id) return [];
  const out: string[] = [];
  const dkg = to.kg - (from.kg ?? 0);
  if (Math.abs(dkg) >= 0.3) {
    const mm = Math.round(Math.abs(dkg) * mmPerKg);
    const kg = `${Math.abs(dkg).toFixed(1)} kg ${dkg > 0 ? "heavier" : "lighter"}`;
    out.push(mm >= 1 ? `${kg}: sits ${mm} mm ${dkg > 0 ? "lower" : "higher"} in the water` : kg);
  }
  const dc = to.cost - from.cost;
  if (Math.abs(dc) >= 1) out.push(dc > 0 ? `$${Math.round(dc)} more` : `saves $${Math.round(-dc)}`);
  if (to.wp != null && from.wp != null && to.wp !== from.wp)
    out.push(to.wp > from.wp ? "more solar: more charge on cloudy days" : "less solar: slower charging, slower on cloudy days");
  if (to.bat != null && from.bat != null && to.bat !== from.bat)
    out.push(to.bat > from.bat ? "bigger battery: keeps going longer at night" : "smaller battery: less power at night");
  if (to.wh != null && from.wh != null && to.wh !== from.wh)
    out.push(to.wh > from.wh ? `uses ${to.wh - from.wh} Wh more a day` : `saves ${from.wh - to.wh} Wh a day`);
  if (to.thr != null && from.thr != null && to.thr < from.thr) out.push("no spare motor: one failure and it steers with the rudder only");
  if (to.boxes != null && from.boxes != null && to.boxes < from.boxes) out.push("no backup computer: if it dies, the boat drifts");
  if (to.beacon === 0) out.push("no backup tracker: if the radio goes quiet, nobody knows where it is");
  if (to.ais === 0) out.push("ships can't see it on their screens");
  if (to.af === 0) out.push("weed and barnacles slow it down over the weeks");
  if (to.est) out.push("figure is an estimate");
  if (to.effect === "no effect yet") out.push("the simulator doesn't model this yet: a launch sails it as built");
  if (to.priceTbd) out.push("price and weight not worked out yet");
  return out;
}

// ---------- share links ----------
/** "#thr=one-t200&sol=solar-300&w=20": only what differs from the planned build. */
export function encodeDesign(cat: Catalog, d: Design): string {
  const base = plannedDesign(cat);
  const parts: string[] = [];
  for (const s of cat.slots) if (d.picks[s.id] !== base.picks[s.id]) parts.push(`${s.id}=${encodeURIComponent(d.picks[s.id])}`);
  if (d.cruiseW !== base.cruiseW) parts.push(`w=${d.cruiseW}`);
  return parts.length ? `#${parts.join("&")}` : "";
}

/** Read a share link; unknown slots or options fall back to the planned build. */
export function decodeDesign(cat: Catalog, hash: string): Design {
  const d = plannedDesign(cat);
  const q = new URLSearchParams(hash.replace(/^#/, ""));
  for (const s of cat.slots) {
    const v = q.get(s.id);
    if (v && s.opts.some((o) => o.id === v)) d.picks[s.id] = v;
  }
  const w = Number(q.get("w"));
  if (CRUISE_W.includes(w)) d.cruiseW = w;
  return d;
}

// ---------- design file for the simulator ----------
const yamlStr = (s: string) => JSON.stringify(s); // a JSON string is a valid YAML string

/**
 * A YAML file describing the design: the catalog picks (slot id: option id)
 * that the simulator maps onto its configuration, plus the totals, for anyone
 * (the Randolph team included) to run or read.
 */
export function designYaml(cat: Catalog, d: Design, name = "my boatyard design"): string {
  const s = summarise(cat, d);
  const lines = [
    "# Boatyard design (boat-sim). The simulator reads `picks` and `cruise_w`;",
    "# the rest is a summary for people. Slot and option ids are from sea3d/public/parts-catalog.json.",
    `name: ${yamlStr(name)}`,
    `base: ${yamlStr(cat.base.label)}`,
    `cruise_w: ${d.cruiseW}`,
    "picks:",
    ...cat.slots.map((sl) => `  ${sl.id}: ${d.picks[sl.id]}`),
    "summary:",
    `  parts_cost_usd: ${Math.round(s.partsCost)}`,
    `  program_cost_usd: ${Math.round(s.programCost)}`,
    `  mass_kg: ${s.massKg.toFixed(1)}`,
    `  thrusters: ${s.thrusters}`,
    `  solar_w: ${s.solarW}`,
    `  battery_wh: ${s.batteryWh}`,
    `  electronics_wh_per_day: ${s.electronicsWhDay}`,
    `  electronics_boxes: ${s.boxes}`,
    `  backup_beacon: ${s.beacon}`,
    `  ais: ${s.ais}`,
    `  antifouling: ${s.antifouling}`,
    `  estimates: [${s.estimates.map(yamlStr).join(", ")}]`,
  ];
  return lines.join("\n") + "\n";
}
