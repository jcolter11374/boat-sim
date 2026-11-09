// STAND-IN boat motion, until Theo's wave-motion model (src/motion.ts) lands.
//
// Same shape as Theo's BoatMotion so swapping is one import:
//   const m = new SurfaceFollower(spec, { x, z, yaw });
//   m.advance(comps, t);           // same comps as waves.ts displace()
//   obj.position.set(x, m.heave, z);
//   obj.rotation.set(m.roll, yaw, m.pitch, "YZX");
//
// Axes (boat frame): bow +x, up +y, starboard +z, origin on the waterline.
// heave m up; pitch rad, bow up +; roll rad, heeled to starboard +.
// yaw is three.js rotation.y, so the bow points along (cos yaw, -sin yaw) in (x, z).
//
// This is NOT physics: the boat copies the average height and tilt of the sea
// under its hull, with a short lag. No inertia, no righting arm, no
// resonance, so it says nothing about capsizing or how far a boat really
// rolls. The page says so while it is in use. No three.js imports, so it can
// be tested on its own.

import type { BoatSpec } from "./boats/specs";
import { heightAt, type WaveComponent } from "./waves";

export interface Placement {
  x: number;
  z: number;
  yaw: number;
}

/** Boat-frame (bx, bz) to world (x, z) for a boat placed at p. */
export function toWorld(bx: number, bz: number, p: Placement): [number, number] {
  const c = Math.cos(p.yaw);
  const s = Math.sin(p.yaw);
  // three.js rotation.y by yaw: x' = x cos + z sin, z' = -x sin + z cos
  return [p.x + bx * c + bz * s, p.z - bx * s + bz * c];
}

export class SurfaceFollower {
  static readonly label = "Stand-in motion: copies the sea surface (not yet the physics model)";
  static readonly physical = false;

  heave = 0;
  pitch = 0;
  roll = 0;
  private lastT: number | null = null;
  private readonly lag: number;
  private readonly a: number;
  private readonly b: number;

  constructor(
    readonly spec: BoatSpec,
    public place: Placement,
    readonly steepness = 0.5,
  ) {
    this.a = 0.4 * spec.length; // sample inside the hull ends, which are in the water
    this.b = 0.4 * spec.beam;
    this.lag = 0.15 + 0.1 * spec.length; // GUESS display smoothing; longer hulls average more chop
  }

  reset(): void {
    this.lastT = null;
  }

  advance(comps: WaveComponent[], t: number): void {
    const h = (bx: number, bz: number) => {
      const [x, z] = toWorld(bx, bz, this.place);
      return heightAt(comps, x, z, t, this.steepness);
    };
    const c = h(0, 0);
    const bow = h(this.a, 0);
    const stern = h(-this.a, 0);
    const stbd = h(0, this.b);
    const port = h(0, -this.b);
    const heave = (c + bow + stern + stbd + port) / 5;
    const pitch = Math.atan2(bow - stern, 2 * this.a);
    const roll = Math.atan2(port - stbd, 2 * this.b); // port side higher -> starboard down
    const dt = this.lastT === null ? 0 : t - this.lastT;
    this.lastT = t;
    if (dt <= 0) {
      this.heave = heave;
      this.pitch = pitch;
      this.roll = roll;
      return;
    }
    const k = 1 - Math.exp(-dt / this.lag);
    this.heave += k * (heave - this.heave);
    this.pitch += k * (pitch - this.pitch);
    this.roll += k * (roll - this.roll);
  }
}
