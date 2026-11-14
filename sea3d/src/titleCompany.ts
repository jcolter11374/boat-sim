/**
 * Company on the title's water (John, 14 Nov 2026: "maybe add some other vessels around for
 * flavor ... just a visual way to make it look more alive"). Display only: a few yachts out
 * early, sailing slowly in the light dawn air, a freighter of the kind that really does lie at
 * anchor off Annapolis waiting for a berth in Baltimore, and a waterman's workboat.
 *
 * Placed by the title's own compass (the drawn bearings framing.ts films: a boat with sails is
 * seen looking about 218 degrees, a boat without about 128), so each view has company in it,
 * at distances that leave the player's boat the star: the nearest is 280 m off.
 */
import * as THREE from "three";
import { BUILDERS, type BoatModel } from "./boats/model";
import { dressShip, makeShip, type ShipKind } from "./boats/ships";
import type { StockKey } from "./boats/specs";
import type { Quality } from "./boats/parts";

/** A yacht: which, where (drawn compass bearing from the hero, degrees; distance, m), her heading (degrees, the same compass) and speed (m/s). */
interface YachtPlan { key: StockKey; bearing: number; dist: number; heading: number; speed: number; heel: number }
/** An anchored ship: which kind, where, and paint seed. */
interface ShipPlan { kind: ShipKind; bearing: number; dist: number; seed: number }

export const YACHTS: YachtPlan[] = [
  // The yacht's view (about 198 to 238).
  { key: "stock_cruiser31", bearing: 235, dist: 430, heading: 150, speed: 1.6, heel: 7 },
  { key: "stock_pearson31_2", bearing: 210, dist: 1100, heading: 300, speed: 1.4, heel: 6 },
  // The kayak's view (about 108 to 148).
  { key: "stock_pearson31_2", bearing: 116, dist: 650, heading: 200, speed: 1.5, heel: 6 },
  { key: "stock_dinghy14", bearing: 141, dist: 280, heading: 40, speed: 1.2, heel: 9 },
];
export const SHIPS: ShipPlan[] = [
  { kind: "bulk", bearing: 214, dist: 2300, seed: 0.37 },
  // The kayak looks towards Greenbury Point, 1.5 km off: no anchorage there, but a waterman's boat working the shallows.
  { kind: "fishing", bearing: 131, dist: 700, seed: 0.71 },
];
/** Where the anchored ships' bows point (degrees): all swung alike to the same tide. */
export const SHIPS_HEAD = 20;
/** The yachts' round (s): each sails on from her spot for a quarter of an hour, then comes round again from as far behind, out of sight by then. */
export const LOOP_S = 1800;

/** Drawn compass bearing (deg) and distance to a scene spot: x east, z south. */
export function spotAt(bearing: number, dist: number): { x: number; z: number } {
  const b = THREE.MathUtils.degToRad(bearing);
  return { x: Math.sin(b) * dist, z: -Math.cos(b) * dist };
}
/** A compass heading (deg) as a model's yaw (its bow along +x). */
export const yawOf = (heading: number) => THREE.MathUtils.degToRad(90 - heading);

export class TitleCompany {
  readonly root = new THREE.Group();
  private yachts: { plan: YachtPlan; model: BoatModel; at: { x: number; z: number } }[] = [];
  private ships: THREE.Group[] = [];
  private readonly range = { value: 8000 };

  constructor(quality: Quality) {
    this.root.name = "title-company";
    for (const plan of YACHTS) {
      const model = BUILDERS[plan.key](quality);
      this.root.add(model.root);
      this.yachts.push({ plan, model, at: spotAt(plan.bearing, plan.dist) });
    }
    for (const p of SHIPS) {
      const s = makeShip(p.kind, this.range);
      dressShip(s, p.kind, p.seed, true);
      const at = spotAt(p.bearing, p.dist);
      s.position.set(at.x, (s.userData.lift as number) ?? 0, at.z);
      s.rotation.y = yawOf(SHIPS_HEAD);
      this.root.add(s);
      this.ships.push(s);
    }
  }

  /** Each frame: the yachts sail on, ride the swell and heel to the breeze. sea: the water's height at a scene spot. */
  update(t: number, sea: (x: number, z: number) => number): void {
    for (const y of this.yachts) {
      const yaw = yawOf(y.plan.heading);
      // From her spot at the start, on along her heading; after a quarter of an hour, far off, she comes round again from as far behind.
      const run = y.plan.speed * (((t + LOOP_S / 2) % LOOP_S) - LOOP_S / 2);
      const x = y.at.x + Math.cos(yaw) * run;
      const z = y.at.z - Math.sin(yaw) * run;
      const r = y.model.root;
      r.position.set(x, sea(x, z), z);
      r.rotation.set(THREE.MathUtils.degToRad(y.plan.heel) * (1 + 0.15 * Math.sin(t * 0.7 + y.plan.dist)), yaw, 0.02 * Math.sin(t * 0.9 + y.plan.bearing), "YXZ");
      y.model.animate(t);
    }
  }

  dispose(): void {
    for (const y of this.yachts) y.model.dispose();
    // The ships: their geometry and their own materials (Maya, #581).
    for (const ship of this.ships)
      ship.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose?.();
        const mats = m.material;
        for (const x of mats ? (Array.isArray(mats) ? mats : [mats]) : []) x.dispose();
      });
    this.root.clear();
    this.yachts = [];
    this.ships = [];
  }
}
