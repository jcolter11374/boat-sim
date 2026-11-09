// Physical numbers for the two boats, with no three.js in sight. The centre
// of gravity comes from the motion model's mass budget (Theo, src/motion.ts)
// so the drawn boat turns about the same point the physics does.
//
// Boat frame used everywhere in sea3d: origin at the centre of gravity (CG),
// +x = towards the bow, +y = up, +z = starboard (right when facing the bow).
// This matches Theo's wave-motion model (src/motion.ts), which turns the boat
// about its CG.

import { KAYAK_V4, RANDOLPH_REVB } from "../motion";

export interface BoatSpec {
  key: "kayak" | "randolph";
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

export const BOATS: BoatSpec[] = [KAYAK, RANDOLPH];
