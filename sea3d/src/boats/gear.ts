// Working equipment on a boat model: propellers, rudder, wing sail, wind vane,
// solar panels, the comms light, and what breaks. Cosmetic only: it shows
// what the replay log says (speed, steering, sun, wind, messages, failures);
// it never changes the boat's motion.
//
// Moving parts are found by name, so the Blender models (blender/*.py) and the
// drawn-in-code fallbacks work the same way:
//   rudder_pivot, wing_pivot, vane_pivot (empties/groups to turn about y),
//   tail_flap (hidden when the sail is torn), panel* (solar panel meshes),
//   seat_<n> and oar_<n>_p / oar_<n>_s (a rowing crew, boats/rowers.ts).
// Everything here works in the builder frame (x aft from the bow, y up from
// the hull bottom, z to port), inside the model's inner group.

import * as THREE from "three";
import { Rowers } from "./rowers";
import { NAV_NIGHT } from "./navlights";

/** Part names as the replay's part_failed events give them. */
export type Part =
  | "thruster_port"
  | "thruster_starboard"
  | "rudder"
  | "sail"
  | "electronics_main"
  | "electronics_safe"
  | "comms_silent"
  | "beacon"
  | "leak_main_tub"
  | "leak_safe_tub"
  | "entangled";

export interface GearState {
  /** Speed through the water over cruising speed (0 stopped, 1 cruising). */
  speed: number;
  /** Wanted rudder angle, rad; + turns the boat to starboard. */
  rudder: number;
  /** Sunlight, 0 (night) .. 1 (about 1000 W/m²). */
  sun: number;
  /** Comms: "ok" (Iridium up), "beacon" (only the backup beacon), "silent", "" unknown. */
  comms: "ok" | "beacon" | "silent" | "";
  /** Air flow over the boat (apparent wind, the way the air moves), m/s, boat frame: x to the bow, z to starboard. */
  flow: { x: number; z: number };
  /** Broken parts and the log's reason (e.g. "knockdown"). */
  failed: Map<string, string>;
}

/** Air flow over a moving boat in its own frame (x to the bow, z to starboard), m/s.
 * wu, wv: true wind velocity east and north (where it blows to); stw: speed
 * through the water along the heading hdg (degrees true). */
export function apparentFlow(wu: number, wv: number, stw: number, hdgDeg: number): { x: number; z: number } {
  const h = THREE.MathUtils.degToRad(hdgDeg);
  // World: x east, z south. Boat velocity (sin h, -cos h) * stw.
  const ae = wu - stw * Math.sin(h);
  const az = -wv + stw * Math.cos(h);
  return { x: ae * Math.sin(h) - az * Math.cos(h), z: ae * Math.cos(h) + az * Math.sin(h) };
}

/** Wing pivot angle (builder frame, about y) that lines the wing up with the air
 * flow, tail downwind, plus a small angle of attack so it drives. */
export function wingAngle(flow: { x: number; z: number }, attack = 0.14): number {
  if (Math.hypot(flow.x, flow.z) < 0.05) return 0;
  const a = Math.atan2(flow.z, -flow.x);
  return a - attack * Math.sign(Math.sin(a));
}

/** Rudder the autopilot would hold for a turn rate (rad/s of displayed yaw,
 * + = turning to port), clamped to ±30°. + rudder turns the boat to starboard. */
export function rudderFor(yawRate: number): number {
  const lim = THREE.MathUtils.degToRad(30);
  return THREE.MathUtils.clamp(-0.9 * yawRate, -lim, lim);
}

export interface GearLayout {
  /** Propeller groups, port first; they spin about x. */
  props: THREE.Object3D[];
  /** Where the comms light sits. */
  light: THREE.Vector3;
  /** Where a warning sign goes for each part that can break. */
  spots: Partial<Record<Part, THREE.Vector3>>;
  /** Parts that smoke when they fail. */
  smoky: Part[];
}

// The comms status lamp: a small LED dot that only shows close up, never a glowing light.
// Never green or red: on the water those read as sidelights (Sam's sailor review, 12 Nov).
// Lost comms blink slow amber; the HUD's equipment icons carry the state. The boat's real
// light is its white all-round one (navlights.ts).
const LIGHT_COLOUR = { ok: 0x9aa4ae, beacon: 0xffb020, silent: 0xffb020, "": 0x6b7a8a } as const;

function glowTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(255,255,255,1)");
  r.addColorStop(0.25, "rgba(255,255,255,.55)");
  r.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function warningTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const g = c.getContext("2d")!;
  g.lineJoin = "round";
  g.beginPath();
  g.moveTo(64, 10);
  g.lineTo(120, 112);
  g.lineTo(8, 112);
  g.closePath();
  g.fillStyle = "#ffc247";
  g.strokeStyle = "#1a1300";
  g.lineWidth = 9;
  g.stroke();
  g.fill();
  g.fillStyle = "#1a1300";
  g.fillRect(58, 42, 12, 40);
  g.beginPath();
  g.arc(64, 96, 7, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function smokeTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, "rgba(70,72,76,.85)");
  r.addColorStop(0.6, "rgba(90,92,96,.35)");
  r.addColorStop(1, "rgba(110,110,110,0)");
  g.fillStyle = r;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const PUFFS = 7;

export class Gear {
  private readonly owned: { dispose(): void }[] = [];
  readonly rudder: THREE.Object3D | null;
  readonly wing: THREE.Object3D | null;
  readonly vane: THREE.Object3D | null;
  private readonly flap: THREE.Object3D | null;
  /** The crew at the oars, on a rowing boat. */
  readonly rowers: Rowers | null;
  private readonly panels: THREE.MeshStandardMaterial[] = [];
  private readonly lamp: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>;
  private readonly glow: THREE.Sprite;
  private readonly signs = new Map<Part, THREE.Sprite>();
  /** The floating ⚠ over a broken part: off everywhere (Elena, 12 Nov); the strip's red icons and the toast carry the news. Broken parts still smoke and are listed in shown.signs. */
  showSigns = false;
  private readonly smoke = new Map<Part, THREE.Sprite[]>();
  private spin: number[];
  private rudderAngle = 0;
  private wingA = 0;
  private flash = -10;
  private last = 0;
  /** What the gear is showing now (for the smoke test). */
  readonly shown = { spin: [] as number[], rudder: 0, wing: 0, light: "", sun: 0, signs: [] as string[] };

  /** The propellers, port first (for the page's prop wash, boats/propwash.ts). */
  get props(): readonly THREE.Object3D[] {
    return this.layout.props;
  }

  constructor(
    g: THREE.Object3D,
    private readonly layout: GearLayout,
  ) {
    this.rudder = g.getObjectByName("rudder_pivot") ?? null;
    this.wing = g.getObjectByName("wing_pivot") ?? null;
    this.vane = g.getObjectByName("vane_pivot") ?? null;
    this.flap = g.getObjectByName("tail_flap") ?? null;
    this.rowers = Rowers.find(g);
    if (this.rowers) this.owned.push(this.rowers);
    this.spin = layout.props.map(() => 0);
    // Solar panels: own copies of their materials so the sun can light them.
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !/^panel/i.test(m.name)) return;
      const mats = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => {
        const c = (x as THREE.MeshStandardMaterial).clone();
        this.owned.push(c);
        this.panels.push(c);
        return c;
      });
      m.material = Array.isArray(m.material) ? mats : mats[0];
    });
    // Comms light: a small lamp and a glow round it.
    const glowTex = this.keep(glowTexture());
    this.lamp = new THREE.Mesh(this.keep(new THREE.SphereGeometry(0.018, 16, 10)), this.keep(new THREE.MeshBasicMaterial({ color: LIGHT_COLOUR[""] })));
    this.lamp.name = "comms_light";
    this.lamp.position.copy(layout.light);
    g.add(this.lamp);
    this.glow = new THREE.Sprite(this.keep(new THREE.SpriteMaterial({ map: glowTex, color: LIGHT_COLOUR[""], transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })));
    this.glow.position.copy(layout.light);
    this.glow.scale.setScalar(0.2);
    g.add(this.glow);
    // Warning signs and smoke, hidden until something breaks.
    const signMat = this.keep(new THREE.SpriteMaterial({ map: this.keep(warningTexture()), depthTest: false, transparent: true }));
    const smokeTex = this.keep(smokeTexture());
    for (const [part, at] of Object.entries(layout.spots) as [Part, THREE.Vector3][]) {
      const s = new THREE.Sprite(signMat);
      s.name = `warning_${part}`;
      s.position.copy(at);
      s.scale.setScalar(0.13);
      s.renderOrder = 10;
      s.visible = false;
      g.add(s);
      this.signs.set(part, s);
      if (layout.smoky.includes(part)) {
        const puffs: THREE.Sprite[] = [];
        for (let i = 0; i < PUFFS; i++) {
          const p = new THREE.Sprite(this.keep(new THREE.SpriteMaterial({ map: smokeTex, transparent: true, depthWrite: false })));
          p.visible = false;
          g.add(p);
          puffs.push(p);
        }
        this.smoke.set(part, puffs);
      }
    }
  }

  private keep<T extends { dispose(): void }>(x: T): T {
    this.owned.push(x);
    return x;
  }

  /** A message just went out: flash the light. */
  flashLight(t: number): void {
    this.flash = t;
  }

  /** Which moving parts this model has (for the smoke test). */
  parts(): Record<string, number | boolean> {
    return {
      props: this.layout.props.length,
      rudder: !!this.rudder,
      wing: !!this.wing,
      vane: !!this.vane,
      panels: this.panels.length,
      light: !!this.lamp.parent,
      signs: this.signs.size,
      rowers: this.rowers?.shown.stations ?? 0,
    };
  }

  update(s: GearState, t: number): void {
    const dt = THREE.MathUtils.clamp(t - this.last, 0, 0.1);
    this.last = t;
    const failed = (p: Part) => s.failed.has(p);
    const brainDead = failed("electronics_main") && (failed("electronics_safe") || !this.layout.spots.electronics_safe);

    // Propellers: turn with speed; a failed motor, or no working electronics, stops.
    const tangled = failed("entangled") ? 0.45 : 1;
    this.layout.props.forEach((p, i) => {
      const dead = (i === 0 ? failed("thruster_port") : failed("thruster_starboard")) || brainDead;
      const want = dead ? 0 : 7 + 22 * THREE.MathUtils.clamp(s.speed, 0, 1.5) * tangled;
      this.spin[i] += (want - this.spin[i]) * Math.min(1, dt * (dead ? 0.8 : 3)); // a stopped prop runs down
      p.rotation.x += this.spin[i] * dt;
    });
    this.shown.spin = this.spin.map((w) => Math.round(w * 10) / 10);

    // Rudder: the autopilot's angle, eased like a servo. Broken: a servo that
    // failed limp is centred by its spring; one broken in a knockdown swings free.
    let rWant = brainDead ? 0 : s.rudder + 0.04 * Math.sin(t * 0.9);
    const why = s.failed.get("rudder");
    if (why != null) rWant = /knockdown/i.test(why) ? 0.45 * Math.sin(t * 1.3) + 0.15 * Math.sin(t * 3.1) : 0;
    const rate = why != null ? 4 : 1.2; // servo speed, rad/s
    this.rudderAngle += THREE.MathUtils.clamp(rWant - this.rudderAngle, -rate * dt, rate * dt);
    if (this.rudder) this.rudder.rotation.y = this.rudderAngle;
    this.shown.rudder = this.rudderAngle;

    // Wing sail: weathervanes to the air flow with a little angle of attack.
    // Torn in a knockdown: the tail flap is gone and the wing flogs about.
    if (this.wing) {
      const torn = failed("sail");
      let want = wingAngle(s.flow, torn ? 0 : 0.14);
      if (torn) want += 0.5 * Math.sin(t * 1.9) + 0.25 * Math.sin(t * 4.3);
      const d = Math.atan2(Math.sin(want - this.wingA), Math.cos(want - this.wingA));
      this.wingA += d * Math.min(1, dt * (torn ? 6 : 2));
      this.wing.rotation.y = this.wingA;
      if (this.flap) this.flap.visible = !torn;
      this.shown.wing = this.wingA;
    }
    // Rowers: pull in time while the boat makes way; below decks when it doesn't.
    this.rowers?.update(dt, s.speed);

    // Wind vane on the stern pole: points straight downwind, with a little flutter.
    if (this.vane) this.vane.rotation.y = wingAngle(s.flow, 0) + 0.05 * Math.sin(t * 5.3);

    // Solar panels: a cool sheen in strong sun. Only while the drawn sky is day: the logged
    // sun can disagree with the picture (a forced night sky), and at night the panels lit
    // up blue from inside, the brightest thing in the frame (Ines, 12 Nov).
    for (const m of this.panels) {
      m.emissive.setRGB(0.12, 0.25, 0.55);
      m.emissiveIntensity = 0.5 * THREE.MathUtils.clamp(s.sun, 0, 1) * (1 - NAV_NIGHT.value);
    }
    this.shown.sun = s.sun;

    // Comms light: colour by link; a short blink every 2 s; bright when a message goes.
    const colour = brainDead ? LIGHT_COLOUR.silent : LIGHT_COLOUR[s.comms];
    this.lamp.material.color.setHex(colour);
    this.glow.material.color.setHex(colour);
    const since = t - this.flash;
    const blink = (t % 2) < 0.18 ? 0.8 : 0.15;
    const burst = since >= 0 && since < 0.7 ? 1.6 * (1 - since / 0.7) : 0;
    const lost = brainDead || s.comms === "silent" || s.comms === "beacon";
    const k = lost ? ((t % 3) < 1.2 ? 0.9 : 0.1) : Math.max(blink, burst);
    this.glow.visible = false; // no halo: an LED, not a lamp
    // Dim after dark, so the white all-round light is the one that reads.
    this.lamp.material.color.multiplyScalar(1 - 0.5 * NAV_NIGHT.value);
    this.lamp.material.color.multiplyScalar(0.35 + 0.65 * Math.min(1, k));
    this.shown.light = brainDead ? "silent" : s.comms;

    // Warning signs bob over broken parts; failed boxes smoke.
    const signs: string[] = [];
    for (const [part, sign] of this.signs) {
      const on = failed(part);
      sign.visible = on && this.showSigns;
      if (on) {
        signs.push(part);
        const at = this.layout.spots[part]!;
        sign.position.set(at.x, at.y + 0.02 * Math.sin(t * 2.4), at.z);
      }
      const puffs = this.smoke.get(part);
      if (!puffs) continue;
      puffs.forEach((p, i) => {
        p.visible = on;
        if (!on) return;
        const a = ((t * 0.45 + i / PUFFS) % 1 + 1) % 1; // 0 born .. 1 gone
        const at = this.layout.spots[part]!;
        p.position.set(at.x + 0.12 * a + 0.02 * Math.sin(t + i), at.y - 0.1 + 0.55 * a, at.z + 0.03 * Math.sin(i * 2.1 + t * 0.7));
        p.scale.setScalar(0.06 + 0.22 * a);
        p.material.opacity = 0.75 * (1 - a) * Math.min(1, a * 6);
      });
    }
    this.shown.signs = signs;
  }

  dispose(): void {
    this.owned.forEach((x) => x.dispose());
  }
}

/** A gentle "nothing logged" state for the showroom: cruising into a light
 * breeze that slowly swings about, everything working. */
export function idleGear(t: number): GearState {
  const a = 0.35 * Math.sin(t * 0.35);
  return { speed: 1, rudder: 0.12 * Math.sin(t * 0.3), sun: 0, comms: "ok", flow: { x: -4 * Math.cos(a), z: 4 * Math.sin(a) }, failed: new Map() };
}
