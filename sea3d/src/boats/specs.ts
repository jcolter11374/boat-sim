// Physical numbers for the two boats, with no three.js in sight. The centre
// of gravity comes from the motion model's mass budget (Theo, src/motion.ts)
// so the drawn boat turns about the same point the physics does.
//
// Boat frame used everywhere in sea3d: origin at the centre of gravity (CG),
// +x = towards the bow, +y = up, +z = starboard (right when facing the bow).
// This matches Theo's wave-motion model (src/motion.ts), which turns the boat
// about its CG.

import { CRUISER31, DINGHY14, BEACHCAT16, KAYAK_V4, RANDOLPH_REVB } from "../motion";

/** Theo's stock vessels (configs/stock_*.yaml), by their config names. */
export type StockKey = "stock_cruiser31" | "stock_dinghy14" | "stock_beachcat16";

export interface BoatSpec {
  key: "kayak" | "randolph" | StockKey;
  name: string;
  length: number; // m, overall hull length
  beam: number; // m, widest point of the hull
  waterline: number; // m, height of the floating waterline above the hull bottom
  massKg: number; // all-up
  ballastKg: number; // lead bulb
  ballastDepth: number; // m, bulb centre below the waterline
  cgX: number; // m, CG distance aft of the bow (Theo, #129)
  cgBelowWaterline: number; // m, CG depth below the static waterline (Theo, #129)
  cruiseSpeed: number; // m/s through the water, for the wake (display)
  colour: number; // label and highlight colour
  source: string; // where the numbers come from
}

export const KAYAK: BoatSpec = {
  key: "kayak",
  name: "Our v4 solar kayak",
  length: 3.05,
  beam: 0.79, // ≈ not yet measured (design doc)
  waterline: 0.1, // ≈ from the drawn hull shape at 123 kg
  massKg: 123,
  ballastKg: 50,
  ballastDepth: 0.9,
  cgX: KAYAK_V4.cgX, // from the motion model's mass budget, so picture and physics agree
  cgBelowWaterline: KAYAK_V4.cgBelowWaterline,
  cruiseSpeed: 0.87, // 1.7 kt at the 25 W cruise (design doc)
  colour: 0xe8590c,
  source: "configs/v4_kayak.yaml and the v4 design doc",
};

export const RANDOLPH: BoatSpec = {
  key: "randolph",
  name: "Randolph wing-sail drone (Rev B)",
  length: 1.5,
  beam: 0.4,
  waterline: 0.09,
  massKg: 21,
  ballastKg: 8.2,
  ballastDepth: 0.524, // 0.434 below the hull bottom + 0.09 waterline
  cgX: RANDOLPH_REVB.cgX,
  cgBelowWaterline: RANDOLPH_REVB.cgBelowWaterline,
  cruiseSpeed: 0.5, // GUESS ~1 kt; a sailing drone's speed depends on the wind
  colour: 0x0f8a8a,
  source: "sheltonr2/drone-boat build-files/source/design.py (MIT)",
};

// --- Stock vessels: generic boats from published specs (Theo, configs/stock_*.yaml).
// Length, beam and mass from the configs; the waterline and the boat's own
// shape from our Blender models (blender/build_stock.py).
export const CRUISER: BoatSpec = {
  key: "stock_cruiser31",
  name: "31 ft cruiser",
  length: 9.45,
  beam: 3.21,
  waterline: 0.55, // the canoe body's draft; the keel goes on to 1.9 m
  massKg: 3887,
  ballastKg: 1025,
  ballastDepth: 1.75,
  cgX: CRUISER31.cgX,
  cgBelowWaterline: CRUISER31.cgBelowWaterline,
  cruiseSpeed: 3.0, // about 6 kt
  colour: 0x2f6fd0,
  source: "configs/stock_cruiser31.yaml (published specs of a common 31 ft cruiser-racer)",
};

export const DINGHY: BoatSpec = {
  key: "stock_dinghy14",
  name: "14 ft dinghy",
  length: 4.2,
  beam: 1.24,
  waterline: 0.08,
  massKg: 75,
  ballastKg: 0,
  ballastDepth: 0,
  cgX: DINGHY14.cgX,
  cgBelowWaterline: DINGHY14.cgBelowWaterline,
  cruiseSpeed: 2.0,
  colour: 0x2c6fb5,
  source: "configs/stock_dinghy14.yaml (published specs of a common board-boat dinghy)",
};

export const BEACHCAT: BoatSpec = {
  key: "stock_beachcat16",
  name: "16 ft beach cat",
  length: 4.9,
  beam: 2.41,
  waterline: 0.16,
  massKg: 170,
  ballastKg: 0,
  ballastDepth: 0,
  cgX: BEACHCAT16.cgX,
  cgBelowWaterline: BEACHCAT16.cgBelowWaterline,
  cruiseSpeed: 4.0,
  colour: 0xd8432b,
  source: "configs/stock_beachcat16.yaml (published specs of a common 16 ft beach catamaran)",
};

export const STOCK: Record<StockKey, BoatSpec> = { stock_cruiser31: CRUISER, stock_dinghy14: DINGHY, stock_beachcat16: BEACHCAT };
/** Only the cruiser can be sailed in the games for now (Maya, 11 Nov: the dinghy and
 * cat capsize in squalls, and the sandbox has no rain yet). */
export const PLAYABLE_STOCK: StockKey[] = ["stock_cruiser31"];
export const isStock = (k: string): k is StockKey => k in STOCK;
/** The stock boat a replay's boat name is ("31 ft cruiser"), or null. */
export function stockKeyOf(boat: string | undefined): StockKey | null {
  const b = boat ?? "";
  if (/cruiser/i.test(b)) return "stock_cruiser31";
  if (/dinghy/i.test(b)) return "stock_dinghy14";
  if (/beach\s*cat|catamaran/i.test(b)) return "stock_beachcat16";
  return null;
}

export const BOATS: BoatSpec[] = [KAYAK, RANDOLPH];
