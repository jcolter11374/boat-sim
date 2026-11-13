// The equipment a boat shows on the strip (Watch a voyage and the helm draw the same icons):
// which parts, in what order, under what names, and which are broken now.

import { isStock, type BoatSpec } from "../boats/specs";
import { PART_NAME } from "./data";
import type { Part } from "./hud";

type BoatKey = BoatSpec["key"];

/** The parts each boat shows, in order. "comms" is the satellite radio's live state. */
export const EQUIPMENT: Record<BoatKey, string[]> = {
  kayak: ["thruster_port", "thruster_starboard", "rudder", "electronics_main", "electronics_safe", "comms", "beacon", "leak", "entangled"],
  randolph: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak", "entangled"],
  stock_cruiser31: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak"],
  stock_dinghy14: ["sail", "rudder", "electronics_main", "comms", "beacon"],
  stock_beachcat16: ["sail", "rudder", "electronics_main", "comms", "beacon"],
  stock_sail_drone7: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak"],
  stock_ocean_rower45: ["rudder", "electronics_main", "comms", "beacon", "leak"],
  stock_pearson31_2: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak"],
};

/** A boat's parts with their names and whether each is broken: `failed` is the replay's
 *  failures so far (failuresAt), `comms` its radio state now (commsAt). */
export function equipmentParts(boatKey: BoatKey, comms: string | null | undefined, failed: Map<string, string>): Part[] {
  return EQUIPMENT[boatKey].map((p): Part => {
    if (p === "comms") return { key: p, name: PART_NAME.comms_silent, bad: failed.has("comms_silent") || comms === "beacon" || comms === "silent" };
    if (p === "leak") return { key: p, name: PART_NAME.leak_main_tub, bad: failed.has("leak_main_tub") || failed.has("leak_safe_tub") };
    if (p === "entangled") return { key: p, name: failed.has(p) ? "Snagged" : "No snags", bad: failed.has(p) };
    const name = p === "beacon" && boatKey === "randolph" ? "Backup tracker" : p === "sail" && isStock(boatKey) ? "Sails" : (PART_NAME[p] ?? p);
    return { key: p, name, bad: failed.has(p) };
  });
}
