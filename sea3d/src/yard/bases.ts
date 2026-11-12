// Boats to start a Boatyard design from: our v4 kayak (the parts catalog as
// it is), or our model of the Randolph team's Rev C or Rev B.
//
// The Randolph slots and which option each boat has as built come from Theo's
// sim-slots.json ("bases"). Prices, weights and power figures come from the
// parts table in their published build plan (sheltonr2/drone-boat,
// docs/Build_Plan.md, Nov 2026, MIT). The slots they share with the kayak
// (satellite modem, navigation light, antifouling, spares) use our own catalog's
// entries. Figures marked est are our GUESSES.

import type { Catalog, CatalogOption, CatalogSlot, SimSlots } from "./design";

export type BaseKey = "kayak" | "revc" | "revb";
export const BASE_KEYS: BaseKey[] = ["kayak", "revc", "revb"];
export const BASE_NAMES: Record<BaseKey, string> = {
  kayak: "Our v4 kayak",
  revc: "Randolph Rev C5 (our model)",
  revb: "Randolph Rev B (our model)",
};
/** The long name, for wherever the boat is described. */
export const BASE_LONG: Record<BaseKey, string> = {
  kayak: "our v4 kayak",
  revc: "our model of the Randolph team's Rev C5",
  revb: "our model of the Randolph team's Rev B",
};

export const RANDOLPH_CREDIT = {
  text: "Randolph boat: parts and design from the Randolph team's drone-boat (MIT licence, see THIRD_PARTY_NOTICES). Our model of it, not their own simulator.",
  url: "https://github.com/sheltonr2/drone-boat",
};

type Figures = Partial<Pick<CatalogOption, "cost" | "kg" | "wh" | "wp" | "bat" | "boxes" | "beacon" | "thr" | "est" | "url" | "d" | "more">>;

/**
 * Per option: cost (USD), kg (relative to Rev C as built), and what it adds.
 * From their Build_Plan.md parts table unless marked est.
 */
const FIGURES: Record<string, Record<string, Figures>> = {
  drive: {
    wing: { cost: 155, kg: 0, thr: 0, d: "A rigid wing with a tail flap that turns itself to the wind.",
      more: "Foam ribs and glass skin on a 30 x 22 mm carbon spar, balanced by a weight on a solid fibreglass arm. Rev C3: a stronger spar, bearings 130 mm apart. Rev C4: ball bearings that can't rust. Rev C5: shorter and wider (0.80 m tall, 0.375 m across) with the same area, so it heels the boat less." },
    // Their design.py has a 35 W thruster; no price in the build plan. GUESS: one of our T200s.
    "wing-thruster": { cost: 155 + 378.8, kg: 0.45, thr: 1, est: 1, d: "The wing plus a small motor (their 35 W thruster), used like our wing-and-motors build. Weight is our guess." },
  },
  brain: {
    // The autopilot, GPS and companion computer are in the rest of the boat; this is the sealed box.
    // wh: their 33 Wh a day, less the modem (1) and light (4) counted in those slots.
    "one-box": { cost: 40, kg: 0, wh: 28, boxes: 1, d: "Pixhawk autopilot and ESP32 in one sealed IP68 box." },
    "two-box": { cost: 40 + 83, kg: 0.4, wh: 32, boxes: 2, est: 1, d: "A second, separate safe-mode box, like ours. Our guess for their boat." },
  },
  rudder: {
    twin: {
      cost: 186,
      kg: 0,
      d: "Two spade rudders, each with its own servo: either one can steer alone.",
      more: "Rev C3: a spring servo-saver on each and stops at ±40°, so a wave can push a blade over without breaking its servo.",
    },
    single: { cost: 93, kg: -0.5, d: "One rudder and one servo, as on Rev B." },
  },
  rsol: {
    "deck-40w": { cost: 80, kg: 0, wp: 40, d: "Two 20 W semi-flexible ETFE panels on the deck." },
    "deck-60w": { cost: 120, kg: 0.4, wp: 60, est: 1, d: "About 60 W: as much as fits the narrow deck. Our estimate." },
  },
  rbat: {
    "lfp-192wh": { cost: 150, kg: 0, bat: 192, d: "Bioenno 12 V 15 Ah LiFePO4, in its own sealed box." },
    "lfp-384wh": { cost: 300, kg: 1.9, bat: 384, est: 1, d: "Two of the same packs. Our estimate." },
  },
  keel: {
    "bulb-9kg": { cost: 67, kg: 0, d: "About 9 kg of lead cast into the keel bulb (Rev C, design D72), on a hardwood-cored fin set in a keel box (Rev C2: about ten times stronger). Makes it right itself from upside down." },
    "bulb-8kg": { cost: 60, kg: -0.8, d: "8.2 kg bulb, as on Rev B." },
  },
  tracker: {
    yb3: { cost: 630, kg: 0.3, beacon: 1, d: "Yellowbrick YB3: its own battery, GPS and satellite modem, so it keeps reporting if the main box dies. Rev C3 sets it in a well in the foredeck, away from the main antenna on the stern post." },
    none: { cost: 0, kg: 0, beacon: 0, d: "No backup tracker." },
  },
};

/** Their parts not in any slot (autopilot, sensors, charge controller, bearings, glands, radar reflector, hull, wiring, lake prototype). */
const REST: Record<"revc" | "revb", { cost: number; kg: number; label: string }> = {
  // Frozen to their designs/boat-sim/randolph_rev_c.yaml as of 11 Nov 2026 20:40 UTC (Rev C5,
  // sha256 23cd0c98dc1d...; C4 changed the mast bearings and C5 the wing's shape, not the mass).
  // 177 + 37 + 18 + 20 + 10 + 35 + 104 + 93 + 55 + 78 + 38 + 350 + 55 + 85 + 100. Rev C3 (11 Nov 2026):
  // 26.9 kg all up (their randolph_rev_c.yaml; C2 fin +1.1, C3 structural changes +0.5). Their
  // build plan prices no C2/C3 parts yet, so the cost stays at Rev C's.
  revc: { cost: 1255, kg: 26.9, label: "Rest of their boat (foam-filled hull, hardwood keel fin, autopilot and sensors, charge controller, wiring)" },
  // As the first Rev C (25.2 kg) without the hull fill and battery box (55).
  revb: { cost: 1200, kg: 20.8, label: "Rest of their boat (hull, autopilot and sensors, charge controller, wiring)" },
};
/** The shared kayak slots on their boat, and what it has in them. */
const SHARED_DEFAULTS: Record<string, string> = { sat: "rockblock-9603n", light: "hella-naviled-360", paint: "micron-csc", spares: "none" };
/** Their waterplane is about 0.38 m² (Rev C yaml), in sea water: mm per kg added. */
const MM_PER_KG_RANDOLPH = 1000 / (1025 * 0.38);

/**
 * The catalog for a Randolph base, from Theo's slots and the kayak catalog's
 * shared slots. null when the slot table has no such base.
 */
export function randolphCatalog(key: "revc" | "revb", sim: SimSlots | null, kayak: Catalog): Catalog | null {
  const b = sim?.bases?.[key];
  if (!b) return null;
  const slots: CatalogSlot[] = [];
  for (const s of b.slots) {
    // Spares: their build plan has none, so their boat starts without (the simulator ignores spares on it).
    const def = s.id === "spares" ? SHARED_DEFAULTS.spares : (b.defaults[s.id] ?? SHARED_DEFAULTS[s.id]);
    const shared = kayak.slots.find((x) => x.id === s.id);
    if (!FIGURES[s.id] && shared) {
      // A slot shared with the kayak (satellite modem, light, paint, spares): our catalog's parts,
      // the simulator's word on what they do to their boat. What it has as built always sails.
      slots.push({
        ...shared,
        opts: shared.opts
          .filter((o) => s.opts.some((x) => x.id === o.id))
          .map((o) => {
            const so = s.opts.find((x) => x.id === o.id)!;
            return {
              ...o,
              kg: 0, // the kayak's weight changes don't carry over; these are small parts
              def: o.id === def ? 1 : undefined,
              effect: o.id === def ? "wired" : so.effect,
              basis: so.basis,
            };
          }),
      });
      continue;
    }
    slots.push({
      id: s.id,
      name: s.name,
      opts: s.opts.map((o) => {
        const f = FIGURES[s.id]?.[o.id] ?? { cost: 0, kg: 0, est: 1 };
        return {
          id: o.id,
          n: o.n ?? o.id,
          d: f.d ?? o.basis,
          cost: f.cost ?? 0,
          ...f,
          // The simulator's weight change when it gives one, so the totals and the physics agree.
          kg: typeof o.kg === "number" ? o.kg : (f.kg ?? 0),
          def: def === o.id ? 1 : undefined,
          est: f.est || o.est ? 1 : undefined,
          effect: o.effect,
          basis: o.basis,
          simEst: o.est,
        } as CatalogOption;
      }),
    });
  }
  // Older slot tables list the shared slots only by id.
  for (const id of b.shared_slots) {
    if (slots.some((s) => s.id === id)) continue;
    const s = kayak.slots.find((x) => x.id === id);
    if (!s) continue;
    const want = b.defaults[id] ?? SHARED_DEFAULTS[id];
    slots.push({
      ...s,
      opts: s.opts.map((o) => ({
        ...o,
        kg: 0,
        def: o.id === want ? 1 : undefined,
        effect: o.id === want ? "wired" : "no effect yet",
      })),
    });
  }
  // Weight: kg on each option is a change from Rev C as built; take the as-built picks back out.
  const asBuiltKg = slots.reduce((a, s) => a + ((s.opts.find((o) => o.def) ?? s.opts[0]).kg ?? 0), 0);
  const rest = REST[key];
  return {
    note: `${BASE_NAMES[key]}: ${b.design}`,
    key,
    base: { label: rest.label, cost: rest.cost, kg: -asBuiltKg },
    plannedKg: rest.kg,
    fixed: { thr: 0, ais: 0, boxes: 1, beacon: 0, af: 1 },
    mmPerKg: MM_PER_KG_RANDOLPH,
    credit: RANDOLPH_CREDIT,
    program: kayak.program,
    slots,
  };
}

/** The base named in a share link (#base=revc&...); the kayak when absent or unknown. */
export function baseFromHash(hash: string): BaseKey {
  const v = new URLSearchParams(hash.replace(/^#/, "")).get("base");
  return (BASE_KEYS as string[]).includes(v ?? "") ? (v as BaseKey) : "kayak";
}
