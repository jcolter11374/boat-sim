/**
 * Cinematic mode (John, Nov 11; redesigned 12 Nov after "boring views, sort of random,
 * not thought out"): the panels fade away and the camera films the boat as a planned
 * film. The plan and shot list, approved by Leo:
 * /mnt/project-files/simulator/gameplay/cinematic-shot-plan.md.
 *
 * - Sequences, not random shots. Each sequence is picked by what is happening now (a
 *   knockdown, a storm, the low sun, night, or an ordinary passage) and runs establish, closer, detail, release.
 * - Every shot is composed: the boat is sized on purpose from its real length, sits on a
 *   third with room ahead of its bow, and the horizon sits on a third, not the middle.
 * - One eased move a shot, slowed to the boat's own speed. Straight cuts inside a
 *   sequence; a short fade between sequences.
 * - The camera keeps to one side of the boat's line of travel within a sequence.
 * - Only a knockdown cuts into a shot; anything else waits for the shot to end.
 *
 * It films what is happening at the voyage's current moment and never moves the clock
 * (John, 11 Nov). Any key or a click ends it (N turns the sound on and off instead).
 */
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { boatAt, camHeight, compose, heightOf, type Composed, type FramingHost, type Look } from "./framing";

// The framing itself (compose, the title shot) lives in framing.ts; pages import the film from here.
export { boatAt, camHeight, compose, heightOf, type Composed, type Look };

/** What is going on now, for picking the sequence. */
export interface Moment {
  /** 0 fair .. 1 gale (the page's eased storm). */
  storm: number;
  /** Seconds since a knockdown began on screen (Infinity for none): cuts straight to it. */
  knockdownAgo: number;
  /** A knockdown in the last few hours of the voyage (the helm's clock stops while filming). */
  recentKnockdown?: boolean;
  /** Land in sight: its compass bearing (degrees) and name. */
  land: { bearing: number; name: string } | null;
  /** The nearest ship: compass bearing (degrees) and distance (km). */
  ship: { bearing: number; km: number } | null;
}

export interface CinemaHost {
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  /** Sea surface height at a scene point now. */
  water(x: number, z: number): number;
  /** The boat's heading as scene yaw (bow along (cos yaw, 0, -sin yaw)). */
  yaw(): number;
  /** Sun elevation now, degrees, at the boat. */
  sunEl(): number;
  /** Direction to the sun now (scene, unit). */
  sunDir(): THREE.Vector3;
  /** Compass bearing to land worth filming (a place like Pico), or null at sea. */
  landmark?(): number | null;
  /** Cloud cover now, 0..1 (kept for shots that need a clear sky; none at launch). */
  cloud?(): number;
  /** The sound toggle, for the N key. */
  toggleSound?(): void;
  /** How much bigger than our 3 m kayak the boat is (used when length() isn't given). */
  scale?(): number;
  /** The boat's length (m): every shot is sized from it. */
  length?(): number;
  /** The boat's height above the water (m), mast and all: tall boats are framed to fit. */
  height?(): number;
  /** The boat's speed now (knots): the camera's moves are slowed to match a slow boat. */
  speed?(): number;
  /** What's happening now (storm, knockdown, land, ship); calm open sea when not given. */
  moment?(): Moment;
  /** The caption's start: the boat's name and the day ("My kayak · Day 34"). */
  caption?(): string;
  /** The last knockdown's timing in the page clock (seconds), or null (Theo's boats/ride.ts). */
  knockdown?(): { start: number; flat: number; rising: number; upright: number; peakDeg: number; side: number } | null;
  /** The page clock now (seconds), the one knockdown() times are in. */
  clock?(): number;
  /** A fade to black between sequences is starting, lasting `seconds` (sound ducks a little; Felix). Not called on straight cuts. */
  fade?(seconds: number): void;
}

export type ShotKind =
  | "establish"
  | "alongside"
  | "sternlight"
  | "bowon"
  | "stern"
  | "skim"
  | "panels"
  | "sterndetail"
  | "bowdetail"
  | "light"
  | "drone"
  | "stormlow"
  | "heel"
  | "sunset";

export type SequenceKind = "passage" | "storm" | "knockdown" | "golden" | "night";

/** What the azimuth is measured from: the bow, or the direction to the sun, land or a ship. */
type Ref = "bow" | "sun" | "land" | "ship";


export interface ShotDef {
  ref: Ref;
  from: Look;
  to: Look;
  /** Seconds, at the normal pace. */
  len: [number, number];
  /** Rides the waves low (skims and storm shots). */
  low?: boolean;
  /** Rolls a little with the sea. */
  roll?: boolean;
  /** Locked off: no hand-held drift (the heel shot, so the heel reads true). */
  locked?: boolean;
  /** Framed by the hull: a boat with no mast doesn't stand back to fit its aerial (which may leave the top of the frame). */
  hull?: boolean;
}

const L = (az: number, f: number, H: number, B: number, fov: number, aim?: [number, number]): Look => ({ az, f, H, B, fov, aim });
/** A low chase-boat frame: the camera h metres off the water, the horizon at H. */
const C = (az: number, f: number, H: number, h: number, fov: number, aim?: [number, number]): Look => ({ az, f, H, B: 0, fov, aim, h });

// Long lenses for the chase-boat shots (field of view 15 to 28 degrees), 30 to 40 for the
// closer ones; only details and the drone wider than 40, nothing wider than 50 (Elena).
export const SHOTS: Record<ShotKind, ShotDef> = {
  // f: how much of the frame's width the boat spans. Establish at least a tenth, the mediums a
  // third or more, details fill it. Never under 6% of the width, not even the drone's release:
  // no sequence ends on a pull-away to a dot (Elena, Leo, 12 Nov; John's complaint).
  establish: { ref: "bow", from: C(122, 0.13, 0.33, 3, 15), to: C(116, 0.16, 0.33, 3, 15), len: [4.5, 6] },
  // A tenth further back than round 3 (Elena, 13 Nov): in a gale the kayak's stern lamp touched the frame's edge.
  alongside: { ref: "bow", from: C(96, 0.38, 0.33, 2, 26), to: C(68, 0.4, 0.33, 2, 26), len: [6, 9] },
  bowon: { ref: "bow", from: C(18, 0.3, 0.3, 1.5, 34), to: C(24, 0.34, 0.3, 1.5, 34), len: [6, 8], low: true },
  stern: { ref: "bow", from: C(150, 0.36, 0.33, 1.6, 34), to: C(156, 0.38, 0.33, 1.6, 34), len: [6, 8] },
  // Horizon high: a big sky over a low camera read as a fog ceiling (Leo, 12 Nov).
  skim: { ref: "bow", from: C(55, 0.36, 0.4, 0.8, 34), to: C(112, 0.36, 0.4, 0.8, 34), len: [6, 8], low: true },
  panels: { ref: "bow", from: L(130, 1.5, 0.75, 0.0, 45, [-0.15, 0.4]), to: L(105, 1.5, 0.75, 0.0, 45, [0.15, 0.4]), len: [4, 6] },
  sterndetail: { ref: "bow", from: L(150, 1.4, 0.3, 0.05, 42, [-0.5, 0.1]), to: L(146, 1.5, 0.3, 0.05, 42, [-0.5, 0.1]), len: [4, 6], low: true },
  bowdetail: { ref: "bow", from: L(38, 1.4, 0.3, 0.05, 42, [0.45, 0.2]), to: L(44, 1.5, 0.3, 0.05, 42, [0.45, 0.2]), len: [4, 6], low: true },
  // Nearer the middle than the other shots (x): this close, on the full third her stern and aerial were cut by the
  // frame's edge as the film opened (Elena, 13 Nov).
  light: { ref: "bow", from: { ...C(120, 0.55, 0.3, 1.5, 36, [-0.1, 0.3]), x: 0.22 }, to: { ...C(110, 0.6, 0.3, 1.5, 36, [-0.1, 0.3]), x: 0.22 }, len: [6, 8], low: true },
  // Night's third shot (Elena, 13 Nov): from astern, low, her stern lamp and her shape against the horizon's glow.
  // Framed by the hull (Elena, 13 Nov): fitting the kayak's aerial stood the camera so far back she was a fifth of
  // the width under two-thirds of empty sky. A third closer now, the horizon on the upper third, her shape across it.
  sternlight: { ref: "bow", from: C(160, 0.24, 0.25, 1.2, 34, [-0.3, 0.3]), to: C(168, 0.22, 0.25, 1.2, 34, [-0.3, 0.3]), len: [6, 8], low: true, hull: true },
  drone: { ref: "bow", from: L(128, 0.4, 0.45, -0.05, 40), to: L(150, 0.12, 0.9, -0.3, 46), len: [8, 10] },
  stormlow: { ref: "bow", from: C(42, 0.4, 0.33, 2, 32), to: C(48, 0.44, 0.33, 2, 32), len: [4, 6], low: true, roll: true },
  heel: { ref: "bow", from: C(90, 0.5, 0.33, 2.2, 30), to: C(90, 0.6, 0.33, 2.2, 30), len: [6, 7], locked: true },
  // Into the low sun: the horizon on the upper third so the sun and its glitter path are in frame.
  sunset: { ref: "sun", from: { ...C(166, 0.4, 0.25, 1.0, 24), sunSide: true }, to: { ...C(168, 0.42, 0.25, 1.0, 24), sunSide: true }, len: [6, 8], low: true },
};

/**
 * The sequences, as the plan sets them out: shots in order (a list = one of them,
 * varied). Five for launch (Elena): Landfall and Company come back once land and
 * ships pass the screenshot test themselves.
 */
export const SEQUENCES: Record<SequenceKind, (ShotKind | ShotKind[])[]> = {
  passage: ["establish", ["alongside", "bowon", "stern", "skim"], ["alongside", "bowon", "stern", "skim"], ["panels", "sterndetail", "bowdetail"], "drone"],
  storm: ["establish", "stormlow", "stern", "stormlow", "alongside"],
  knockdown: ["heel", "sterndetail", "drone"],
  golden: ["sunset", "alongside", "sunset"],
  // Night is short and close: the boat's own light carries it (Elena, 12 Nov). Three shots, and each
  // night sequence films from the other side to the last, so a minute of night isn't one side view.
  night: ["light", "alongside", "sternlight"],
};

/** How long shots run in each sequence: storms quicker, calm and night slower. */
const PACE: Record<SequenceKind, number> = { passage: 1, storm: 0.7, knockdown: 1, golden: 1, night: 1.1 };

const ease = (u: number) => u * u * (3 - 2 * u);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const D2R = Math.PI / 180;

/** Partway (u) through a move from a to b; `sweep` scales how far round the boat it goes. */
export function mixLook(a: Look, b: Look, u: number, sweep = 1): Look {
  const aa = a.aim ?? [0, 0];
  const ba = b.aim ?? [0, 0];
  return {
    az: a.az + (b.az - a.az) * sweep * u,
    f: Math.exp(lerp(Math.log(a.f), Math.log(b.f), u)), // a push in at an even pace
    H: lerp(a.H, b.H, u),
    B: lerp(a.B, b.B, u),
    fov: lerp(a.fov, b.fov, u),
    aim: [lerp(aa[0], ba[0], u), lerp(aa[1], ba[1], u)],
    h: a.h != null && b.h != null ? lerp(a.h, b.h, u) : undefined,
    x: a.x,
    sunSide: a.sunSide,
  };
}

/**
 * How far round the boat the camera's moves go: all the way for a boat at 4 knots or
 * more, about a third for our 1.5 knot kayak, so the camera never races a slow boat.
 */
export function sweepFor(knots: number): number {
  return THREE.MathUtils.clamp(knots / 4, 0.3, 1);
}

/** The sequences that fit now, best first (only those whose conditions hold). */
export function fitting(m: Moment, sunEl: number): SequenceKind[] {
  const out: SequenceKind[] = [];
  if (m.knockdownAgo < 3 || m.recentKnockdown) out.push("knockdown");
  if (m.storm > 0.5) out.push("storm");
  if (sunEl > -3 && sunEl < 10 && m.storm < 0.7) out.push("golden");
  if (sunEl < -10) out.push("night");
  if (sunEl >= -10 || m.storm > 0.5) out.push("passage");
  return out;
}

/** The next sequence: a knockdown on screen at once; otherwise the most fitting one not played in the last two. */
export function chooseSequence(fit: SequenceKind[], recent: SequenceKind[], knockdownNow = false): SequenceKind {
  if (knockdownNow) return "knockdown";
  const fresh = fit.filter((k) => !recent.slice(-2).includes(k));
  return fresh[0] ?? fit[fit.length - 1] ?? "passage";
}

/** A word for the time of day from the sun's height. */
export function timeWord(sunEl: number, morning: boolean): string {
  if (sunEl < -6) return "Night";
  if (sunEl < 8) return morning ? "Dawn" : "Dusk";
  return "";
}

/** The shots of one sequence: the fixed ones, and a varied pick where the plan gives a choice; never the same shot twice running. */
export function shotsFor(kind: SequenceKind, lastShot: ShotKind | null, rnd: () => number = Math.random, skip: ShotKind[] = []): ShotKind[] {
  const shots: ShotKind[] = [];
  for (const p of SEQUENCES[kind]) {
    if (typeof p === "string") shots.push(p);
    else {
      const left = p.filter((k) => !skip.includes(k) && !shots.includes(k) && k !== shots[shots.length - 1]);
      shots.push(left[Math.floor(rnd() * left.length)] ?? p[0]);
    }
  }
  if (shots[0] === lastShot && shots.length > 1) shots.push(shots.shift()!);
  return shots;
}


/**
 * The helm's opening shot after Set sail (Leo F3, Elena 12 Nov), under Jonas's goal card: the
 * boat on the lower-left third heading right into open water, the horizon on the upper third,
 * a long lens from a low chase boat. The sky's top 45% / left 60% is left clear for the card.
 * fov in degrees, like camera.fov.
 */
export const OPENING: Look = { az: 104, f: 0.34, H: 0.25, B: 0, fov: 24, h: 2.2 };
export function openingShot(host: FramingHost): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } {
  return framed(host, OPENING);
}


/** A still frame of the boat with its bow to the right of the screen (the boat on the left), for any heading. */
function framed(host: FramingHost, look: Look): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } {
  const yaw = host.yaw();
  const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
  const len = host.length?.() ?? 3.05 * (host.scale?.() ?? 1);
  const target = boatAt(host);
  // Whichever side puts the bow to the right of the screen (the boat on the left).
  for (const side of [1, -1]) {
    const c = compose(target, bow, bow, side, len, host.camera.aspect, look, 0, host.height?.() ?? 0);
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quat);
    if (r.x * bow.x + r.z * bow.y > 0 || side === -1) {
      c.pos.y = Math.max(c.pos.y, host.water(c.pos.x, c.pos.z) + 0.5);
      return { pos: c.pos, quat: c.quat, fov: c.fov };
    }
  }
  throw new Error("unreachable");
}

/**
 * The helm's cut to a knockdown outside the film (M5: a knockdown is seen, not read): the Heel
 * shot's frame, side on and locked off, from the side she is thrown towards (side +1 starboard,
 * -1 port, as boats/ride.ts), so her deck and rig come over at the lens. fov in degrees.
 */
// In the middle of the screen (x 0), clear of the orders panel on the left and the chart on the
// right, a little above centre over the instrument strip, and from higher than the film's Heel
// shot so a gale's crests don't hide a boat lying flat.
export const KNOCKDOWN: Look = { ...C(90, 0.4, 0.3, 3, 30), B: 0.1, x: 0 };
// A boat with no rig to speak of (the kayak) lies low and dark when she is flat: closer and
// lower, so she fills near half the width between the panels and her spray and bright topsides
// stand against the sea behind her (Elena, 14 Nov: she nearly disappeared at the moment that matters).
export const KNOCKDOWN_HULL: Look = { ...C(90, 0.46, 0.3, 1.5, 30), B: 0.1, x: 0 };
export function knockdownShot(host: FramingHost, side: number): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } {
  const yaw = host.yaw();
  const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
  const len = host.length?.() ?? 3.05 * (host.scale?.() ?? 1);
  const target = boatAt(host);
  const tall = host.height?.() ?? 0;
  // The scene's +z is the port side of a bow along +x (boats/ride.ts: a roll that lowers +z is to port).
  const lee = new THREE.Vector2(bow.y, -bow.x).multiplyScalar(side < 0 ? -1 : 1);
  let best: Composed | null = null;
  let most = -Infinity;
  for (const s of [1, -1]) {
    const c = compose(target, bow, bow, s, len, host.camera.aspect, tall <= len ? KNOCKDOWN_HULL : KNOCKDOWN, 0, tall <= len ? 0 : tall);
    const out = (c.pos.x - target.x) * lee.x + (c.pos.z - target.z) * lee.y;
    if (out > most) {
      most = out;
      best = c;
    }
  }
  const c = best!;
  c.pos.y = Math.max(c.pos.y, host.water(c.pos.x, c.pos.z) + 0.5);
  return { pos: c.pos, quat: c.quat, fov: c.fov };
}

/**
 * The results card's background (Leo's story-first card, Elena 12 Nov): a composed still of the
 * final moment, with the boat out in a corner (lower left, heading right) clear of the centred
 * card (x 25-75%). A win or a draw: low and warm, a big sky over the boat. Lost: higher and
 * wider, the boat small and alone (still never a dot). fov in degrees.
 */
export const FINAL: Record<"won" | "lost" | "neither" | "draw", Look> = {
  won: { az: 112, f: 0.16, H: -0.3, B: 0, fov: 22, h: 1.6, x: 0.77 },
  draw: { az: 112, f: 0.16, H: -0.3, B: 0, fov: 22, h: 1.6, x: 0.77 },
  neither: { az: 118, f: 0.15, H: 0.3, B: 0, fov: 24, h: 2.5, x: 0.76 },
  lost: { az: 115, f: 0.11, H: 0.38, B: 0, fov: 26, h: 4, x: 0.8 },
};
export function finalShot(host: FramingHost, outcome: keyof typeof FINAL): { pos: THREE.Vector3; quat: THREE.Quaternion; fov: number } {
  return framed(host, FINAL[outcome]);
}


/**
 * A shot aimed by something other than the bow (the sun) can land end-on to the boat, where a
 * kayak looks like a tub (Leo, 12 Nov). Turn the reference just enough that the camera sees the
 * boat at least 25 degrees off her line (Ines allows two bow-on holds a minute), same side.
 */
export function threeQuarter(ref: THREE.Vector2, bow: THREE.Vector2, azDeg: number, side: number): THREE.Vector2 {
  const a = azDeg * D2R * side;
  const cam = new THREE.Vector2(ref.x * Math.cos(a) - ref.y * Math.sin(a), ref.x * Math.sin(a) + ref.y * Math.cos(a));
  const camAng = Math.atan2(cam.y, cam.x);
  const bowAng = Math.atan2(bow.y, bow.x);
  // The camera's angle off the boat's line, folded to 0..90 degrees.
  let off = ((camAng - bowAng) % Math.PI + Math.PI) % Math.PI; // 0..pi
  const sign = off < Math.PI / 2 ? 1 : -1;
  const folded = off < Math.PI / 2 ? off : Math.PI - off;
  const min = (25 * Math.PI) / 180; // into the sun, end-on is allowed only nearly: a quarter view at least
  if (folded >= min) return ref;
  const turn = sign * (min - folded);
  off = turn;
  const r = new THREE.Vector2(Math.cos(off) * ref.x - Math.sin(off) * ref.y, Math.sin(off) * ref.x + Math.cos(off) * ref.y);
  return r;
}


const CSS = `
body.cinema > :not(#app):not(#cine) { opacity: 0 !important; pointer-events: none !important; transition: opacity .9s ease; }
body.cinema-out > :not(#app):not(#cine) { transition: opacity .9s ease; }
#cine { position: fixed; inset: 0; pointer-events: none; z-index: 50; display: none; }
body.cinema #cine, body.cinema-out #cine { display: block; }
#cine .bar { position: absolute; left: 0; right: 0; height: 0; background: #000; transition: height 1.1s ease; }
#cine .bar.t { top: 0; } #cine .bar.b { bottom: 0; }
body.cinema #cine .bar { height: 6.5vh; }
#cine .xf { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; }
#cine .xf.go { transition: opacity .9s ease; }
#cine .hint { position: absolute; left: 50%; bottom: 9vh; transform: translateX(-50%); font: 500 13px system-ui, sans-serif; color: #e8eef6;
  background: rgba(0,0,0,.45); padding: 5px 14px; border-radius: 999px; opacity: 0; transition: opacity 1.2s ease; white-space: nowrap; }
#cine .hint.on { opacity: 1; }
#cine .cap { position: absolute; left: 4vw; bottom: 9vh; font: 600 12px system-ui, sans-serif; letter-spacing: 2px; color: rgba(240,244,250,.88);
  text-shadow: 0 1px 3px rgba(0,0,0,.8); opacity: 0; transition: opacity 1.5s ease; text-transform: uppercase; }
#cine .cap.on { opacity: 1; }
`;

interface Shot {
  kind: ShotKind;
  len: number;
}

export class Cinema {
  on = false;
  /** Shot names so far, for tests and pictures. */
  readonly log: ShotKind[] = [];
  /** Sequence names so far. */
  readonly sequences: SequenceKind[] = [];
  private seq: { kind: SequenceKind; shots: ShotKind[]; i: number; side: number } | null = null;
  /** The side the last night sequence was filmed from (0 = none yet): the next takes the other. */
  private nightSide = 0;
  private shot: Shot | null = null;
  private t = 0;
  private saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number; enabled: boolean } | null = null;
  /** The boat's centre, smoothed so the camera doesn't jitter with each wave. */
  private anchor: THREE.Vector3 | null = null;
  private camY: number | null = null;
  private clock = 0;
  private lastShot: ShotKind | null = null;
  private capTimer = 0;
  private readonly el: HTMLElement;
  /** The last frame of a sequence, dissolving into the next (Elena: a crossfade, never black). */
  private readonly xf: HTMLCanvasElement;
  private readonly hint: HTMLElement;
  private readonly cap: HTMLElement;
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.on || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "KeyN") this.host.toggleSound?.(); // N for sound: M is the helm's map (Elena: one key, one meaning)
    else this.stop();
  };
  private readonly onPointer = (e: Event) => {
    if (!this.on || performance.now() - this.startedAt < 400) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.stop();
  };
  private startedAt = 0;
  /** Called when the mode ends, by key, click or stop(). */
  onExit: (() => void) | null = null;
  /** Called when the mode starts. */
  onStart: (() => void) | null = null;

  constructor(private readonly host: CinemaHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.el = document.createElement("div");
    this.el.id = "cine";
    // Constant markup only.
    this.el.innerHTML = '<div class="bar t"></div><div class="bar b"></div><canvas class="xf"></canvas><div class="cap"></div><div class="hint">Any key or click to leave · N for sound</div>';
    document.body.append(this.el);
    this.xf = this.el.querySelector(".xf") as HTMLCanvasElement;
    this.hint = this.el.querySelector(".hint") as HTMLElement;
    this.cap = this.el.querySelector(".cap") as HTMLElement;
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("pointerdown", this.onPointer, true);
  }

  /** Start filming; `first` picks the opening sequence (tests and the picture script), else what fits now. */
  start(first?: SequenceKind): void {
    if (this.on) return;
    const { camera, controls } = this.host;
    this.saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, enabled: controls.enabled };
    controls.enabled = false;
    this.on = true;
    this.startedAt = performance.now();
    this.log.length = 0;
    this.sequences.length = 0;
    this.seq = null;
    this.nightSide = 0;
    this.anchor = null;
    this.camY = null;
    this.lastShot = null;
    document.body.classList.add("cinema");
    document.body.classList.remove("cinema-out");
    this.hint.classList.add("on");
    setTimeout(() => this.hint.classList.remove("on"), 4000);
    this.onStart?.();
    this.next(first);
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    this.shot = null;
    this.seq = null;
    this.xf.classList.remove("go");
    this.xf.style.opacity = "0";
    this.cap.classList.remove("on");
    this.hint.classList.remove("on");
    document.body.classList.remove("cinema");
    document.body.classList.add("cinema-out");
    const { camera, controls } = this.host;
    if (this.saved) {
      controls.target.copy(this.saved.target);
      camera.position.copy(this.saved.pos);
      camera.fov = this.saved.fov;
      camera.updateProjectionMatrix();
      controls.enabled = this.saved.enabled;
    }
    this.onExit?.();
  }

  /** The current shot's name, or null. */
  get current(): ShotKind | null {
    return this.shot?.kind ?? null;
  }

  /** The current sequence's name, or null. */
  get sequence(): SequenceKind | null {
    return this.seq?.kind ?? null;
  }

  private moment(): Moment {
    const m = this.host.moment?.() ?? { storm: 0, knockdownAgo: Infinity, land: null, ship: null };
    const lb = this.host.landmark?.();
    return m.land || lb == null ? m : { ...m, land: { bearing: lb, name: "" } };
  }

  private startSequence(kind: SequenceKind): void {
    // The panels close-up is the kayak's solar deck: a yacht (taller than she's long) has none,
    // and that close on her the camera sat inside the rigging (round 3b). Her bow close-up
    // cropped the hull and lost the sails (round 3d): she gets the cockpit close-up instead.
    const yacht = (this.host.height?.() ?? 0) > (this.host.length?.() ?? 3);
    const shots = shotsFor(kind, this.lastShot, Math.random, yacht ? ["panels", "bowdetail"] : []);
    // The film opens on the Establish, already moving (Elena); not for a knockdown, nor at night,
    // where a far boat is only a light (night is two close shots).
    if (!this.sequences.length && shots[0] !== "establish" && kind !== "knockdown" && kind !== "night") shots.unshift("establish");
    // One establishing shot a film, as its opener; later sequences start close (Ines, Leo).
    if (this.sequences.length && shots.length > 1) {
      const i = shots.indexOf("establish");
      if (i >= 0) shots.splice(i, 1);
    }
    this.seq = { kind, shots, i: -1, side: this.sideFor(shots[0]) };
    this.sequences.push(kind);
    this.captionFor(kind);
  }

  /**
   * Which side of the boat to film from: the one that puts the sun behind the boat, so
   * it's rim-lit with the glitter on the water, not flat and front-lit (Elena). At night
   * either side will do, so night sequences alternate.
   */
  private sideFor(first: ShotKind): number {
    const def = SHOTS[first];
    const sd = this.host.sunDir();
    if (this.host.sunEl() < -6) {
      // Night: either side will do for the light, so take turns (Elena, 13 Nov).
      this.nightSide = this.nightSide ? -this.nightSide : Math.random() < 0.5 ? -1 : 1;
      return this.nightSide;
    }
    if (def.ref === "sun" || Math.hypot(sd.x, sd.z) < 1e-6) return Math.random() < 0.5 ? -1 : 1;
    const yaw = this.host.yaw();
    const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
    const into = (side: number) => {
      const a = def.from.az * D2R * side;
      const cx = bow.x * Math.cos(a) - bow.y * Math.sin(a);
      const cz = bow.x * Math.sin(a) + bow.y * Math.cos(a);
      return -cx * sd.x - cz * sd.z; // the camera looking towards the sun
    };
    return into(1) >= into(-1) ? 1 : -1;
  }

  private next(forced?: SequenceKind): void {
    if (forced || !this.seq || this.seq.i >= this.seq.shots.length - 1) {
      const m = this.moment();
      const fit = fitting(m, this.host.sunEl());
      this.startSequence(forced ?? chooseSequence(fit, this.sequences, m.knockdownAgo < 3));
    }
    const s = this.seq!;
    s.i++;
    const kind = s.shots[s.i];
    const [a, b] = SHOTS[kind].len;
    this.shot = { kind, len: (a + Math.random() * (b - a)) * PACE[s.kind] };
    // The heel shot holds through the whole knockdown: the wave's hit, the roll, the recovery,
    // then two seconds upright (Leo, 12 Nov), however long the boat takes.
    if (kind === "heel") {
      const k = this.host.knockdown?.();
      const now = this.host.clock?.();
      if (k && now != null && k.upright + 2 > now) this.shot.len = Math.max(this.shot.len, k.upright + 2 - now);
    }
    this.t = 0;
    this.camY = null;
    this.lastShot = kind;
    this.log.push(kind);
  }

  private captionFor(kind: SequenceKind): void {
    const parts = [this.host.caption?.() ?? ""];
    if (kind === "storm") parts.push("Storm");
    else if (kind === "knockdown") parts.push("Knocked down");
    else parts.push(timeWord(this.host.sunEl(), this.host.sunDir().x > 0)); // the sun in the east: morning
    const text = parts.filter(Boolean).join(" · ");
    this.cap.textContent = text;
    this.cap.classList.remove("on");
    window.clearTimeout(this.capTimer);
    if (!text) return;
    // In a second after the cut, out four seconds later (Elena).
    this.capTimer = window.setTimeout(() => {
      this.cap.classList.add("on");
      this.capTimer = window.setTimeout(() => this.cap.classList.remove("on"), 4000);
    }, 1000);
  }

  /** Cut now (tests and the picture script): to a given shot, or the next one. */
  cut(kind?: ShotKind): void {
    if (!this.on) return;
    this.next();
    if (kind && this.shot && kind !== this.shot.kind) {
      this.shot = { kind, len: SHOTS[kind].len[1] };
      this.log[this.log.length - 1] = kind;
      this.lastShot = kind;
    }
  }

  /** Start a given sequence now (tests and the picture script). */
  play(kind: SequenceKind): void {
    if (!this.on) return;
    this.lastShot = null;
    this.next(kind);
  }

  /** Hold the frame on screen now (the page keeps its drawing buffer) and fade it out over the next shot. */
  private dissolve(): void {
    const src = document.querySelector<HTMLCanvasElement>("#app canvas");
    const g = this.xf.getContext("2d");
    if (!src || !g || !src.width) return;
    this.xf.width = src.width;
    this.xf.height = src.height;
    g.drawImage(src, 0, 0);
    this.xf.classList.remove("go");
    this.xf.style.opacity = "1";
    void this.xf.offsetWidth; // start the fade from fully shown
    this.xf.classList.add("go");
    this.xf.style.opacity = "0";
    this.host.fade?.(0.9);
  }

  /** Move the camera for this frame; false when the mode is off and the page's own controls run. */
  update(dt: number): boolean {
    if (!this.on || !this.shot) return false;
    this.t += dt;
    this.clock += dt;
    // Only a knockdown cuts into a shot.
    if (this.seq?.kind !== "knockdown" && this.moment().knockdownAgo < 0.5) {
      this.next("knockdown");
    }
    const s = this.shot;
    const lastInSeq = !!this.seq && this.seq.i >= this.seq.shots.length - 1;
    if (this.t >= s.len) {
      // Between sequences, the old one's last frame dissolves into the new; straight cuts inside one.
      if (lastInSeq) this.dissolve();
      this.next();
    }
    this.frame(this.shot!, Math.min(this.t / this.shot!.len, 1), dt);
    return true;
  }

  private length(): number {
    return this.host.length?.() ?? 3.05 * (this.host.scale?.() ?? 1);
  }

  private refDir(ref: Ref, bow: THREE.Vector2): THREE.Vector2 {
    const fromBearing = (b: number) => new THREE.Vector2(Math.sin(b * D2R), -Math.cos(b * D2R));
    const m = this.moment();
    if (ref === "sun") {
      const sd = this.host.sunDir();
      const h = Math.hypot(sd.x, sd.z);
      return h > 1e-6 ? new THREE.Vector2(sd.x / h, sd.z / h) : bow;
    }
    if (ref === "land" && m.land) return fromBearing(m.land.bearing);
    if (ref === "ship" && m.ship) return fromBearing(m.ship.bearing);
    return bow;
  }

  /** The lowest camera height from which the line to the boat clears every wave crest between. */
  private clearOver(cam: THREE.Vector3, aim: THREE.Vector3, len: number): number {
    let need = -Infinity;
    const top = aim.y + 0.4 + 0.05 * len; // the deck and cabin top, not the waterline
    for (let i = 1; i <= 8; i++) {
      const f = i / 10; // from the camera (0) towards the boat (1)
      const x = cam.x + (aim.x - cam.x) * f;
      const z = cam.z + (aim.z - cam.z) * f;
      const w = this.host.water(x, z) + 0.15;
      need = Math.max(need, (w - top * f) / (1 - f));
    }
    return need;
  }

  private frame(s: Shot, u: number, dt: number): void {
    const { camera } = this.host;
    const def = SHOTS[s.kind];
    const yaw = this.host.yaw();
    const bow = new THREE.Vector2(Math.cos(yaw), -Math.sin(yaw));
    // The boat's centre, smoothed: the camera follows like an operator, a little behind.
    const tg = boatAt(this.host);
    if (!this.anchor) this.anchor = tg.clone();
    // In a storm the boat heaves metres in seconds: follow her faster, so she can't ride out of the
    // frame (round 3 storm: the kayak left it at the top and the side).
    const k = 1 - Math.exp(-dt / (0.6 - 0.4 * this.moment().storm));
    this.anchor.x = tg.x;
    this.anchor.z = tg.z;
    this.anchor.y += (tg.y - this.anchor.y) * k;
    const look = mixLook(def.from, def.to, ease(u), sweepFor(this.host.speed?.() ?? 4));
    // In spray and murk the camera comes in closer, so the boat still carries the frame (Leo).
    look.f *= 1 + 0.5 * this.moment().storm;
    const roll = def.roll ? this.moment().storm * 0.05 * Math.sin(this.clock * 0.7) : 0;
    const len = this.length();
    const side = this.seq?.side ?? 1;
    const ref = def.ref === "bow" ? this.refDir(def.ref, bow) : threeQuarter(this.refDir(def.ref, bow), bow, look.az, side);
    const height = this.host.height?.() ?? 0;
    // A yacht (taller than she's long) is always framed by her mast; a hull shot ignores a small boat's aerial.
    const c = compose(this.anchor, bow, ref, side, len, camera.aspect, look, roll, def.hull && height <= len ? 0 : height);
    // Above the water under it, always, and high enough that no crest between hides the
    // boat: waves may rise into the foreground, but the boat stays in view.
    // (A crest may hide the hull for a moment; the camera climbs at most 1.5 m to see over it, so it stays low: Ines, 12 Nov.)
    const floor = Math.max(this.host.water(c.pos.x, c.pos.z) + 0.35 + 0.04 * len, Math.min(this.clearOver(c.pos, c.aim, len), c.pos.y + 1.5 + 3 * this.moment().storm));
    // (In a storm the crests are metres high: up to 4.5 m more, or the boat is lost behind them.)
    let y = Math.max(c.pos.y, floor);
    // Smoothed: up quickly to clear a crest, down gently.
    this.camY = this.camY === null ? y : lerp(this.camY, y, Math.min(1, dt * (y > this.camY ? 6 : def.low ? 3 : 1.5)));
    y = Math.max(this.camY, floor - 0.1);
    camera.position.set(c.pos.x, y, c.pos.z);
    camera.quaternion.copy(c.quat);
    if (Math.abs(y - c.pos.y) > 0.01) {
      // Lifted clear of a wave: tilt down by as much, so the boat stays where the frame put it.
      const dh = Math.hypot(c.pos.x - c.aim.x, c.pos.z - c.aim.z);
      const tilt = Math.atan2(y - c.aim.y, dh) - Math.atan2(c.pos.y - c.aim.y, dh);
      camera.quaternion.setFromEuler(new THREE.Euler(c.pitch - tilt, c.yaw, c.roll, "YXZ"));
    }
    if (!def.locked) {
      // A hand on the camera, as from a chase boat: a slow drift and bob (Elena).
      const w = this.clock;
      const m = 0.08 + 0.004 * camera.position.distanceTo(this.anchor);
      camera.position.x += m * Math.sin(w * 0.37 + 1.3);
      camera.position.y += m * 0.6 * Math.sin(w * 0.53);
      camera.position.z += m * Math.sin(w * 0.29 + 0.4);
      camera.rotateY(0.0035 * Math.sin(w * 0.41 + 2.1));
      camera.rotateX(0.0025 * Math.sin(w * 0.47 + 0.7));
    }
    if (camera.fov !== c.fov) {
      camera.fov = c.fov;
      camera.updateProjectionMatrix();
    }
  }
}

/** The page's Cinematic and Sound buttons (ids cinebtn and soundbtn). */
export function filmButtons(cine: Cinema, sound: { on: boolean; muted: boolean; enable(): void; toggle(): void; onChange: (() => void) | null }): void {
  const cb = document.getElementById("cinebtn");
  const sb = document.getElementById("soundbtn");
  const label = () => {
    if (!sb) return;
    // An icon-only button (the helm's corner map) keeps its words in the tooltip.
    if (sb.dataset.icon) sb.textContent = sound.on ? "\u{1F50A}" : "\u{1F507}";
    else sb.textContent = sound.on ? "\u{1F50A} Sound on" : "\u{1F507} Sound off";
    sb.setAttribute("aria-pressed", String(sound.on));
  };
  sound.onChange = label;
  label();
  cb?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!sound.muted && !sound.on) sound.enable();
    cine.start();
  });
  sb?.addEventListener("click", () => sound.toggle());
}
