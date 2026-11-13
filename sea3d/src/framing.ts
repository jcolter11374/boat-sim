/**
 * Composing a camera on a boat: where the camera stands so the boat sits where a shot wants
 * her (sized by the frame's width, on a third, a yacht framed by her mast, aimed at the
 * waterline), and the title screen's hero shot built on it. Split from cinema.ts so the title
 * can land before the cinematic's own round 3 (Elena, 12 Nov). Display only.
 */
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

const D2R = Math.PI / 180;

/** What a framing needs to know about the page and its boat. */
export interface FramingHost {
  camera: THREE.PerspectiveCamera;
  controls: Pick<OrbitControls, "target">;
  /** Sea surface height at a scene point now. */
  water(x: number, z: number): number;
  /** The boat's heading as scene yaw (bow along (cos yaw, 0, -sin yaw)). */
  yaw(): number;
  /** The boat's length (m). */
  length?(): number;
  /** The boat's height above the water (m), mast and all. */
  height?(): number;
  /** How much bigger than our 3 m kayak the boat is (used when length() isn't given). */
  scale?(): number;
  /** Direction to the sun now (scene, unit). */
  sunDir?(): THREE.Vector3;
}

/**
 * A composed frame. az: where the camera stands, degrees round from the reference
 * (0 = out ahead of it looking back at the boat, 180 = behind the boat looking towards
 * it). f: the boat's length as a share of the frame height. H: the horizon's height on
 * screen, B: the boat's, both -1 (bottom) .. 1 (top). fov: vertical, degrees. aim: the
 * point of the boat filmed, along its length (-0.5 stern .. 0.5 bow) and up (m).
 * Most shots are low, from a chase boat 1 to 4 m off the water (Elena's amendments):
 * those give h, the camera's height, and the boat sits wherever that puts it.
 */
export interface Look {
  az: number;
  f: number;
  H: number;
  B: number;
  fov: number;
  aim?: [number, number];
  /** Camera height above the water (m): when set, it rules and B follows (low chase-boat shots). */
  h?: number;
  /** How far off centre the boat sits (0..1 of the half-width), behind where it's heading; a third when not set. */
  x?: number;
  /** Filmed into the sun (ref "sun"): the boat goes on the third away from it, the sun and glitter on the other. */
  sunSide?: boolean;
  /** Keep the horizon where H puts it even for a tall mast (a phone's tall frame has the room). */
  keepH?: boolean;
}

export interface Composed {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  fov: number;
  /** The point filmed, and the camera's turn (radians), for re-aiming after it's lifted clear of a wave. */
  aim: THREE.Vector3;
  pitch: number;
  yaw: number;
  roll: number;
}

/**
 * Where the camera stands and how it's turned so the frame is composed as `l` says.
 * target: the boat's centre at the waterline; bow, ref: unit directions on the water
 * (x, z); side: which side of the reference to stand on; len: the boat's length (m);
 * tall: its height above the water (m: the masthead on a yacht).
 */
/** The camera's height for a low shot: the planned height for a cruiser-sized boat, lower for a small one (a chase boat sits lower beside a kayak, so it isn't looking down on it). */
export function camHeight(h: number, len: number): number {
  return Math.max(0.6, h * Math.min(1, len / 8));
}

export function compose(target: THREE.Vector3, bow: THREE.Vector2, ref: THREE.Vector2, side: number, len: number, aspect: number, l: Look, roll = 0, tall = 0): Composed {
  const vt = Math.tan((l.fov * D2R) / 2);
  const ht = vt * aspect;
  // The point filmed: along the boat and up from the waterline.
  const [along, up] = l.aim ?? [0, 0];
  const aim = new THREE.Vector3(target.x + bow.x * along * len, target.y + up, target.z + bow.y * along * len);
  const a = l.az * D2R * side;
  const cx = ref.x * Math.cos(a) - ref.y * Math.sin(a);
  const cz = ref.x * Math.sin(a) + ref.y * Math.cos(a);
  // Distance: the boat spans f of the frame's WIDTH (Elena and Ines, 12 Nov: sized by what the
  // screen shows; never closer than its own size). Its length counts in full side-on; seen
  // end-on it's foreshortened, so the camera comes closer.
  const across = Math.sqrt(Math.max(0, 1 - (cx * bow.x + cz * bow.y) ** 2));
  const seen = len * (0.25 + 0.75 * across);
  // A sailing boat's mast stands taller than its hull is long: it fits in the frame's height too,
  // with room above the masthead (below). Details (f >= 1) are close on the hull and crop it.
  const mastH = l.f >= 1 ? 0 : tall;
  const d0 = Math.max((0.5 * seen) / Math.tan(Math.atan(ht) * l.f), 0.75 * len);
  // How far below the horizon the boat is seen, from where the horizon and boat sit on screen.
  const betaAt = (d: number, H: number) => (l.h != null ? Math.asin(THREE.MathUtils.clamp((camHeight(l.h, len) - up) / d, -1, 1)) : Math.atan(H * vt) - Math.atan(l.B * vt));
  // The near end of a boat seen end-on comes closer and drops lower: stand back until it stays
  // inside the bottom of the frame (a low camera close to a kayak heading at it cropped its bow).
  // And the masthead: inside the letterbox with room above it (Ines: at least 5% below the bar).
  const fit = (H: number) => {
    const tilt = Math.atan(H * vt);
    let d = d0;
    for (let i = 0; i < 40; i++) {
      const b = betaAt(d, H);
      const camUp = d * Math.sin(b) + up;
      const near = d * Math.cos(b) - (0.5 + Math.abs(along)) * len * Math.abs(cx * bow.x + cz * bow.y);
      const below = Math.atan2(camUp, Math.max(near, 0.1)); // how far below level the near end is seen
      const mast = Math.atan2(mastH - camUp, Math.max(d * Math.cos(b), 0.1));
      if (Math.tan(-below + tilt) / vt > -0.62 && (mastH <= 0 || Math.tan(mast + tilt) / vt < 0.72)) break;
      d *= 1.05;
    }
    return d;
  };
  // A yacht filmed from a low boat with the horizon high had to stand so far back to fit her mast
  // that she shrank to a fifth of the frame's height (round 3: Pearson 8% wide). A yacht is framed
  // by her mast: put the horizon on the LOWER third instead, the mast against the sky.
  let H = l.H;
  let d = fit(H);
  // (Only for a low chase-boat camera: a drone above her keeps its horizon and looks down.)
  if (mastH > 0 && l.h != null && !l.keepH && H > -1 / 3 && d > 1.25 * d0) {
    H = -1 / 3;
    d = fit(H);
  }
  const beta = betaAt(d, H);
  const pos = new THREE.Vector3(aim.x + cx * d * Math.cos(beta), aim.y + d * Math.sin(beta), aim.z + cz * d * Math.cos(beta));
  // Facing the boat; then turned so the boat sits off centre with room ahead of its bow.
  const fx = -cx;
  const fz = -cz;
  const rx = -fz;
  const rz = fx;
  const bowRight = bow.x * rx + bow.y * rz; // +1: the bow points to the right of the screen
  // Always on a third, never centred, not even end-on (Ines: a bow-on boat sat at 46-56%):
  // behind where she's heading; filmed into the sun, on the third away from it.
  const sunRight = ref.x * rx + ref.y * rz; // the reference (the sun) to the right of the screen
  const away = l.sunSide ? (sunRight > 0 ? -1 : 1) : bowRight >= 0 ? -1 : 1;
  // On the third, decisively (Elena, round 3: a boat at 0.33 of the half-width, her bulk across the
  // middle, still read as centred): 0.42, so she sits at 30% / 70% of the width.
  // A boat that fills much of the frame moves in less, so neither end leaves it.
  const X = away * (l.x ?? Math.min(0.42, Math.max(0.2, 0.93 - l.f)));
  const delta = Math.atan(X * ht);
  const gx = Math.cos(delta) * fx - Math.sin(delta) * rx;
  const gz = Math.cos(delta) * fz - Math.sin(delta) * rz;
  const pitch = -Math.atan(H * vt);
  const yaw = Math.atan2(-gx, -gz); // three's camera looks along -z
  const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "YXZ"));
  return { pos, quat, fov: l.fov, aim, pitch, yaw, roll };
}

/**
 * The boat's centre at the waterline: the orbit target's x and z, on the sea surface there. The
 * helm raises its orbit target up a big boat's mast for the hand camera (4.9 m on the Pearson),
 * and filming from there put the hull on the letterbox (round 3).
 */
export function boatAt(host: Pick<FramingHost, "controls" | "water">): THREE.Vector3 {
  const t = host.controls.target;
  return new THREE.Vector3(t.x, host.water(t.x, t.z), t.z);
}

/**
 * The title screen's hero shot (Elena fix 5; Ines, 12 Nov): golden hour, a long lens from a low
 * chase boat looking into the low sun (the boat backlit), the boat on the right third with its
 * bow toward the menu card on the left and open sea between them. t (seconds) drives a slow
 * hand-held drift and a gentle push in and back that loops every 20 s. The title page should
 * turn the boat across the sun with titleHeading() so its bow can point at the card.
 * cardRight: where the card's right edge is, as a share of the screen's width (measure it on
 * the page); the bow keeps 15% of the width of open sea clear of it (Ines). cardBelow: the card
 * runs across the bottom instead (a phone held upright), so the boat goes above it (TITLE_PHONE).
 */
// The sun straight behind her, just above (the glitter path runs from the sun through the boat to
// the lens); she spans about a fifth of the width, on the two-thirds line (Ines, 12 Nov).
export const TITLE: Look = { az: 180, f: 0.25, H: 0.3, B: 0, fov: 24, h: 1.5, x: 1 / 3 };
/** The same shot on a phone held upright (menu at the bottom): horizon high, so she sits about a
 *  third down the screen; nearly centred across; a fifth wider lens; half the narrow width. */
export const TITLE_PHONE: Look = { ...TITLE, fov: 34, f: 0.5, H: 0.42, x: 0.15, keepH: true };
export const TITLE_LOOP_S = 20;
export function titleShot(host: FramingHost & Required<Pick<FramingHost, "sunDir">>, t: number, cardRight = 0.33, cardBelow = false): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } {
  const yaw = host.yaw();
  const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
  const sd = host.sunDir();
  const sun = new THREE.Vector2(sd.x, sd.z);
  if (sun.lengthSq() < 1e-9) sun.set(1, 0);
  sun.normalize();
  const len = host.length?.() ?? 3.05 * (host.scale?.() ?? 1);
  // A phone held upright has its menu across the bottom (Jonas; cardBelow): the boat goes in
  // the upper half, near the middle across, bigger in the narrow frame, wider lens for sky and sea.
  const phone = cardBelow;
  const T = phone ? TITLE_PHONE : TITLE;
  const w = (2 * Math.PI * t) / TITLE_LOOP_S;
  const look: Look = { ...T, f: T.f * (1 + 0.04 * (0.5 - 0.5 * Math.cos(w))), az: T.az + 0.6 * Math.sin(w) };
  // Whichever side puts the bow to the left of the screen, towards the card; then the boat
  // eased right and a touch smaller until its bow is clear of the card.
  // The open sea right of the card: 15% of the width clear of it on a wide screen, less on a
  // narrow one (Hana: on a phone the card covers over half the width); the boat fills most of it.
  const gap = Math.min(0.15, 0.25 * (1 - cardRight));
  const lo = phone ? -0.9 : 2 * (cardRight + gap) - 1; // on a phone the card is below her, not beside
  const hi = 0.9;
  const end = (c: Composed, k: number) => {
    const cam = new THREE.PerspectiveCamera(c.fov, host.camera.aspect, 0.1, 1e6);
    cam.position.copy(c.pos);
    cam.quaternion.copy(c.quat);
    cam.updateMatrixWorld();
    const tg = boatAt(host);
    return new THREE.Vector3(tg.x + k * bow.x * len * 0.5, tg.y, tg.z + k * bow.y * len * 0.5).project(cam).x;
  };
  const at = (base: Look, x: number, fk: number) => {
    const l: Look = { ...base, x, f: base.f * fk };
    let pick: Composed | null = null;
    for (const side of [1, -1]) {
      const k = compose(boatAt(host), bow, sun, side, len, host.camera.aspect, l, 0, host.height?.() ?? 0);
      const r = new THREE.Vector3(1, 0, 0).applyQuaternion(k.quat);
      if (r.x * bow.x + r.z * bow.y < 0) return k;
      pick ??= k;
    }
    return pick!;
  };
  // Placed and sized once for the whole loop (at its closest moment), so the shot never jumps.
  let x = T.x!;
  let fk = 1;
  for (let i = 0; i < 8; i++) {
    const k = at({ ...T, f: T.f * 1.04 }, x, fk);
    const b = end(k, 1);
    const st = end(k, -1);
    const span = Math.abs(st - b);
    const room = 0.9 * (hi - lo);
    if (span > room) fk *= room / span;
    // On the two-thirds line, unless that puts her bow over the card or her stern off the edge.
    const want = THREE.MathUtils.clamp(T.x!, lo + span / 2, Math.max(lo + span / 2, hi - span / 2));
    x = THREE.MathUtils.clamp(x + (want - (b + st) / 2), 0, 0.9);
  }
  const c = at(look, x, fk);
  c.pos.y = Math.max(c.pos.y, host.water(c.pos.x, c.pos.z) + 0.5) + 0.06 * Math.sin(w * 3 + 1);
  return { pos: c.pos, quat: c.quat, fov: c.fov };
}
/** The boat's yaw for the title: across the sun (about 70 degrees off it), so it shows its side backlit. */
export function titleHeading(sunDir: THREE.Vector3): number {
  return Math.atan2(-sunDir.z, sunDir.x) + (70 * Math.PI) / 180;
}

const tallness = new WeakMap<THREE.Object3D, number>();
/** A boat model's height above its waterline (m), measured once per model. waterY: the waterline in the model's parent frame. */
export function heightOf(root: THREE.Object3D, waterY: number): number {
  let h = tallness.get(root);
  if (h === undefined) {
    h = Math.max(new THREE.Box3().setFromObject(root).max.y - waterY, 0);
    tallness.set(root, h);
  }
  return h;
}

/**
 * How far the sailing view may slide the boat off-centre (1 = the full slide to a third, 0 = not at all),
 * from the share of the frame's width her hull spans. On a wide window she spans a sixth and slides freely;
 * on a phone held upright she spans half or more, and sliding her put her bow or stern off the edge.
 */
export function slideRoom(across: number): number {
  if (!Number.isFinite(across)) return 0;
  return Math.min(1, Math.max(0, (0.5 - across) / 0.2));
}
