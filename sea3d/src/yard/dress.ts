// Dress the 3D kayak to match a Boatyard design: the parts you pick appear,
// disappear or change size on the model, and a heavier boat floats lower.
// Cosmetic: the numbers come from the catalog (design.ts), not from here.

import * as THREE from "three";
import type { BoatModel } from "../boats/model";
import { MM_PER_KG, PLANNED_KG, type Summary } from "./design";

const show = (root: THREE.Object3D, names: string[], on: boolean) => {
  for (const n of names) root.getObjectByName(n)?.traverse((o) => (o.visible = on));
};

/** What the model shows for a design, for tests and for the parts list ("drawn" or not). */
export interface Dressed {
  thrusters: number;
  panels: number;
  ais: boolean;
  beacon: boolean;
  bulbScale: number;
  sinkMm: number;
}

export function dress(model: BoatModel, s: Summary, bulbKg: number): Dressed {
  const g = model.root;
  // Motors: one T200 sits on the centreline instead of two either side.
  const port = g.getObjectByName("thruster_port");
  const stbd = g.getObjectByName("thruster_starboard");
  const one = s.thrusters < 2;
  if (stbd) stbd.visible = !one;
  if (port) {
    port.userData.z ??= port.position.z;
    port.position.z = one ? 0 : port.userData.z;
  }
  // Solar: 2 x 100 W panels plus the 50 W aft panel for 250 W; 200 W drops the aft one.
  // (300 W isn't drawn: the catalog flags that the kayak may not have the deck for it.)
  show(g, ["panel_aft"], s.solarW > 200);
  show(g, ["ais_base", "ais_whip"], s.ais);
  show(g, ["beacon", "beacon_top"], s.beacon);
  // Keel bulb: same lead shape scaled to its weight.
  const bulb = g.getObjectByName("bulb");
  const scale = Math.cbrt(bulbKg / 50);
  if (bulb) {
    bulb.userData.s ??= bulb.scale.x;
    bulb.scale.setScalar(bulb.userData.s * scale);
  }
  const sinkMm = (s.massKg - PLANNED_KG) * MM_PER_KG;
  return { thrusters: one ? 1 : 2, panels: s.solarW > 200 ? 3 : 2, ais: s.ais, beacon: s.beacon, bulbScale: scale, sinkMm };
}
