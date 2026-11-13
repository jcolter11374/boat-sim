// Physical numbers for the two boats, with no three.js in sight. The centre
// of gravity comes from the motion model's mass budget (Theo, src/motion.ts)
// so the drawn boat turns about the same point the physics does.
//
// Boat frame used everywhere in sea3d: origin at the centre of gravity (CG),
// +x = towards the bow, +y = up, +z = starboard (right when facing the bow).
// This matches Theo's wave-motion model (src/motion.ts), which turns the boat
// about its CG.

import { CRUISER31, DINGHY14, BEACHCAT16, KAYAK_V4, OCEAN_ROWER45, PEARSON31_2, RANDOLPH_REVB, SAIL_DRONE7, type HullParams } from "../motion";

/** Theo's stock vessels (configs/stock_*.yaml), by their config names. */
export type StockKey = "stock_cruiser31" | "stock_dinghy14" | "stock_beachcat16" | "stock_sail_drone7" | "stock_ocean_rower45" | "stock_pearson31_2";

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

export const SAIL_DRONE: BoatSpec = {
  key: "stock_sail_drone7",
  name: "wind-powered ocean drone",
  length: 7.0,
  beam: 0.9,
  waterline: 0.34, // the hull's draft; the keel goes on to about 2 m
  massKg: 750,
  ballastKg: 250,
  ballastDepth: 1.6,
  cgX: SAIL_DRONE7.cgX,
  cgBelowWaterline: SAIL_DRONE7.cgBelowWaterline,
  cruiseSpeed: 1.4, // about 2.7 kn
  colour: 0xf2b33d,
  source: "configs/stock_sail_drone7.yaml (published specs of a 7 m uncrewed sailing drone)",
};

export const OCEAN_ROWER: BoatSpec = {
  key: "stock_ocean_rower45",
  name: "ocean rowing boat",
  length: 8.64,
  beam: 1.74,
  waterline: 0.35, // GUESS: loaded to 1500 kg; the daggerboard goes on to about 0.9 m
  massKg: 1500,
  ballastKg: 0, // water and food stowed low, no lead
  ballastDepth: 0,
  cgX: OCEAN_ROWER45.cgX,
  cgBelowWaterline: OCEAN_ROWER45.cgBelowWaterline,
  cruiseSpeed: 1.3, // about 2.5 kn with two rowing
  colour: 0x2f6fa8,
  source: "configs/stock_ocean_rower45.yaml (published specs of an 8.64 m ocean rowing boat for four)",
};

/** Randolph's own boat (their team's, not a generic one): a Pearson 31-2 with the deep keel.
 * Pearson Yachts' published numbers (Theo, configs/stock_pearson31_2.yaml); the shape between
 * them, and the colours, are ours (blender/build_stock.py "pearson"). */
export const PEARSON: BoatSpec = {
  key: "stock_pearson31_2",
  name: "Pearson 31-2 (our model of Randolph's boat)",
  length: 9.39,
  beam: 3.29,
  waterline: 0.55, // the canoe body's draft; the keel goes on to 1.71 m
  massKg: 4536, // 10,000 lb
  ballastKg: 1724, // 3,800 lb
  ballastDepth: 1.2, // GUESS (Theo): the lead centre in a fin with no bulb
  cgX: PEARSON31_2.cgX,
  cgBelowWaterline: PEARSON31_2.cgBelowWaterline,
  cruiseSpeed: 2.8, // about 5.5 kt
  colour: 0x1a2a4a,
  source: "configs/stock_pearson31_2.yaml (Pearson Yachts' published specs of the Pearson 31-2, deep keel)",
};

export const STOCK: Record<StockKey, BoatSpec> = {
  stock_cruiser31: CRUISER,
  stock_dinghy14: DINGHY,
  stock_beachcat16: BEACHCAT,
  stock_sail_drone7: SAIL_DRONE,
  stock_ocean_rower45: OCEAN_ROWER,
  stock_pearson31_2: PEARSON,
};
/** Each stock boat's motion model (motion.ts), so every page moves it the same way. */
export const STOCK_HULL: Record<StockKey, HullParams> = {
  stock_cruiser31: CRUISER31,
  stock_dinghy14: DINGHY14,
  stock_beachcat16: BEACHCAT16,
  stock_sail_drone7: SAIL_DRONE7,
  stock_ocean_rower45: OCEAN_ROWER45,
  stock_pearson31_2: PEARSON31_2,
};
/** The stock boats you can pick in Set sail. Maya held all but the keelboats back on 11 Nov (the
 * dinghy and cat capsize in squalls, and the sandbox had no rain yet); John, 13 Nov: every built boat
 * goes in, one at a time, each checked on the water first. */
export const PLAYABLE_STOCK: StockKey[] = ["stock_cruiser31", "stock_pearson31_2", "stock_sail_drone7", "stock_ocean_rower45", "stock_dinghy14"];
export const isStock = (k: string): k is StockKey => k in STOCK;
/** The names a player sees for the stock boats: their real make and model (John's decision B4, 12 Nov:
 * "brands are in"), each our own model of it. The same in the boat picker, on the Set sail card and as
 * "my boat". Randolph and Becky's boat always says "(our model)" (B2). */
const PLAYER_NAME: Record<StockKey, string> = {
  stock_pearson31_2: "Pearson 31-2 (our model)",
  stock_cruiser31: "Beneteau First 31.7",
  stock_dinghy14: "Sunfish",
  stock_beachcat16: "Hobie 16",
  stock_sail_drone7: "Saildrone Explorer",
  stock_ocean_rower45: "Rannoch R45 ocean rowing boat",
};
export const playerName = (k: StockKey): string => PLAYER_NAME[k];
/** The stock boat a replay's boat name is ("31 ft cruiser"), or null. */
export function stockKeyOf(boat: string | undefined): StockKey | null {
  const b = boat ?? "";
  // Randolph's Pearson first: its name must never fall through to the generic cruiser.
  if (/pearson/i.test(b)) return "stock_pearson31_2";
  if (/cruiser/i.test(b)) return "stock_cruiser31";
  if (/dinghy/i.test(b)) return "stock_dinghy14";
  if (/beach\s*cat|catamaran/i.test(b)) return "stock_beachcat16";
  if (/ocean drone|sail\s*drone/i.test(b)) return "stock_sail_drone7";
  if (/rowing|rower/i.test(b)) return "stock_ocean_rower45";
  return null;
}

export const BOATS: BoatSpec[] = [KAYAK, RANDOLPH];
