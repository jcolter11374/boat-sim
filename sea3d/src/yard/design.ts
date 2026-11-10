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
  [k: string]: unknown;
}
export interface CatalogSlot {
  id: string;
  name: string;
  buy?: number;
  opts: CatalogOption[];
}
export interface Catalog {
  note: string;
  base: { label: string; cost: number; kg: number };
  program: [string, number, string][];
  slots: CatalogSlot[];
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
  let kg = PLANNED_KG + cat.base.kg;
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
  const num = (slot: string, key: string, dflt: number) => {
    const v = pick(slot)?.[key];
    return typeof v === "number" ? v : dflt;
  };
  return {
    partsCost: cost,
    programCost: cat.program.reduce((a, p) => a + p[1], 0),
    massKg: kg,
    thrusters: num("thr", "thr", 2),
    solarW: num("sol", "wp", 250),
    batteryWh: num("bat", "bat", 1280),
    electronicsWhDay: wh,
    boxes: num("brain", "boxes", 2),
    beacon: num("beacon", "beacon", 1) > 0,
    ais: num("ais", "ais", 1) > 0,
    antifouling: num("paint", "af", 1) > 0,
    cruiseW: d.cruiseW,
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
export function hintsFor(from: CatalogOption | undefined, to: CatalogOption): string[] {
  if (!from || from.id === to.id) return [];
  const out: string[] = [];
  const dkg = to.kg - (from.kg ?? 0);
  if (Math.abs(dkg) >= 0.3) {
    const mm = Math.round(Math.abs(dkg) * MM_PER_KG);
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
    "base: v4 kayak",
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
