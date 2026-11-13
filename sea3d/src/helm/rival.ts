// The other boat in a race, on the water (M2 piece R4; Elena: "the second boat is on the water").
//
// A race's two boats launch from the same spot and soon sail kilometres apart, so the other boat
// is drawn as a real boat (her own model, solid, not the see-through practice ghost) while she is
// close enough to see, and the chart shows where she is after that. Display only.

import * as THREE from "three";
import type { BoatModel } from "../boats/model";

/** She is drawn within this distance (m), and fades in the sea haze over the last part of it. */
export const RIVAL_SEEN_M = 4000;
/** Both boats start on the same spot: she is drawn at least this far off your beam (m) so the hulls never overlap. */
export const RIVAL_CLEAR_M = 25;
/** The side-step fades out as the real gap opens to this (m). */
const CLEAR_OVER_M = 150;

const M_PER_DEG = 111_320;

/**
 * Where to draw her from your boat: metres east (dx) and south (dz, the page's z), and the true gap (m).
 * `heading` is your boat's, degrees clockwise from north: while the true gap is tiny she is moved off
 * your starboard beam so two boats launched from one spot sit side by side, not inside each other.
 */
export function rivalOffset(you: [number, number], her: [number, number], heading: number): { dx: number; dz: number; m: number } {
  const east = (her[1] - you[1]) * M_PER_DEG * Math.cos((you[0] * Math.PI) / 180);
  const north = (her[0] - you[0]) * M_PER_DEG;
  const m = Math.hypot(east, north);
  const step = RIVAL_CLEAR_M * Math.max(0, 1 - m / CLEAR_OVER_M);
  const beam = ((heading + 90) * Math.PI) / 180; // starboard: 90 degrees clockwise of the bow
  return { dx: east + step * Math.sin(beam), dz: -(north + step * Math.cos(beam)), m };
}

export class Rival {
  readonly group = new THREE.Group();
  private model: BoatModel | null = null;
  /** Where she is drawn now (m from your boat): eased, so the first logged hour doesn't make her jump. */
  private at: { x: number; z: number } | null = null;

  constructor() {
    this.group.name = "race-rival";
    this.group.visible = false;
  }

  get built(): boolean {
    return !!this.model;
  }

  set(model: BoatModel | null): void {
    if (this.model) {
      this.group.remove(this.model.root);
      this.model.dispose();
    }
    this.model = model;
    if (model) this.group.add(model.root);
  }

  /** Pose her: (dx, dz) metres from your boat, the water's height there, yaw (radians, the page's convention), roll, and the true gap (m). */
  update(dx: number, dz: number, y: number, yaw: number, roll: number, flow: { x: number; z: number }, dt: number, gap: number): void {
    const m = this.model;
    this.group.visible = !!m && gap <= RIVAL_SEEN_M;
    if (!m || !this.group.visible) {
      this.at = null;
      return;
    }
    // Small moves glide (about a second); big ones (the clock running fast, a jump on the scrub bar) are taken at once.
    const far = !this.at || Math.hypot(dx - this.at.x, dz - this.at.z) > 200;
    const k = far ? 1 : Math.min(1, dt * 1.5);
    this.at = far ? { x: dx, z: dz } : { x: this.at!.x + (dx - this.at!.x) * k, z: this.at!.z + (dz - this.at!.z) * k };
    m.root.position.set(this.at.x, y - m.spec.cgBelowWaterline, this.at.z);
    m.root.rotation.set(roll, yaw, 0, "YZX");
    m.rig?.update(dt, { flow, plan: null, rudder: 0 });
  }

  hide(): void {
    this.group.visible = false;
    this.at = null;
  }

  /** The point above her for a name tag (world), or null when she isn't drawn. */
  tagPoint(out: THREE.Vector3): THREE.Vector3 | null {
    if (!this.model || !this.group.visible) return null;
    return this.model.root.localToWorld(out.set(0, this.model.tagHeight, 0));
  }
}
