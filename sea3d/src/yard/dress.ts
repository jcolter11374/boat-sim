// Dress the 3D kayak to match a Boatyard design, so every swap shows on the
// boat at a glance: parts appear, disappear, change size, colour or make; the
// parts inside the hull show in the "see inside" view; the keel, the bottom
// paint and the motors show when the boat is lifted out of the water.
// Cosmetic only: the numbers come from the catalog (design.ts), not from here.
// Sizes are the makers' published box sizes where we know them, else ≈.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { BoatModel } from "../boats/model";
import { Kit } from "../boats/parts";
import { KAYAK } from "../boats/specs";
import { MM_PER_KG, PLANNED_KG, type Summary } from "./design";

/** What the model shows for a design, for tests. */
export interface Dressed {
  thrusters: number;
  solar: number;
  batteries: number;
  controllers: number;
  boxes: number;
  ais: string;
  beacon: boolean;
  reflector: string;
  bulbScale: number;
  lead: string;
  bottom: string;
  material: string;
  shape: string;
  drive: string;
  sinkMm: number;
}

/** Which view shows a slot's change best. */
export type View = "afloat" | "inside" | "lifted";
export const VIEW_FOR: Record<string, View> = {
  bat: "inside",
  mppt: "inside",
  brain: "inside",
  sat: "inside",
  ais: "inside",
  radar: "inside",
  lead: "lifted",
  paint: "lifted",
  thr: "lifted",
  shape: "lifted",
  material: "lifted",
};

// Hull material: topside colour, finish and a surface pattern (0 none, 1 carbon weave, 2 wood grain).
const MATERIALS: Record<string, { color: number; rough: number; metal: number; pattern: number } | null> = {
  polyethylene: null, // as built: the orange rotomoulded hull
  fibreglass: { color: 0xf3f1ea, rough: 0.22, metal: 0, pattern: 0 },
  carbon: { color: 0x2c3036, rough: 0.28, metal: 0.15, pattern: 1 },
  "plywood-epoxy": { color: 0xc8925a, rough: 0.3, metal: 0, pattern: 2 },
  aluminium: { color: 0xb9c0c6, rough: 0.38, metal: 0.85, pattern: 0 },
};
// Hull shape: stretch of the drawn kayak (length, height, beam). 5.2 x 0.45 m surf-ski; ~2 m pod.
const SHAPES: Record<string, [number, number, number]> = {
  kayak: [1, 1, 1],
  "surf-ski": [5.2 / 3.05, 0.9, 0.45 / 0.79],
  pod: [2.0 / 3.05, 1.35, 1.25],
};

const PE_TOP = new THREE.Color(0xf26a1b); // the as-built paint (blender/build_kayak.py)
const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const BOTTOM_LUM = lum(new THREE.Color(0x2f383f));

interface Label {
  obj: THREE.Object3D;
  text: string;
}

/** The yard's own parts on one kayak model, and the views. Rebuild with the model. */
export class Outfit {
  readonly labels: Label[] = [];
  private kit: Kit;
  private g: THREE.Object3D; // the builder frame: x aft from the bow, y up from the hull bottom, z to port
  private parts = new Map<string, THREE.Group>(); // slot -> its group of drawn parts
  private ghosts: THREE.Material[] = []; // see-through in the inside view
  private owned: THREE.Mesh[] = []; // meshes whose materials we copied
  private hullU = {
    uTop: { value: PE_TOP.clone() },
    uTopLum: { value: lum(PE_TOP) },
    uMat: { value: 0 },
    uPattern: { value: 0 },
    uBare: { value: 0 },
    uWl: { value: KAYAK.waterline },
    uBottomLum: { value: BOTTOM_LUM },
  };
  private hullMat: THREE.MeshStandardMaterial | null = null;
  private hullBase = { rough: 0.32, metal: 0 };
  private bulb: THREE.Object3D | null = null;
  private bulbMesh: THREE.Mesh | null = null;
  private bulbC = new THREE.Vector3();
  private bulbMats: [THREE.MeshStandardMaterial, THREE.MeshStandardMaterial] | null = null;
  private pulses = new Map<string, number>(); // slot -> time the pulse started
  private glow: { mat: THREE.MeshStandardMaterial; slot: string; base: THREE.Color; baseI: number }[] = [];
  private view: View = "afloat";
  private x = 0; // inside-view blend, 0..1

  constructor(private model: BoatModel) {
    this.kit = new Kit("high");
    this.g = model.root.children[0];
    const named = (n: string) => model.root.getObjectByName(n);
    // Own copies of the materials we change (the detailed model's are shared between clones).
    // A glTF node with several materials is a group of meshes, so take every mesh under it.
    const own = (o: THREE.Object3D | undefined): THREE.MeshStandardMaterial[] => {
      const out: THREE.MeshStandardMaterial[] = [];
      o?.traverse((m) => {
        if (!(m instanceof THREE.Mesh) || !(m.material instanceof THREE.MeshStandardMaterial)) return;
        m.material = this.kit.keep(m.material.clone());
        out.push(m.material);
        this.owned.push(m);
      });
      return out;
    };
    // Hull paint and material: a small shader change on the hull's own material.
    const hullMats = own(named("hull"));
    this.hullMat = hullMats.find((m) => m.name === "hull") ?? hullMats[0] ?? null;
    this.ghosts.push(...hullMats);
    if (this.hullMat) {
      this.hullBase = { rough: this.hullMat.roughness, metal: this.hullMat.metalness };
      const u = this.hullU;
      this.hullMat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, u);
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nvarying vec3 vHullP;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvHullP = position;");
        sh.fragmentShader = sh.fragmentShader
          .replace(
            "#include <common>",
            `#include <common>
varying vec3 vHullP;
uniform vec3 uTop; uniform float uTopLum, uMat, uPattern, uBare, uWl, uBottomLum;`,
          )
          .replace(
            "#include <color_fragment>",
            `#include <color_fragment>
{
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  float pat = 1.0;
  if (uPattern > 0.5 && uPattern < 1.5) pat = mix(0.78, 1.18, mod(floor(vHullP.x * 70.0 + vHullP.y * 70.0) + floor(vHullP.x * 70.0 - vHullP.z * 70.0), 2.0));
  if (uPattern > 1.5) pat = 0.86 + 0.14 * sin(vHullP.x * 14.0 + 2.5 * sin(vHullP.y * 26.0 + vHullP.z * 19.0));
  if (vHullP.y < uWl - 0.004) {
    // Bare: no antifouling, so the hull's own colour carries on under the water.
    if (uBare > 0.5) diffuseColor.rgb = uTop * pat * clamp(l / uBottomLum, 0.4, 1.4);
  } else if (vHullP.y > uWl + 0.022 && uMat > 0.5) {
    diffuseColor.rgb = uTop * pat * clamp(l / uTopLum, 0.0, 1.3);
  }
}`,
          );
      };
      this.hullMat.customProgramCacheKey = () => "yard-hull";
      this.hullMat.needsUpdate = true;
    }
    // Keel bulb: new lead is bright and smooth, scrap lead is dull and patchy.
    this.bulb = named("bulb") ?? null;
    const bm = own(this.bulb ?? undefined)[0];
    if (this.bulb && bm) {
      // The bulb's centre in the builder frame (the detailed model's nodes carry no transform).
      this.bulbMesh = this.bulb instanceof THREE.Mesh ? this.bulb : (this.bulb.getObjectByProperty("isMesh", true) as THREE.Mesh);
      new THREE.Box3().setFromBufferAttribute(this.bulbMesh.geometry.getAttribute("position") as THREE.BufferAttribute).getCenter(this.bulbC);
      const scrap = this.kit.keep(bm.clone());
      scrap.color.set(0x4b5054);
      scrap.roughness = 0.85;
      scrap.metalness = 0.25;
      scrap.map = this.kit.keep(blotchTexture());
      this.bulbMats = [bm, scrap];
    }
    // Everything above the inside parts goes see-through in the inside view.
    for (const n of ["dome", "panel_fwd", "panel_mid", "panel_aft", "strake_stbd", "strake_port", "strake_stern"]) this.ghosts.push(...own(named(n)));
    this.buildParts();
  }

  dispose(): void {
    this.kit.dispose();
  }

  // ---------- the parts the yard draws ----------
  private group(slot: string): THREE.Group {
    let gr = this.parts.get(slot);
    if (!gr) {
      gr = new THREE.Group();
      gr.name = `yard_${slot}`;
      this.g.add(gr);
      this.parts.set(slot, gr);
    }
    return gr;
  }
  private mat(slot: string, hex: number, o: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const m = this.kit.std(hex, o);
    this.glow.push({ mat: m, slot, base: m.emissive.clone(), baseI: m.emissiveIntensity });
    return m;
  }
  /** A box by its size (x along the boat, y up, z across) and centre, rounded like a real case. */
  private box(parent: THREE.Object3D, m: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number, r = 0.008) {
    const mesh = this.kit.mesh(new RoundedBoxGeometry(sx, sy, sz, 2, Math.min(r, sx / 2, sy / 2, sz / 2)), m, parent);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    return mesh;
  }
  private option(slot: string, id: string): THREE.Group {
    const gr = new THREE.Group();
    gr.name = `yard_${slot}_${id}`;
    gr.userData.option = id;
    this.group(slot).add(gr);
    return gr;
  }
  private label(obj: THREE.Object3D, text: string) {
    this.labels.push({ obj, text });
  }

  private buildParts(): void {
    const k = this.kit;
    // Batteries: LiFePO4 cases, 50 Ah 229 x 138 x 208 mm, 100 Ah 330 x 172 x 215 mm (≈ makers' sizes), low and central.
    const battery = (gr: THREE.Group, big: boolean, z: number, name: string) => {
      const [sx, sy, sz] = big ? [0.33, 0.215, 0.172] : [0.229, 0.208, 0.138];
      const b = this.box(gr, this.mat("bat", 0x2f4a66, { roughness: 0.5 }), sx, sy, sz, 1.45, 0.07 + sy / 2, z, 0.012);
      this.box(gr, this.mat("bat", 0x1b1e22), sx * 0.96, 0.02, sz * 0.96, 1.45, 0.07 + sy + 0.008, z, 0.006);
      this.box(gr, this.mat("bat", 0xf0c419, { roughness: 0.4 }), sx * 1.002, 0.03, sz * 1.002, 1.45, 0.07 + sy * 0.62, z, 0.004);
      for (const [dx, col] of [[-0.06, 0xd23a2a], [0.06, 0x1b1b1b]] as const) {
        const t = k.mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.025, 12), this.mat("bat", col), gr);
        t.position.set(1.45 + dx, 0.07 + sy + 0.028, z);
      }
      this.label(b, name);
    };
    {
      const two = this.option("bat", "two-50ah");
      battery(two, false, 0.085, "Battery 1: 50 Ah");
      battery(two, false, -0.085, "Battery 2: 50 Ah");
      const one = this.option("bat", "one-50ah");
      battery(one, false, 0, "Battery: 50 Ah");
      const big = this.option("bat", "two-100ah");
      battery(big, true, 0.095, "Battery 1: 100 Ah");
      battery(big, true, -0.095, "Battery 2: 100 Ah");
    }
    // Solar charge controllers: Victron blue, black fins (100 x 113 x 40 mm).
    const mppt = (gr: THREE.Group, z: number, name: string) => {
      const b = this.box(gr, this.mat("mppt", 0x1f5fb0, { roughness: 0.45 }), 0.1, 0.04, 0.113, 2.02, 0.13, z, 0.006);
      for (let i = -2; i <= 2; i++) this.box(gr, this.mat("mppt", 0x15181b), 0.09, 0.016, 0.006, 2.02, 0.158, z + i * 0.02, 0.002);
      this.label(b, name);
    };
    const twoM = this.option("mppt", "two-mppt");
    mppt(twoM, 0.075, "Charge controller 1");
    mppt(twoM, -0.075, "Charge controller 2");
    mppt(this.option("mppt", "one-mppt"), 0, "Charge controller");
    // Autopilot: the Pixhawk in a black case (green light), the safe-mode box in a white one (amber light).
    const led = (gr: THREE.Group, slot: string, hex: number, x: number, y: number, z: number) => {
      const l = k.mesh(new THREE.SphereGeometry(0.008, 10, 8), this.mat(slot, hex, { emissive: hex, emissiveIntensity: 2.2 }), gr);
      l.position.set(x, y, z);
    };
    {
      const pix = (gr: THREE.Group, z: number) => {
        const b = this.box(gr, this.mat("brain", 0x1c1e21, { roughness: 0.55 }), 0.17, 0.075, 0.12, 0.95, 0.14, z, 0.01);
        led(gr, "brain", 0x35e07a, 0.89, 0.18, z + 0.03);
        this.label(b, "Autopilot (Pixhawk)");
      };
      const safe = (gr: THREE.Group, z: number) => {
        const b = this.box(gr, this.mat("brain", 0xe9e7e1, { roughness: 0.45 }), 0.12, 0.06, 0.09, 0.95, 0.13, z, 0.01);
        led(gr, "brain", 0xffa21f, 0.91, 0.163, z + 0.02);
        this.label(b, "Backup steering box");
      };
      const two = this.option("brain", "two-box");
      pix(two, 0.075);
      safe(two, -0.085);
      pix(this.option("brain", "one-box"), 0);
    }
    // Satellite modem: RockBLOCK 9603N (76 x 19 x 76 mm), just under the dome's top so it sees the sky.
    {
      const gr = this.option("sat", "rockblock-9603n");
      const b = this.box(gr, this.mat("sat", 0x202326), 0.076, 0.019, 0.076, 0.78, 0.47, 0, 0.004);
      this.box(gr, this.mat("sat", 0xc8202a), 0.05, 0.004, 0.05, 0.78, 0.481, 0, 0.002);
      this.label(b, "Satellite modem");
    }
    // AIS transponder: em-trak B921 (black, 195 x 52 x 138 mm) or Digital Yacht AIT1500 (grey, blue band). The whip is the same.
    {
      const em = this.option("ais", "emtrak-b921");
      this.label(this.box(em, this.mat("ais", 0x18191b, { roughness: 0.4 }), 0.195, 0.052, 0.138, 2.32, 0.11, 0, 0.012), "AIS: em-trak B921");
      led(em, "ais", 0xff7a1a, 2.24, 0.138, 0.04);
      const dy = this.option("ais", "dy-ait1500");
      this.label(this.box(dy, this.mat("ais", 0xb7bcc2, { roughness: 0.35 }), 0.17, 0.045, 0.12, 2.32, 0.105, 0, 0.012), "AIS: Digital Yacht AIT1500");
      this.box(dy, this.mat("ais", 0x1d5fd1), 0.172, 0.012, 0.122, 2.32, 0.112, 0, 0.004);
      this.option("ais", "none");
    }
    // Radar reflector, inside the dome: Echomax tube, or Davis octahedral plates.
    {
      const ec = this.option("radar", "echomax-230br");
      const tube = k.mesh(new THREE.CylinderGeometry(0.055, 0.055, 0.5, 24), this.mat("radar", 0xf2f2ee, { roughness: 0.35 }), ec);
      tube.rotation.z = Math.PI / 2;
      tube.position.set(1.95, 0.44, 0);
      this.label(tube, "Radar reflector: Echomax");
      const dv = this.option("radar", "davis-echomaster");
      const plate = this.mat("radar", 0xd7dde2, { metalness: 0.85, roughness: 0.25, side: THREE.DoubleSide });
      const holder = new THREE.Group();
      holder.position.set(1.95, 0.44, 0);
      holder.rotation.set(0.6, 0.3, 0.785);
      dv.add(holder);
      for (const rot of [[0, 0, 0], [Math.PI / 2, 0, 0], [0, Math.PI / 2, 0]] as const) {
        const p = k.mesh(new THREE.CircleGeometry(0.1, 4), plate, holder);
        p.rotation.set(rot[0], rot[1], rot[2]);
      }
      this.label(holder, "Radar reflector: Davis");
    }
    // 300 W: a third 100 W panel where the 50 W one was, hanging past the stern (the deck isn't long enough).
    {
      const gr = this.option("sol", "solar-300");
      const deck = KAYAK.waterline + 0.27;
      k.panel(gr, 2.56, 3.47, 0.54, () => deck, 6, 3);
      gr.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.castShadow = true;
          if (o.material instanceof THREE.MeshStandardMaterial) this.glow.push({ mat: o.material, slot: "sol", base: o.material.emissive.clone(), baseI: o.material.emissiveIntensity });
        }
      });
      for (const x of [2.62, 3.0])
        for (const z of [0.22, -0.22]) this.box(gr, this.mat("sol", 0x9aa1a8, { metalness: 0.7, roughness: 0.3 }), 0.02, 0.05, 0.02, x, deck - 0.01, z, 0.003);
    }
    // Wing sail (drive): a mast and a rigid wing amidships, our own sketch (not the Randolph wing).
    {
      const wing = (gr: THREE.Group) => {
        const white = this.mat("drive", 0xf4f4f0, { roughness: 0.35 });
        const mast = k.mesh(new THREE.CylinderGeometry(0.018, 0.022, 1.75, 16), this.mat("drive", 0x9aa3ab, { metalness: 0.7, roughness: 0.3 }), gr);
        mast.position.set(1.15, 0.5 + 0.87, 0);
        const shape = new THREE.Shape();
        shape.moveTo(0, 0);
        shape.bezierCurveTo(0.05, 0.03, 0.2, 0.025, 0.42, 0);
        shape.bezierCurveTo(0.2, -0.025, 0.05, -0.03, 0, 0);
        const foil = k.mesh(new THREE.ExtrudeGeometry(shape, { depth: 1.3, bevelEnabled: false, curveSegments: 10 }), white, gr);
        foil.rotation.x = -Math.PI / 2;
        foil.position.set(1.1, 0.62, 0);
        this.box(gr, this.mat("drive", 0x0b6e9a), 0.44, 0.06, 0.05, 1.32, 1.95, 0, 0.01);
      };
      wing(this.option("drive", "wing-sail"));
      wing(this.option("drive", "hybrid"));
      this.option("drive", "solar-electric");
    }
  }

  // ---------- applying a design ----------
  apply(picks: Record<string, string>, s: Summary, bulbKg: number): Dressed {
    const root = this.model.root;
    for (const [slot, gr] of this.parts) {
      const want = picks[slot] ?? gr.children[0]?.userData.option;
      let any = false;
      for (const c of gr.children) {
        c.visible = c.userData.option === want;
        any ||= c.visible;
      }
      gr.visible = any;
    }
    const show = (names: string[], on: boolean) => {
      for (const n of names) root.getObjectByName(n)?.traverse((o) => (o.visible = on));
    };
    // Drive: wing only drops the motors; hybrid keeps them.
    const drive = picks.drive ?? "solar-electric";
    // Motors: one T200 sits on the centreline instead of two either side.
    const port = root.getObjectByName("thruster_port");
    const stbd = root.getObjectByName("thruster_starboard");
    const motors = drive === "wing-sail" ? 0 : s.thrusters < 2 ? 1 : 2;
    if (stbd) stbd.visible = motors === 2;
    if (port) {
      port.visible = motors > 0;
      port.userData.z ??= port.position.z;
      port.position.z = motors === 1 ? 0 : port.userData.z;
    }
    // Solar: 2 x 100 W plus the 50 W aft panel for 250 W; 200 W drops the aft one; 300 W swaps it for a third 100 W.
    show(["panel_aft"], s.solarW > 200 && s.solarW < 300);
    show(["ais_base", "ais_whip"], s.ais);
    show(["beacon", "beacon_top"], s.beacon);
    // Keel bulb: the same lead shape scaled to its weight (about its own centre), and the lead's finish.
    const scale = Math.cbrt(bulbKg / 50);
    if (this.bulb) {
      this.bulb.scale.setScalar(scale);
      this.bulb.position.copy(this.bulbC).multiplyScalar(1 - scale);
      if (this.bulbMats && this.bulbMesh) this.bulbMesh.material = this.bulbMats[picks.lead === "lead-50-scrap" ? 1 : 0];
    }
    // Hull: bottom paint, material, shape.
    const u = this.hullU;
    u.uBare.value = picks.paint === "none" ? 1 : 0;
    const m = MATERIALS[picks.material ?? "polyethylene"] ?? null;
    u.uMat.value = m ? 1 : 0;
    u.uTop.value.set(m ? m.color : PE_TOP.getHex());
    u.uTopLum.value = lum(PE_TOP);
    u.uPattern.value = m?.pattern ?? 0;
    if (this.hullMat) {
      this.hullMat.roughness = m?.rough ?? this.hullBase.rough;
      this.hullMat.metalness = m?.metal ?? this.hullBase.metal;
    }
    const shape = picks.shape ?? "kayak";
    const [sx, sy, sz] = SHAPES[shape] ?? SHAPES.kayak;
    // Stretch about the centre of gravity, so the boat stays where it was.
    this.g.userData.p ??= this.g.position.clone();
    this.g.scale.set(sx, sy, sz);
    this.g.position.set(this.g.userData.p.x * sx, this.g.userData.p.y * sy, 0);
    const sinkMm = (s.massKg - PLANNED_KG) * MM_PER_KG;
    return {
      thrusters: motors,
      solar: s.solarW,
      batteries: picks.bat === "one-50ah" ? 1 : 2,
      controllers: picks.mppt === "one-mppt" ? 1 : 2,
      boxes: s.boxes,
      ais: s.ais ? picks.ais : "none",
      beacon: s.beacon,
      reflector: picks.radar ?? "",
      bulbScale: scale,
      lead: picks.lead ?? "",
      bottom: picks.paint === "none" ? "bare" : "antifouling",
      material: picks.material ?? "polyethylene",
      shape,
      drive,
      sinkMm,
    };
  }

  /** Flash the parts of a slot that just changed. */
  pulse(slot: string, t: number): void {
    this.pulses.set(slot, t);
  }

  setView(v: View): void {
    this.view = v;
  }
  get currentView(): View {
    return this.view;
  }
  /** The inside view's blend, 0 (solid) to 1 (see-through). */
  get insideBlend(): number {
    return this.x;
  }

  /** Per frame: the see-through fade and the pulses. */
  update(t: number, dt: number): void {
    const want = this.view === "inside" ? 1 : 0;
    const x = (this.x += Math.sign(want - this.x) * Math.min(Math.abs(want - this.x), dt * 3));
    for (const m of this.ghosts) {
      const see = x > 0.001;
      if (m.transparent !== see) {
        m.transparent = see;
        m.depthWrite = !see;
        m.needsUpdate = true;
        // Drawn after the sea (which draws after the hulls), or the sea paints over a hull that writes no depth.
        for (const o of this.owned) if (o.material === m) o.renderOrder = see ? 13 : 0;
      }
      m.opacity = 1 - 0.7 * x;
    }
    for (const gl of this.glow) {
      const t0 = this.pulses.get(gl.slot);
      const a = t0 === undefined ? 0 : Math.max(0, 1 - (t - t0) / 1.6);
      if (a > 0) {
        gl.mat.emissive.setRGB(1, 0.55, 0.15);
        gl.mat.emissiveIntensity = 0.9 * a * (0.6 + 0.4 * Math.sin((t - t0!) * 12));
      } else if (gl.mat.emissiveIntensity !== gl.baseI || !gl.mat.emissive.equals(gl.base)) {
        gl.mat.emissive.copy(gl.base);
        gl.mat.emissiveIntensity = gl.baseI;
      }
    }
  }
}

/** Grey blotches for scrap lead. */
function blotchTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const x = c.getContext("2d")!;
  x.fillStyle = "#b8b8b8";
  x.fillRect(0, 0, 128, 128);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 90; i++) {
    const v = Math.round(120 + rnd() * 135);
    x.fillStyle = `rgb(${v},${v},${Math.round(v * 0.96)})`;
    x.beginPath();
    x.arc(rnd() * 128, rnd() * 128, 3 + rnd() * 12, 0, Math.PI * 2);
    x.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}
