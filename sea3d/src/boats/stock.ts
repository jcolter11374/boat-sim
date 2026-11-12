// Theo's stock vessels in 3D: a 31 ft cruiser, a 14 ft lateen dinghy, a 16 ft
// beach cat and a 7 m wind-powered ocean drone (configs/stock_*.yaml). Generic
// boats, no makers' names. The drone's wing turns itself to the wind like Rev B's
// (wing_pivot, turned by the gear), so it has no sheets or sail plans here.
//
// Detailed models come from Blender (blender/build_stock.py, stock_<kind>.glb),
// loaded the first time a stock boat is shown; until then (or on hosts without
// them) a plain hull, mast and sails are drawn in code from the same numbers.
//
// The rig is posed from the replay, not by physics: the sails come down or
// reef with the logged sail plan, swing out to leeward with the apparent wind,
// and the belly of each sail sits on the side away from the wind.

import { addNavLights, disposeNavLights } from "./navlights";
import * as THREE from "three";
import { applyStockFinishes } from "./finishes";
import { DACRON, clotheSails, tickSails } from "./sailcloth";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Gear, idleGear } from "./gear";
import { Kit, type HullForm, type Quality } from "./parts";
import { BEACHCAT, CRUISER, DINGHY, OCEAN_ROWER, PEARSON, SAIL_DRONE, STOCK, type StockKey } from "./specs";

/** The Blender file each one is built into (sea3d.yml). */
const FILE: Record<StockKey, string> = {
  stock_cruiser31: "stock_cruiser",
  stock_dinghy14: "stock_dinghy",
  stock_beachcat16: "stock_beachcat",
  stock_sail_drone7: "stock_drone",
  stock_ocean_rower45: "stock_rower",
  stock_pearson31_2: "stock_pearson",
};

/** Sail sizes for each plan, as fractions of full (configs' vpp.plans). Anything
 * else, including "down", shows bare poles. */
const PLANS: Record<StockKey, Record<string, { main: number; jib: number }>> = {
  stock_cruiser31: {
    full: { main: 1, jib: 1 },
    reef1: { main: 0.82, jib: 0.7 },
    reef2: { main: 0.64, jib: 0.45 },
    storm: { main: 0.45, jib: 0.18 },
  },
  stock_dinghy14: { full: { main: 1, jib: 0 } },
  stock_beachcat16: { full: { main: 1, jib: 1 }, main_only: { main: 1, jib: 0 } },
  stock_sail_drone7: {},
  stock_ocean_rower45: {},
  stock_pearson31_2: {
    full: { main: 1, jib: 1 },
    reef1: { main: 0.82, jib: 0.7 },
    reef2: { main: 0.64, jib: 0.45 },
    storm: { main: 0.45, jib: 0.18 },
  },
};

// ---------------------------------------------------------------- hull shapes ----
// The same functions as blender/build_stock.py (builder frame: x aft from the bow,
// y up from the hull bottom; half-beams in metres).
const pos = (x: number) => Math.max(x, 0);
const CRUISER_FORM: HullForm = {
  L: 9.45,
  n: 2.3,
  crown: 0.05,
  wl: CRUISER.waterline,
  hb: (s) => (s <= 0.56 ? 1.6 * pos(1 - (1 - s / 0.56) ** 2) ** 0.62 : 1.6 - (1.6 - 1.32) * ((s - 0.56) / 0.44) ** 2),
  kz: (s) => 0.62 * pos(1 - s / 0.2) ** 2 + 0.36 * pos((s - 0.72) / 0.28) ** 1.8,
  dz: (s) => 1.5 - 0.28 * s + 0.12 * pos(1 - s / 0.15) ** 2,
};
// Randolph's Pearson 31-2: raked bow overhang, short counter, fullest just aft of the middle.
const PEARSON_FORM: HullForm = {
  L: 9.39,
  n: 2.1,
  crown: 0.06,
  wl: PEARSON.waterline,
  hb: (s) => (s <= 0.55 ? 1.645 * pos(1 - (1 - s / 0.55) ** 2) ** 0.6 : 1.645 - (1.645 - 1.22) * ((s - 0.55) / 0.45) ** 2),
  kz: (s) => 1.3 * pos(1 - s / 0.25) ** 2 + 0.75 * pos((s - 0.68) / 0.32) ** 1.6,
  dz: (s) => 1.62 - 0.3 * s + 0.14 * pos(1 - s / 0.18) ** 2,
};
const DINGHY_FORM: HullForm = {
  L: 4.2,
  n: 5,
  crown: 0.025,
  wl: DINGHY.waterline,
  hb: (s) => (s <= 0.5 ? 0.6 * pos(1 - (1 - s / 0.5) ** 2.2) ** 0.55 : 0.6 - (0.6 - 0.46) * ((s - 0.5) / 0.5) ** 2),
  kz: (s) => 0.12 * pos(1 - s / 0.3) ** 2,
  dz: (s) => 0.3 + 0.04 * pos(1 - s / 0.2) ** 2,
};
/** One of the cat's two hulls (they sit 1.05 m either side of the centreline). */
const CAT_HULL: HullForm = {
  L: 4.9,
  n: 2,
  crown: 0.06,
  wl: BEACHCAT.waterline,
  hb: (s) => (s <= 0.42 ? 0.2 * pos(1 - (1 - s / 0.42) ** 2) ** 0.6 : 0.2 - (0.2 - 0.12) * ((s - 0.42) / 0.58) ** 2),
  kz: (s) => 0.3 * pos(1 - s / 0.3) ** 2 + 0.08 * pos((s - 0.8) / 0.2) ** 2,
  dz: (s) => 0.55 - 0.08 * s,
};
const CAT_HALF_GAP = 1.05;
const DRONE_FORM: HullForm = {
  L: 7.0,
  n: 2.6,
  crown: 0.06,
  wl: SAIL_DRONE.waterline,
  hb: (s) => (s <= 0.45 ? 0.45 * pos(1 - (1 - s / 0.45) ** 2) ** 0.95 : 0.45 - (0.45 - 0.3) * ((s - 0.45) / 0.55) ** 2),
  kz: (s) => 0.3 * pos(1 - s / 0.25) ** 2 + 0.12 * pos((s - 0.85) / 0.15) ** 2,
  dz: (s) => 0.72 - 0.08 * s + 0.1 * pos(1 - s / 0.12) ** 2,
};
const ROWER_FORM: HullForm = {
  L: 8.64,
  n: 3.2,
  crown: 0.03,
  wl: OCEAN_ROWER.waterline,
  hb: (s) => (s <= 0.33 ? 0.87 * pos(1 - (1 - s / 0.33) ** 2) ** 0.75 : s <= 0.78 ? 0.87 : 0.87 - (0.87 - 0.62) * ((s - 0.78) / 0.22) ** 1.6),
  kz: (s) => 0.24 * pos(1 - s / 0.2) ** 2 + 0.06 * pos((s - 0.9) / 0.1) ** 2,
  dz: (s) => 0.7 + 0.14 * pos(1 - s / 0.22) ** 2 + 0.04 * pos((s - 0.88) / 0.12),
};
const deckY = (f: HullForm, x: number) => f.dz(x / f.L) + f.crown;

// ------------------------------------------------------------- detailed models ----
const detailed = new Map<StockKey, THREE.Group | null>();
const loading = new Map<StockKey, Promise<boolean>>();

/** Load a stock boat's Blender model; true once it is there (build the boat again then). */
export function loadStockModel(key: StockKey, base = "./models"): Promise<boolean> {
  if (new URLSearchParams(location.search).get("models") === "simple") return Promise.resolve(false);
  let p = loading.get(key);
  if (!p) {
    p = (async () => {
      for (const file of [`${FILE[key]}.glb`, `${FILE[key]}.json`]) {
        try {
          const g = (await new GLTFLoader().loadAsync(`${base}/${file}`)).scene;
          g.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh && /^(sail|batten)/.test(o.name)) {
              // Sails are thin sheets seen from both sides, and mirrored on the other tack.
              for (const mat of Array.isArray(m.material) ? m.material : [m.material]) mat.side = THREE.DoubleSide;
            }
          });
          applyStockFinishes(g, key); // gelcoat, bottom paint, non-skid (shared by every copy)
          detailed.set(key, g);
          return true;
        } catch {
          // try the next one
        }
      }
      detailed.set(key, null);
      return false;
    })();
    loading.set(key, p);
  }
  return p;
}
export const hasDetailedStock = (key: StockKey) => !!detailed.get(key);

// ------------------------------------------------------------------- the rig ----
export interface RigState {
  /** Air flow over the boat (apparent wind), m/s, boat frame: x to the bow, z to starboard. */
  flow: { x: number; z: number };
  /** The replay's sail plan ("full", "reef1", ..., "down"); null when the log has none. */
  plan: string | null;
  /** The rudder angle the gear is showing, rad. */
  rudder: number;
}

interface Piece {
  obj: THREE.Object3D;
  pos: THREE.Vector3;
  scale: THREE.Vector3;
  /** The point it shrinks towards (its own frame): the foot for a main, the tack for a jib. */
  anchor: THREE.Vector3;
}

/** Sheets, reefs and steers a stock boat's model by name. */
export class StockRig {
  /** What the rig is showing (for the smoke test). */
  readonly shown = { boom: 0, main: 1, jib: 1, plan: "" };
  private readonly main: THREE.Object3D | null;
  private readonly jib: THREE.Object3D | null;
  private readonly mains: Piece[] = [];
  private readonly jibs: Piece[] = [];
  private readonly rudders: THREE.Object3D[] = [];
  private boom = 0;
  private t = 0;

  constructor(
    readonly key: StockKey,
    g: THREE.Object3D,
  ) {
    this.main = g.getObjectByName("main_pivot") ?? null;
    this.jib = g.getObjectByName("jib_pivot") ?? null;
    const piece = (o: THREE.Object3D, foot: boolean): Piece => {
      const box = new THREE.Box3();
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.geometry.computeBoundingBox();
        box.copy(m.geometry.boundingBox!);
      } else box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
      const anchor = foot ? new THREE.Vector3(0, box.min.y, 0) : new THREE.Vector3(box.min.x, box.min.y, 0);
      return { obj: o, pos: o.position.clone(), scale: o.scale.clone(), anchor };
    };
    this.main?.traverse((o) => {
      if (/^(sail_main|sail_band|batten)/.test(o.name)) this.mains.push(piece(o, true));
    });
    this.jib?.traverse((o) => {
      if (/^sail_jib/.test(o.name)) this.jibs.push(piece(o, false));
    });
    // The cat steers with a rudder on each hull; the gear turns the one called rudder_pivot.
    for (const n of ["rudder_pivot_s", "rudder_pivot_p"]) {
      const r = g.getObjectByName(n);
      if (r) this.rudders.push(r);
    }
  }

  update(dt: number, s: RigState): void {
    this.t += dt;
    tickSails(dt);
    const plan = s.plan ?? "full";
    const size = PLANS[this.key][plan] ?? { main: 0, jib: 0 };
    this.shown.plan = plan;
    this.shown.main = size.main;
    this.shown.jib = size.jib;
    this.size(this.mains, size.main, true);
    this.size(this.jibs, size.jib, false);

    // Apparent wind angle off the bow (0 = dead ahead, pi = dead astern).
    const from = { x: -s.flow.x, z: -s.flow.z };
    const speed = Math.hypot(from.x, from.z);
    const awa = speed < 0.3 ? Math.PI / 2 : Math.atan2(Math.abs(from.z), from.x);
    // Sheeted in close on a beat, eased out as the wind comes aft (about half the
    // wind angle less 10 deg), never past 80 deg. Wind from port (air moving to
    // starboard) puts the boom out to starboard: + about the builder y axis.
    const awaDeg = THREE.MathUtils.radToDeg(awa);
    let want = THREE.MathUtils.degToRad(THREE.MathUtils.clamp(awaDeg / 2 - 10, 4, 80));
    if (awaDeg < 28 && size.main > 0) want = THREE.MathUtils.degToRad(3) * Math.sin(this.t * 7); // head to wind: flogging
    const side = s.flow.z >= 0 ? 1 : -1;
    want *= side;
    const d = want - this.boom;
    // A gybe (the boom crossing) is quick; trimming is slow.
    this.boom += d * Math.min(1, dt * (Math.abs(d) > 0.6 ? 2.5 : 0.8));
    this.shown.boom = this.boom;
    if (this.main) {
      this.main.rotation.y = this.boom;
      // The sails are built bellied to port (builder +z); mirror them on the other tack.
      this.main.scale.z = this.boom > 0 ? -1 : 1;
    }
    if (this.jib) {
      this.jib.rotation.y = this.boom * 0.7;
      this.jib.scale.z = this.boom > 0 ? -1 : 1;
    }
    for (const r of this.rudders) r.rotation.y = s.rudder;
  }

  /** Reef (main: lower the head towards the boom) or furl (jib: shrink towards the tack). */
  private size(pieces: Piece[], f: number, foot: boolean): void {
    for (const p of pieces) {
      p.obj.visible = f > 0.01;
      if (!p.obj.visible) continue;
      if (foot) {
        p.obj.scale.set(p.scale.x, p.scale.y * f, p.scale.z);
        p.obj.position.set(p.pos.x, p.pos.y + p.anchor.y * p.scale.y * (1 - f), p.pos.z);
      } else {
        const k = Math.sqrt(f); // area -> size
        p.obj.scale.copy(p.scale).multiplyScalar(k);
        p.obj.position.set(p.pos.x + p.anchor.x * p.scale.x * (1 - k), p.pos.y + p.anchor.y * p.scale.y * (1 - k), p.pos.z);
      }
    }
  }
}

// ----------------------------------------------------------- drawn-in-code boats ----
const SAIL = DACRON;
/** A sail between three corners (builder frame) with camber, as blender/build_stock.py sail():
 * the chord bellies out to builder +z, deepest about 40% back, flatter towards the head.
 * UVs: u luff (0) to leech (1), v foot (0) to head (1), for the sailcloth's seams and luff. */
function triangle(kit: Kit, parent: THREE.Object3D, name: string, a: number[], b: number[], c: number[], depth = 0.07): THREE.Mesh {
  const [tack, head, clew] = [a, b, c].map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const nrm = new THREE.Vector3().crossVectors(head.clone().sub(tack), clew.clone().sub(tack)).normalize();
  if (nrm.z < 0) nrm.negate();
  const n = 12;
  const m = 8;
  const pos: number[] = [];
  const uv: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const luff = tack.clone().lerp(head, t);
    const leech = clew.clone().lerp(head, t);
    const chord = luff.distanceTo(leech);
    for (let j = 0; j <= m; j++) {
      const u = j / m;
      const bulge = Math.sin(Math.PI * u ** 0.8) * depth * chord * (1 - 0.55 * t);
      const p = luff.clone().lerp(leech, u).addScaledVector(nrm, bulge);
      pos.push(p.x, p.y, p.z);
      uv.push(u, t);
    }
  }
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const k = i * (m + 1) + j;
      idx.push(k, k + 1, k + m + 2, k, k + m + 2, k + m + 1);
    }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = kit.mesh(geo, kit.std(SAIL, { roughness: 0.8, side: THREE.DoubleSide }), parent);
  mesh.name = name;
  return mesh;
}
function pivot(parent: THREE.Object3D, name: string, x: number, y: number, z = 0): THREE.Group {
  const p = new THREE.Group();
  p.name = name;
  p.position.set(x, y, z);
  parent.add(p);
  return p;
}

function drawCruiser(kit: Kit, g: THREE.Group): void {
  const f = CRUISER_FORM;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.02, side: THREE.DoubleSide }));
  kit.mesh(kit.hull(f, { top: 0xf4f3ef, deck: 0xe8e5dc, bottom: 0x23344f, boot: 0x1d2f4d }), hullMat, g);
  const lead = kit.std(0x4c5258, { metalness: 0.4 });
  kit.mesh(kit.foil(1.35, 0.9, 3.55, 3.95, 0.25, -1.12, 0.11), lead, g);
  kit.box(g, lead, 3.45, 5.05, -1.32, -0.98, -0.2, 0.2);
  const rp = pivot(g, "rudder_pivot", 8.55, 0.3);
  kit.mesh(kit.foil(0.62, 0.38, 8.45, 8.6, 0.3, -1.0, 0.12), kit.std(0x2a2e33), rp).position.set(-8.55, -0.3, 0);
  const cab = kit.std(0xf1f0ec);
  kit.box(g, cab, 2.75, 6.05, deckY(f, 4) - 0.02, deckY(f, 3.3) + 0.5, -0.98, 0.98);
  const alu = kit.std(0xc9ced3, { metalness: 0.7, roughness: 0.3 });
  const ym = deckY(f, 3.35) + 0.48;
  kit.cyl(g, alu, 0.07, 3.35, ym, ym + 12.4);
  const mp = pivot(g, "main_pivot", 3.35, ym);
  kit.rod(mp, alu, 0.05, [0.09, 0.95, 0], [4.0, 0.95, 0]);
  triangle(kit, mp, "sail_main", [0.1, 1.0, 0], [0.08, 12.05, 0], [3.92, 1.0, 0]);
  const bow = [0.18, deckY(f, 0.18) + 0.05, 0];
  const jp = pivot(g, "jib_pivot", bow[0], bow[1]);
  triangle(kit, jp, "sail_jib", [0.12, 0.37, 0], [3.35 - 0.25 - bow[0], ym + 11.5 - bow[1], 0], [4.77, deckY(f, 4.95) + 0.55 - bow[1], 0]);
}

function drawPearson(kit: Kit, g: THREE.Group): void {
  const f = PEARSON_FORM;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.02, side: THREE.DoubleSide }));
  kit.mesh(kit.hull(f, { top: 0xf6f5f0, deck: 0xe9e6dd, bottom: 0x2b3a55, boot: 0x1a2a4a }), hullMat, g);
  const bottom = kit.std(0x2b3a55);
  kit.mesh(kit.foil(1.65, 0.85, 3.55, 4.05, 0.2, -1.1, 0.12), bottom, g);
  const rp = pivot(g, "rudder_pivot", 8.2, 0.42);
  kit.mesh(kit.foil(0.62, 0.36, 8.08, 8.24, 0.42, -0.95, 0.12), bottom, rp).position.set(-8.2, -0.42, 0);
  const cab = kit.std(0xf2f1ec);
  kit.box(g, cab, 2.55, 6.2, deckY(f, 4.4) - 0.02, deckY(f, 3.25) + 0.46, -1.05, 1.05);
  const alu = kit.std(0xc9ced3, { metalness: 0.7, roughness: 0.3 });
  const mx = 4.06;
  const ym = deckY(f, mx) + 0.44;
  const mh = f.wl + 14.11 - ym;
  kit.cyl(g, alu, 0.075, mx, ym, ym + mh);
  const mp = pivot(g, "main_pivot", mx, ym);
  kit.rod(mp, alu, 0.05, [0.09, 1.15, 0], [3.66, 1.15, 0]);
  triangle(kit, mp, "sail_main", [0.1, 1.2, 0], [0.08, 12.37, 0], [3.58, 1.2, 0]);
  const bow = [0.16, deckY(f, 0.16) + 0.05, 0];
  const jp = pivot(g, "jib_pivot", bow[0], bow[1]);
  triangle(kit, jp, "sail_jib", [0.14, 0.35, 0], [mx - 0.25 - bow[0], ym + mh - 0.9 - bow[1], 0], [5.27 - bow[0], deckY(f, 5.4) + 0.55 - bow[1], 0]);
}

function drawDinghy(kit: Kit, g: THREE.Group): void {
  const f = DINGHY_FORM;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.02, side: THREE.DoubleSide }));
  kit.mesh(kit.hull(f, { top: 0xf5f4ef, deck: 0xf0efea, bottom: 0xedebe6, boot: 0x2c6fb5 }), hullMat, g);
  const g10 = kit.std(0x2a2e33);
  kit.mesh(kit.foil(0.3, 0.26, 1.48, 1.52, 0.2, -0.75, 0.1), g10, g);
  const rp = pivot(g, "rudder_pivot", f.L - 0.02, 0.2);
  const r = kit.mesh(kit.foil(0.24, 0.18, f.L - 0.02, f.L + 0.02, 0.28, -0.42, 0.1), g10, rp);
  r.position.set(-(f.L - 0.02), -0.2, 0);
  const alu = kit.std(0xc9ced3, { metalness: 0.7, roughness: 0.3 });
  const ym = deckY(f, 1.05);
  kit.cyl(g, alu, 0.035, 1.05, ym - 0.2, ym + 2.0);
  const mp = pivot(g, "main_pivot", 1.05, ym);
  const tack = [0.55 - 1.05, 0.42, 0];
  const clew = [3.95 - 1.05, 0.5, 0];
  const peak = [2.35 - 1.05, 4.5, 0];
  kit.rod(mp, alu, 0.025, tack, clew);
  kit.rod(mp, alu, 0.025, tack, peak);
  triangle(kit, mp, "sail_main", tack, peak, clew);
}

function drawCat(kit: Kit, g: THREE.Group): void {
  const f = CAT_HULL;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.02, side: THREE.DoubleSide }));
  const geo = kit.hull(f, { top: 0xf4f4f0, deck: 0xecebe6, bottom: 0xf0efea, boot: 0xd8432b });
  for (const z of [CAT_HALF_GAP, -CAT_HALF_GAP]) kit.mesh(geo, hullMat, g).position.z = z;
  const alu = kit.std(0xc9ced3, { metalness: 0.7, roughness: 0.3 });
  const yd = f.dz(0.3) + 0.02;
  for (const x of [1.45, 3.65]) kit.rod(g, alu, 0.045, [x, yd, -CAT_HALF_GAP - 0.06], [x, yd, CAT_HALF_GAP + 0.06]);
  kit.box(g, kit.std(0x24282d, { roughness: 0.85 }), 1.47, 3.63, yd, yd + 0.01, -CAT_HALF_GAP + 0.12, CAT_HALF_GAP - 0.12);
  kit.cyl(g, alu, 0.06, 1.45, yd, yd + 8.3);
  const jp = pivot(g, "jib_pivot", 0.75, yd + 0.1);
  triangle(kit, jp, "sail_jib", [0.05, 0.12, 0], [0.55, 8.3 * 0.72 - 0.22, 0], [1.5, 0.32, 0]);
  const mp = pivot(g, "main_pivot", 1.45, yd);
  kit.rod(mp, alu, 0.035, [0.05, 0.45, 0], [2.9, 0.45, 0]);
  triangle(kit, mp, "sail_main", [0.07, 0.5, 0], [0.05, 8.22, 0], [2.85, 0.5, 0]);
  for (const [name, z] of [
    ["rudder_pivot_p", CAT_HALF_GAP],
    ["rudder_pivot_s", -CAT_HALF_GAP],
  ] as const) {
    const rp = pivot(g, name, f.L - 0.03, 0.25, z);
    const r = kit.mesh(kit.foil(0.26, 0.2, f.L - 0.03, f.L, 0.32, -0.55, 0.1), kit.std(0x2a2e33), rp);
    r.position.set(-(f.L - 0.03), -0.25, 0);
  }
}

function drawDrone(kit: Kit, g: THREE.Group): void {
  const f = DRONE_FORM;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.02, side: THREE.DoubleSide }));
  kit.mesh(kit.hull(f, { top: 0x3a4756, deck: 0xdadde0, bottom: 0x262a2f, boot: 0xf2b33d }), hullMat, g);
  const lead = kit.std(0x3b3f44, { metalness: 0.3 });
  kit.mesh(kit.foil(1.0, 0.7, 2.3, 2.55, 0.15, -1.45, 0.1), lead, g);
  kit.box(g, lead, 2.15, 3.65, -1.7, -1.4, -0.15, 0.15);
  const rp = pivot(g, "rudder_pivot", 6.55, 0.2);
  kit.mesh(kit.foil(0.5, 0.36, 6.45, 6.55, 0.2, -0.9, 0.12), kit.std(0xeeede8), rp).position.set(-6.55, -0.2, 0);
  const wx = 2.6;
  const y0 = deckY(f, wx) + 0.25;
  const wp = pivot(g, "wing_pivot", wx, 0);
  const wing = kit.mesh(kit.foil(1.15, 0.85, wx - 0.3, wx - 0.2, y0, y0 + 5, 0.14), kit.std(0xf5f5f1, { roughness: 0.4 }), wp);
  wing.position.x = -wx;
  const alu = kit.std(0xb9bec4, { metalness: 0.7, roughness: 0.3 });
  const by = y0 + 0.55;
  kit.rod(wp, alu, 0.022, [0.75, by, 0], [2.6, by, 0]);
  kit.box(wp, kit.std(0xf5f5f1), 2.56, 2.96, by - 0.55, by + 0.75, -0.025, 0.025);
}

function drawRower(kit: Kit, g: THREE.Group): void {
  const f = ROWER_FORM;
  const hullMat = kit.keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.02, side: THREE.DoubleSide }));
  kit.mesh(kit.hull(f, { top: 0xf4f4f1, deck: 0x8e949a, bottom: 0xe4e6e6, boot: 0x2f6fa8 }), hullMat, g);
  const gel = kit.std(0xf6f6f3, { roughness: 0.3 });
  const yd = (x: number) => deckY(f, x);
  kit.box(g, gel, 0.6, 2.3, yd(1.5) - 0.05, yd(1.5) + 0.72, -0.6, 0.6); // bow cabin
  kit.box(g, gel, 5.0, 8.1, yd(6.5) - 0.05, yd(6.5) + 0.98, -0.74, 0.74); // stern cabin
  const alu = kit.std(0xb9bec4, { metalness: 0.7, roughness: 0.3 });
  for (const x of [3.3, 4.6])
    for (const z of [1, -1]) kit.rod(g, alu, 0.02, [x, yd(x) + 0.3, z * 0.85], [x, yd(x) + 0.12, z * 3.1]);
  const rp = pivot(g, "rudder_pivot", 8.62, 0.3);
  kit.mesh(kit.foil(0.36, 0.3, 8.59, 8.62, -0.25, 0.42, 0.1), kit.std(0xeeede8), rp).position.set(-8.62, -0.3, 0);
}

const DRAW: Record<StockKey, (kit: Kit, g: THREE.Group) => void> = {
  stock_cruiser31: drawCruiser,
  stock_dinghy14: drawDinghy,
  stock_beachcat16: drawCat,
  stock_sail_drone7: drawDrone,
  stock_ocean_rower45: drawRower,
  stock_pearson31_2: drawPearson,
};
const FORM: Record<StockKey, HullForm> = {
  stock_cruiser31: CRUISER_FORM,
  stock_dinghy14: DINGHY_FORM,
  stock_beachcat16: CAT_HULL,
  stock_sail_drone7: DRONE_FORM,
  stock_ocean_rower45: ROWER_FORM,
  stock_pearson31_2: PEARSON_FORM,
};
/** Name tag height above the waterline: the masthead (the drone's wing tip, the rower's light pole). */
/** Where the masthead lantern stands along the boat (builder x, m from the bow): the mast (the drone's sensor mast, the rower's light pole). */
const LANTERN_X: Record<StockKey, number> = { stock_cruiser31: 3.35, stock_dinghy14: 1.05, stock_beachcat16: 1.45, stock_sail_drone7: 2.6, stock_ocean_rower45: 7.7, stock_pearson31_2: 4.06 };
const MAST_TOP: Record<StockKey, number> = { stock_cruiser31: 13.9, stock_dinghy14: 4.8, stock_beachcat16: 8.5, stock_sail_drone7: 5.8, stock_ocean_rower45: 2.4, stock_pearson31_2: 14.11 };

/** A stock boat as a BoatModel (boats/model.ts), with its rig. */
export function buildStock(key: StockKey, quality: Quality) {
  const spec = STOCK[key];
  const form = FORM[key];
  const kit = new Kit(quality);
  const root = new THREE.Group();
  root.name = spec.key;
  const g = new THREE.Group();
  g.rotation.y = Math.PI; // builder x (aft) -> -x, so the bow points to +x
  g.position.set(spec.cgX, spec.cgBelowWaterline - spec.waterline, 0);
  root.add(g);
  const model = detailed.get(key);
  if (model) g.add(model.clone(true));
  else DRAW[key](kit, g);
  // Sailcloth, one material per sail on this copy (each has its own luff flutter).
  clotheSails(g);
  const sailMats: THREE.Material[] = [];
  g.traverse((o) => {
    const mat = (o as THREE.Mesh).material as THREE.Material | undefined;
    if (mat && !Array.isArray(mat) && mat.userData.sailcloth) sailMats.push(mat);
  });
  const rig = new StockRig(key, g);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  // Navigation lights: a tricolour lantern at the masthead (or the rower's light pole).
  // The detailed models name the lamp; the drawn-in-code ones use the mast's place.
  const lamp = g.getObjectByName("masthead_light");
  let at: THREE.Vector3;
  if (lamp) {
    g.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(lamp);
    at = g.worldToLocal(box.getCenter(new THREE.Vector3()).setY(box.max.y)).add(V(0, 0.04, 0));
  } else at = V(LANTERN_X[key], MAST_TOP[key] + form.wl, key === "stock_ocean_rower45" ? 0.25 : 0);
  addNavLights(g, "tricolour", at);
  const deck = form.dz(0.5) + 0.3;
  const gear = new Gear(g, {
    props: [],
    light: V(spec.length * 0.98, deck + 0.4, 0),
    spots: {
      rudder: V(spec.length - 0.05, form.wl, 0),
      sail: V(form.L * 0.35, MAST_TOP[key] * 0.6, 0),
      electronics_main: V(form.L * 0.55, deck, 0),
      leak_main_tub: V(form.L * 0.5, form.wl, 0),
      beacon: V(form.L * 0.9, deck, 0),
      comms_silent: V(form.L * 0.9, deck + 0.3, 0),
    },
    smoky: ["electronics_main"],
  });
  // The wake starts at the transom (the cat's: between its sterns).
  const stern = new THREE.Vector3(spec.cgX - form.L, spec.cgBelowWaterline, 0);
  return {
    spec,
    root,
    stern,
    tagHeight: MAST_TOP[key] + spec.cgBelowWaterline,
    gear,
    form,
    rig,
    /** Two hulls: the page's foam collar and deck drain follow one centred hull, so skip them. */
    twinHull: key === "stock_beachcat16",
    animate: (t: number) => {
      const s = idleGear(t);
      gear.update(s, t);
      rig.update(1 / 60, { flow: s.flow, plan: "full", rudder: gear.shown.rudder });
    },
    dispose: () => {
      gear.dispose();
      kit.dispose();
      for (const m of sailMats) m.dispose();
      disposeNavLights(root);
    },
  };
}
