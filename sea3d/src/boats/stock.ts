// Theo's stock vessels in 3D: a 31 ft cruiser, a 14 ft lateen dinghy and a
// 16 ft beach cat (configs/stock_*.yaml). Generic boats, no makers' names.
//
// Detailed models come from Blender (blender/build_stock.py, stock_<kind>.glb),
// loaded the first time a stock boat is shown; until then (or on hosts without
// them) a plain hull, mast and sails are drawn in code from the same numbers.
//
// The rig is posed from the replay, not by physics: the sails come down or
// reef with the logged sail plan, swing out to leeward with the apparent wind,
// and the belly of each sail sits on the side away from the wind.

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { Gear, idleGear } from "./gear";
import { Kit, type HullForm, type Quality } from "./parts";
import { BEACHCAT, CRUISER, DINGHY, type BoatSpec, type StockKey } from "./specs";

/** The Blender file each one is built into (sea3d.yml). */
const FILE: Record<StockKey, string> = {
  stock_cruiser31: "stock_cruiser",
  stock_dinghy14: "stock_dinghy",
  stock_beachcat16: "stock_beachcat",
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
const SAIL = 0xf4f2ea;
function triangle(kit: Kit, parent: THREE.Object3D, name: string, a: number[], b: number[], c: number[]): THREE.Mesh {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute([...a, ...b, ...c], 3));
  geo.computeVertexNormals();
  const m = kit.mesh(geo, kit.std(SAIL, { roughness: 0.75 }), parent);
  m.name = name;
  return m;
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

const DRAW: Record<StockKey, (kit: Kit, g: THREE.Group) => void> = {
  stock_cruiser31: drawCruiser,
  stock_dinghy14: drawDinghy,
  stock_beachcat16: drawCat,
};
const FORM: Record<StockKey, HullForm> = { stock_cruiser31: CRUISER_FORM, stock_dinghy14: DINGHY_FORM, stock_beachcat16: CAT_HULL };
const SPECS: Record<StockKey, BoatSpec> = { stock_cruiser31: CRUISER, stock_dinghy14: DINGHY, stock_beachcat16: BEACHCAT };
/** Name tag height above the waterline: the masthead. */
const MAST_TOP: Record<StockKey, number> = { stock_cruiser31: 13.9, stock_dinghy14: 4.8, stock_beachcat16: 8.5 };

/** A stock boat as a BoatModel (boats/model.ts), with its rig. */
export function buildStock(key: StockKey, quality: Quality) {
  const spec = SPECS[key];
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
  const rig = new StockRig(key, g);
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
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
    },
  };
}
