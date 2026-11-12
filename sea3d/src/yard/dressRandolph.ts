// Dress our model of the Randolph boat to the Boatyard picks: one or two
// rudders, the YB3 backup tracker in its foredeck well (Rev C3), and the small motor of
// the wing-and-thruster option. (Battery, boxes and keel bulb changes are
// inside or too small to see; the summary panel carries those.)
//
// Positions are in the model's own frame (metres from the bow, up from the
// keel line), from their build-files/source/design.py as in boats/model.ts.

import * as THREE from "three";
import type { BoatModel } from "../boats/model";

const RUDDER_OFF = 0.1; // m either side of the centreline (Rev C, Build_Plan.md)
/** The YB3 well: 180 mm from the bow (Rev C3), and the deck's height there (boats/model.ts form: dz + crown). */
const YB3_X = 0.18;
const YB3_DECK = 0.23 + 0.03 * (1 - YB3_X / 1.5 / 0.4) ** 2 + 0.006;

export class RandolphDress {
  private rudder: THREE.Object3D | null;
  private twin: THREE.Object3D | null = null;
  private tracker: THREE.Group;
  private thruster: THREE.Group;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  constructor(model: BoatModel) {
    this.rudder = model.root.getObjectByName("rudder_pivot") ?? null;
    const frame = this.rudder?.parent ?? model.root;
    if (this.rudder) {
      this.twin = this.rudder.clone(true);
      this.twin.name = "rudder_pivot_twin";
      frame.add(this.twin);
    }
    const std = (color: number, rough = 0.5, metal = 0.1) => {
      const m = new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal });
      this.mats.push(m);
      return m;
    };
    const geo = <T extends THREE.BufferGeometry>(g: T) => (this.geos.push(g), g);
    // YB3: a yellow box about 10 x 6 x 3 cm lying in a well in the foredeck, centred
    // 180 mm from the bow with its top flush with the deck (Rev C3, their Design_RevC.md:
    // off the stern post, so one bent post can't silence both trackers). Seen from
    // above: a dark gasket round the well, the yellow case, its dark antenna patch.
    this.tracker = new THREE.Group();
    this.tracker.name = "yard_yb3";
    const gasket = new THREE.Mesh(geo(new THREE.BoxGeometry(0.112, 0.003, 0.072)), std(0x1d2124, 0.7));
    gasket.position.set(YB3_X, YB3_DECK - 0.001, 0); // top just under the case: a dark rim round it
    const box = new THREE.Mesh(geo(new THREE.BoxGeometry(0.1, 0.03, 0.06)), std(0xf3c614, 0.45));
    box.position.set(YB3_X, YB3_DECK - 0.0135, 0);
    const cap = new THREE.Mesh(geo(new THREE.BoxGeometry(0.045, 0.002, 0.04)), std(0x222222, 0.6));
    cap.position.set(YB3_X + 0.02, YB3_DECK + 0.0025, 0);
    this.tracker.add(gasket, box, cap);
    frame.add(this.tracker);
    // Thruster: a small pod on a strut under the stern quarter.
    this.thruster = new THREE.Group();
    this.thruster.name = "yard_thruster";
    const dark = std(0x26292c, 0.4, 0.4);
    const pod = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.035, 0.035, 0.11, 18).rotateZ(Math.PI / 2)), dark);
    pod.position.set(1.18, -0.06, 0);
    const strut = new THREE.Mesh(geo(new THREE.BoxGeometry(0.03, 0.08, 0.008)), dark);
    strut.position.set(1.18, -0.01, 0);
    this.thruster.add(pod, strut);
    frame.add(this.thruster);
  }

  /** Show the picks; returns what is on show (for tests). */
  apply(picks: Record<string, string>): { rudders: number; tracker: boolean; thruster: boolean } {
    const twin = picks.rudder === "twin" && !!this.twin;
    if (this.rudder) this.rudder.position.z = twin ? -RUDDER_OFF : 0;
    if (this.twin) {
      this.twin.visible = twin;
      this.twin.position.z = RUDDER_OFF;
    }
    this.tracker.visible = picks.tracker === "yb3";
    this.thruster.visible = picks.drive === "wing-thruster";
    return { rudders: this.rudder ? (twin ? 2 : 1) : 0, tracker: this.tracker.visible, thruster: this.thruster.visible };
  }

  dispose(): void {
    this.twin?.removeFromParent();
    this.tracker.removeFromParent();
    this.thruster.removeFromParent();
    for (const m of this.mats) m.dispose();
    for (const g of this.geos) g.dispose();
  }
}
