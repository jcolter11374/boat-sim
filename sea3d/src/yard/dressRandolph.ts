// Dress our model of the Randolph boat to the Boatyard picks: one or two
// rudders, the YB3 backup tracker on the stern post, and the small motor of
// the wing-and-thruster option. (Battery, boxes and keel bulb changes are
// inside or too small to see; the summary panel carries those.)
//
// Positions are in the model's own frame (metres from the bow, up from the
// keel line), from their build-files/source/design.py as in boats/model.ts.

import * as THREE from "three";
import type { BoatModel } from "../boats/model";

const RUDDER_OFF = 0.1; // m either side of the centreline (Rev C, Build_Plan.md)

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
    // YB3: a yellow box about 6 x 3 x 10 cm with a dark top, on the antenna platform.
    this.tracker = new THREE.Group();
    this.tracker.name = "yard_yb3";
    const box = new THREE.Mesh(geo(new THREE.BoxGeometry(0.06, 0.1, 0.03)), std(0xf3c614, 0.45));
    box.position.set(1.47, 0.63, 0.035);
    const cap = new THREE.Mesh(geo(new THREE.BoxGeometry(0.062, 0.015, 0.032)), std(0x222222, 0.6));
    cap.position.set(1.47, 0.687, 0.035);
    this.tracker.add(box, cap);
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
