// The two boats as three.js models, ported from Iris's boats-3d viewer.
// Shapes and sizes come from the real measurements (specs.ts gives the
// headline numbers; the shape functions below are the drawn hulls).
//
// Each model's root group is in the sea3d boat frame: origin at the centre of
// gravity, bow towards +x, +y up, +z starboard.
// The motion model sets that group's position and rotation; nothing in here
// moves the boat.

import { addNavLights, disposeNavLights } from "./navlights";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { applyFinishes } from "./finishes";
import { Gear, idleGear } from "./gear";
import { Kit, type HullForm, type Quality } from "./parts";
import { KAYAK, RANDOLPH, type BoatSpec } from "./specs";
import { buildStock, type StockRig } from "./stock";

export interface BoatModel {
  spec: BoatSpec;
  root: THREE.Group; // pose this
  /** Stern point at the waterline in the boat frame (where the wake starts). */
  stern: THREE.Vector3;
  /** Height in the boat frame for a name tag. */
  tagHeight: number;
  /** Working equipment (props, rudder, wing, comms light, failures): cosmetic only. */
  gear: Gear;
  /** The hull's shape (builder frame), for the foam where hull meets water. */
  form: HullForm;
  /** Sails and rudders of a stock sailing boat (boats/stock.ts), posed from the replay. */
  rig?: StockRig;
  /** Two hulls (the beach cat): the one-hull foam collar and deck drain don't fit. */
  twinHull?: boolean;
  /** Showroom: everything working, a gentle breeze. */
  animate(t: number): void;
  dispose(): void;
}

/** Wrap a model built in the builder frame (x aft from bow, y up from hull bottom). */
function frame(spec: BoatSpec): { root: THREE.Group; inner: THREE.Group } {
  const root = new THREE.Group();
  root.name = spec.key;
  const inner = new THREE.Group();
  inner.rotation.y = Math.PI; // builder x (aft) -> -x, so the bow points to +x
  // Builder origin (bow, hull bottom) sits cgX ahead of the CG and
  // (waterline - cgBelowWaterline) below it.
  inner.position.set(spec.cgX, spec.cgBelowWaterline - spec.waterline, 0);
  root.add(inner);
  return { root, inner };
}

// Detailed model built in Blender from the same numbers (blender/build_kayak.py),
// loaded once if the page has it; otherwise the kayak is drawn in code below.
// Detailed models built with Blender (blender/*.py) when the build has them.
let kayakDetailed: THREE.Group | null = null;
let randolphDetailed: THREE.Group | null = null;

async function loadOne(base: string, name: string): Promise<THREE.Group | null> {
  // NAME.glb is what the build makes; NAME.json (the same model as text) is
  // for hosts that won't serve .glb files.
  for (const file of [`${name}.glb`, `${name}.json`]) {
    try {
      return (await new GLTFLoader().loadAsync(`${base}/${file}`)).scene;
    } catch {
      // try the next one
    }
  }
  return null; // not built: keep the drawn-in-code model
}

/** Load the detailed models; true if any arrived (rebuild the boats then). */
export async function loadDetailedModels(base = "./models"): Promise<boolean> {
  if (new URLSearchParams(location.search).get("models") === "simple") return false;
  [kayakDetailed, randolphDetailed] = await Promise.all([loadOne(base, "kayak"), loadOne(base, "randolph")]);
  if (kayakDetailed) applyFinishes(kayakDetailed, "kayak");
  if (randolphDetailed) applyFinishes(randolphDetailed, "randolph"); // generic finishes: their materials are theirs to say
  return kayakDetailed !== null || randolphDetailed !== null;
}
export const hasDetailedKayak = () => kayakDetailed !== null;

// The Boatyard's other hull shapes (blender/build_shapes.py), loaded when first picked.
const shapes = new Map<string, Promise<THREE.Group | null>>();
/** A hull shape's detailed model (builder frame, finishes applied), or null if the build doesn't have it. */
export function loadShapeModel(id: string, base = "./models"): Promise<THREE.Group | null> {
  let p = shapes.get(id);
  if (!p) {
    p = loadOne(base, `shape_${id}`).then((g) => {
      if (g) applyFinishes(g, "kayak"); // same paint and kit as our kayak
      return g;
    });
    shapes.set(id, p);
  }
  return p;
}
export const hasDetailedRandolph = () => randolphDetailed !== null;

// =====================================================================
// OUR BOAT: v4 kayak. Metres. Bow at x = 0 in the builder frame.
// =====================================================================
export function buildKayak(quality: Quality): BoatModel {
  const kit = new Kit(quality);
  const K: HullForm = {
    L: KAYAK.length,
    n: 3.0,
    crown: 0.025,
    wl: KAYAK.waterline,
    hb: (s) =>
      s <= 0.5
        ? 0.395 * Math.pow(Math.max(1 - (1 - s / 0.5) ** 2, 0), 0.55)
        : 0.395 - (0.395 - 0.16) * Math.pow((s - 0.5) / 0.5, 2.2),
    kz: (s) => (s < 0.3 ? 0.16 * (1 - s / 0.3) ** 2 : s > 0.75 ? 0.05 * ((s - 0.75) / 0.25) ** 2 : 0),
    dz: (s) => 0.34 + 0.06 * Math.max(1 - s / 0.25, 0) ** 2,
  };
  const { root, inner: g } = frame(KAYAK);
  const g10 = kit.std(0x2b2f33);
  const guard = kit.std(0xc9ced3, { metalness: 0.8, roughness: 0.3 });
  if (kayakDetailed) {
    g.add(kayakDetailed.clone(true)); // hull, dome, panels, keel, rudder, deck kit
  } else {
    const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02, side: THREE.DoubleSide }));
    kit.mesh(kit.hull(K, { top: 0xf26a1b, deck: 0xe0601a, bottom: 0x3b4248, boot: 0xffffff }), hullMat, g);
    const deckY = (x: number, z: number) => {
      const s = x / K.L;
      const b = K.hb(s);
      return K.dz(s) + K.crown * (1 - Math.min((z / b) ** 2, 1));
    };

    // Self-righting foam dome, 2.2 m x 0.46 m x 0.20 m on the deck centreline.
    const DOME = { x0: 0.35, x1: 2.55, w: 0.23, h: 0.2, p: 2.6 };
    const domeProf = (x: number) => {
      const u = (x - DOME.x0) / (DOME.x1 - DOME.x0);
      if (u <= 0 || u >= 1) return 0;
      return Math.sqrt(Math.max(1 - Math.abs(2 * u - 1) ** 4, 0));
    };
    const domeH = (x: number, z: number) => {
      const f = domeProf(x);
      const w = DOME.w * f;
      const h = DOME.h * f;
      if (w <= 0 || Math.abs(z) >= w) return 0;
      return h * Math.pow(1 - Math.pow(Math.abs(z) / w, DOME.p), 1 / DOME.p);
    };
    {
      const nx = quality === "high" ? 60 : 30;
      const na = quality === "high" ? 28 : 14;
      const pos: number[] = [];
      const idx: number[] = [];
      for (let i = 0; i <= nx; i++) {
        const x = DOME.x0 + ((DOME.x1 - DOME.x0) * i) / nx;
        const f = domeProf(x);
        const w = Math.max(DOME.w * f, 0.0005);
        const h = Math.max(DOME.h * f, 0.0005);
        for (let j = 0; j <= na; j++) {
          const th = (Math.PI * j) / na;
          const c = Math.cos(th);
          const s = Math.sin(th);
          const z = w * Math.sign(c) * Math.pow(Math.abs(c), 2 / DOME.p);
          const y = h * Math.pow(s, 2 / DOME.p);
          pos.push(x, deckY(x, z) - 0.01 + y, z);
        }
      }
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < na; j++) {
          const a = i * (na + 1) + j;
          const b = a + na + 1;
          idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      kit.mesh(geo, kit.std(0xff7b2b), g);
    }
    const kTop = (x: number, z: number) => deckY(x, z) + domeH(x, z);
    kit.panel(g, 0.55, 1.53, 0.54, kTop, 6, 3); // 100 W
    kit.panel(g, 1.59, 2.5, 0.54, kTop, 6, 3); // 100 W
    kit.panel(g, 2.56, 2.92, 0.34, kTop, 3, 3); // 50 W (≈ position)

    // Keel: swept fin and 50 kg lead bulb, bulb centre 0.90 m below the waterline.
    const lead = kit.std(0x6d7378, { roughness: 0.4, metalness: 0.5 });
      const bulbY = K.wl - KAYAK.ballastDepth;
    kit.mesh(kit.foil(0.25, 0.25, 1.32, 1.32 + (0.05 - (bulbY + 0.03)) * Math.tan((20 * Math.PI) / 180), 0.05, bulbY + 0.03, 0.1), g10, g);
    kit.bulb(g, lead, 0.55, 0.125, 0.4, 1.4, bulbY, 0);

    const rp = new THREE.Group();
    rp.name = "rudder_pivot"; // turned by the gear about its stock
    rp.position.x = 2.91;
    g.add(rp);
    kit.mesh(kit.foil(0.2, 0.17, 2.86, 2.9, 0.06, -0.3, 0.12), kit.std(0x2b2f33), rp).position.x = -2.91;
    // Deck kit: AIS whip, all-round light, Globalstar beacon, tow eye.
    const white = kit.std(0xf4f4f0);
    const black = kit.std(0x222426);
    const aftDeck = deckY(3.0, 0.11);
    kit.cyl(g, black, 0.012, 3.0, aftDeck, aftDeck + 0.06, 0.11);
    kit.cyl(g, white, 0.005, 3.0, aftDeck + 0.06, aftDeck + 0.95, 0.11);
    kit.cyl(g, black, 0.008, 3.0, aftDeck, aftDeck + 0.2, -0.11);
    kit.cyl(g, kit.std(0xffffff, { emissive: 0xfff3c4, emissiveIntensity: 0.6 }), 0.022, 3.0, aftDeck + 0.2, aftDeck + 0.25, -0.11);
    const gsY = deckY(0.3, 0);
    kit.box(g, kit.std(0xf2c200), 0.255, 0.345, gsY, gsY + 0.028, -0.035, 0.035);
    kit.box(g, kit.std(0x24324a, { metalness: 0.3 }), 0.265, 0.335, gsY + 0.028, gsY + 0.03, -0.028, 0.028);
    const eye = kit.mesh(new THREE.TorusGeometry(0.03, 0.007, 8, kit.detail.round), guard, g);
    eye.position.set(0.03, 0.31, 0);

  }

  // Rudder (≈) and two T200 thrusters 0.40 m apart either side of it (≈ position).
  const props: THREE.Group[] = [];
  const t200 = kit.std(0x1d1f22, { roughness: 0.4 });
  const blade = kit.std(0x2a6fdb);
  for (const z of [0.2, -0.2]) {
    const th = new THREE.Group();
    th.name = z > 0 ? "thruster_port" : "thruster_starboard"; // builder z is to port
    th.position.set(2.8, -0.07, z);
    g.add(th);
    const body = kit.mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.11, kit.detail.round), t200, th);
    body.rotation.z = Math.PI / 2;
    const shroud = kit.mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.07, kit.detail.round, 1, true), t200, th);
    shroud.rotation.z = Math.PI / 2;
    shroud.position.x = 0.02;
    const prop = new THREE.Group();
    prop.position.x = 0.03;
    th.add(prop);
    props.push(prop);
    for (let k = 0; k < 3; k++) {
      const bl = kit.mesh(new THREE.BoxGeometry(0.008, 0.046, 0.018), blade, prop);
      bl.rotation.x = (k * 2 * Math.PI) / 3;
      bl.position.y = 0.024 * Math.cos((k * 2 * Math.PI) / 3);
      bl.position.z = 0.024 * Math.sin((k * 2 * Math.PI) / 3);
      bl.rotation.y = 0.5;
    }
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2 + Math.PI / 4;
      kit.rod(th, guard, 0.0025, [-0.06, 0.055 * Math.cos(a), 0.055 * Math.sin(a)], [0.09, 0.055 * Math.cos(a), 0.055 * Math.sin(a)]);
    }
    const sy = K.kz(2.8 / K.L) + 0.13;
    kit.rod(th, g10, 0.008, [0, 0.03, 0], [0, sy + 0.07, -z * 0.35]);
  }

  // Builder frame: z is to port. Deck height for placing the light and signs.
  const kDeck = (x: number) => K.dz(x / K.L) + K.crown;
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Its navigation light: the all-round white lantern on deck, under the comms light.
  addNavLights(g, "all_round", V(3.0, kDeck(3.0) + 0.2, -0.11));
  const gear = new Gear(g, {
    props, // port first
    light: V(3.0, kDeck(3.0) + 0.27, -0.11), // on top of the all-round light
    spots: {
      thruster_port: V(2.8, 0.02, 0.24),
      thruster_starboard: V(2.8, 0.02, -0.24),
      rudder: V(2.98, -0.08, 0),
      entangled: V(2.6, -0.2, 0),
      electronics_main: V(1.2, 0.72, 0), // the two boxes inside the dome
      electronics_safe: V(1.9, 0.72, 0),
      leak_main_tub: V(1.2, 0.3, 0.44),
      leak_safe_tub: V(1.9, 0.3, 0.44),
      beacon: V(0.3, kDeck(0.3) + 0.14, 0),
      comms_silent: V(3.0, kDeck(3.0) + 0.45, -0.11),
    },
    smoky: ["electronics_main", "electronics_safe"],
  });

  return {
    spec: KAYAK,
    root,
    stern: new THREE.Vector3(KAYAK.cgX - K.L, KAYAK.cgBelowWaterline, 0),
    tagHeight: 1.3 + KAYAK.cgBelowWaterline,
    gear,
    form: K,
    animate: (t) => gear.update(idleGear(t), t),
    dispose: () => {
      gear.dispose();
      kit.dispose();
      disposeNavLights(root);
    },
  };
}

// =====================================================================
// RANDOLPH DRONE. Every number from their build-files/source/design.py (mm -> m); Rev C3
// (11 Nov 2026): fibreglass stern post and counterweight arm, YB3 off the post (Boatyard dress).
// =====================================================================
export function buildRandolph(quality: Quality): BoatModel {
  const kit = new Kit(quality);
  const R: HullForm = {
    L: RANDOLPH.length,
    n: 2.2,
    crown: 0.006,
    wl: RANDOLPH.waterline,
    hb: (s) => (s <= 0.55 ? 0.2 * Math.pow(Math.max(1 - (1 - s / 0.55) ** 2, 0), 0.6) : 0.2 - 0.05 * ((s - 0.55) / 0.45) ** 2),
    kz: (s) => (s < 0.5 ? 0.12 * Math.pow(Math.max(1 - s / 0.5, 0), 2.2) : 0.06 * ((s - 0.5) / 0.5) ** 2),
    dz: (s) => 0.23 + 0.03 * Math.max(1 - s / 0.4, 0) ** 2,
  };
  const { root, inner: g } = frame(RANDOLPH);
  if (randolphDetailed) {
    // Our Blender model of their boat; the wing and the wind vane hang under named pivots.
    const m = randolphDetailed.clone(true);
    g.add(m);
  } else {
    const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.02, side: THREE.DoubleSide }));
    kit.mesh(kit.hull(R, { top: 0xf1f3f4, deck: 0xdfe5e8, bottom: 0x2e5566, boot: 0x0f8a8a }), hullMat, g);
    const rDeck = (x: number, z: number) => {
      const s = x / R.L;
      const b = R.hb(s);
      return R.dz(s) + R.crown * (1 - Math.min((z / b) ** 2, 1));
    };

    // Keel fin (root 170, tip 150 mm chord, 430 mm deep) and 8.2 kg lead bulb.
    kit.mesh(kit.foil(0.17, 0.15, 0.657, 0.67, 0.02, -0.43, 0.12), kit.std(0x30373c), g);
    kit.bulb(g, kit.std(0x6d7378, { roughness: 0.4, metalness: 0.5 }), 0.32, 0.068, 0.4, 0.579, -0.434, 0);
    // Rudder, stock at x = 1400.
    const rp = new THREE.Group();
    rp.name = "rudder_pivot";
    rp.position.x = 1.4;
    g.add(rp);
    kit.mesh(kit.foil(0.12, 0.12, 1.378, 1.378, 0.05, -0.19, 0.12), kit.std(0x30373c), rp).position.x = -1.4;
    // Two solar panels on the aft deck.
    kit.panel(g, 0.65, 1.07, 0.28, rDeck, 4, 2);
    kit.panel(g, 1.08, 1.48, 0.28, rDeck, 4, 2);
    // Hatch.
    kit.box(g, kit.std(0xc9d2d6), 0.33, 0.53, rDeck(0.43, 0) - 0.002, rDeck(0.43, 0) + 0.012, -0.11, 0.11);
    // Mast tube (2 in PVC) and bearing housing.
    const pvc = kit.std(0xe9ecee);
    const dark = kit.std(0x26292c);
    const spar = kit.std(0x2a2d31, { metalness: 0.4 });
    const glass = kit.std(0xd6d3bd, { roughness: 0.5 }); // pultruded fibreglass (Rev C3)
    kit.cyl(g, pvc, 0.03, 0.6, 0.0, 0.25);
    kit.cyl(g, dark, 0.0185, 0.6, 0.25, 0.268);
    // Rotating wing assembly: wing, spar, boom, tail flap, counterweight.
    const pivot = new THREE.Group();
    pivot.name = "wing_pivot";
    pivot.position.set(0.6, 0, 0);
    g.add(pivot);
    // Rev C5 wing (Wing_Shape_Study.md): 0.80 m span x 0.375 m chord, same area as the old 1.00 x 0.30,
    // on the spar at 22% chord as before. GUESS: the spar now stops just above the shorter wing.
    kit.mesh(kit.foil(0.375, 0.375, -0.0825, -0.0825, 0.3, 1.1, 0.15), kit.std(0xfbfbf7, { roughness: 0.45 }), pivot);
    kit.cyl(pivot, spar, 0.0125, 0, 0.05, 1.11);
    kit.rod(pivot, spar, 0.006, [0, 0.276, 0], [0.6, 0.276, 0]);
    kit.cyl(pivot, dark, 0.016, 0.6, 0.255, 0.3);
    kit.mesh(kit.foil(0.12, 0.12, 0.576, 0.576, 0.3, 0.5, 0.12), kit.std(0x0f8a8a), pivot).name = "tail_flap";
    kit.rod(pivot, glass, 0.006, [0, 0.276, 0], [-0.3, 0.276, 0]); // 12 mm solid fibreglass rod
    kit.cyl(pivot, kit.std(0x5f666b, { metalness: 0.5 }), 0.032, -0.3, 0.264, 0.338);
    // Stern pole: transom bracket, antenna platform at 560, wind vane at 650.
    kit.box(g, dark, 1.49, 1.545, 0.15, 0.2, -0.02, 0.02);
    kit.cyl(g, glass, 0.01, 1.53, 0.15, 0.65); // 20 x 2 mm fibreglass tube
    kit.cyl(g, pvc, 0.04, 1.53, 0.553, 0.567);
    kit.cyl(g, dark, 0.018, 1.53, 0.65, 0.69);
    const vane = new THREE.Group();
    vane.name = "vane_pivot";
    vane.position.set(1.53, 0.68, 0);
    g.add(vane);
    kit.rod(vane, dark, 0.004, [0, 0, 0], [0.16, 0, 0]);
    kit.box(vane, kit.std(0x0f8a8a), 0.1, 0.17, -0.03, 0.04, -0.002, 0.002);
  }

  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Its navigation light: an all-round white on the antenna platform (GUESS: where Randolph's would go).
  addNavLights(g, "all_round", V(1.53, 0.62, 0));
  const gear = new Gear(g, {
    props: [], // no motors: the wing sails it
    light: V(1.53, 0.585, 0), // on the antenna platform
    spots: {
      rudder: V(1.42, -0.06, 0),
      sail: V(0.6, 1.42, 0),
      entangled: V(0.62, -0.26, 0),
      electronics_main: V(0.43, 0.42, 0), // under the hatch
      leak_main_tub: V(0.43, 0.2, 0.24),
      beacon: V(0.18, 0.27, 0), // the YB3's foredeck well (Rev C3)
      comms_silent: V(1.53, 0.76, 0),
    },
    smoky: ["electronics_main"],
  });

  return {
    spec: RANDOLPH,
    root,
    stern: new THREE.Vector3(RANDOLPH.cgX - R.L, RANDOLPH.cgBelowWaterline, 0),
    tagHeight: 1.4 + RANDOLPH.cgBelowWaterline, // just above the Rev C5 wing
    gear,
    form: R,
    animate: (t) => gear.update(idleGear(t), t),
    dispose: () => {
      gear.dispose();
      kit.dispose();
      disposeNavLights(root);
    },
  };
}

export const BUILDERS: Record<BoatSpec["key"], (q: Quality) => BoatModel> = {
  kayak: buildKayak,
  randolph: buildRandolph,
  stock_cruiser31: (q) => buildStock("stock_cruiser31", q),
  stock_dinghy14: (q) => buildStock("stock_dinghy14", q),
  stock_beachcat16: (q) => buildStock("stock_beachcat16", q),
  stock_sail_drone7: (q) => buildStock("stock_sail_drone7", q),
  stock_ocean_rower45: (q) => buildStock("stock_ocean_rower45", q),
  stock_pearson31_2: (q) => buildStock("stock_pearson31_2", q),
};
