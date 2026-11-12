/**
 * Cinematic mode (John, Nov 11): the panels fade away and the camera films the boat
 * on its own: slow orbits and dollies, low shots skimming the waves, a wide shot of
 * the sea and sky, a drone pull-back, and, when it is sunset or a clear night right
 * now, a shot set against the low sun or tilted up at the stars. It cuts to a new
 * shot every 8 to 15 seconds. Any key or a click ends it (M turns the sound on and
 * off instead).
 *
 * It films what is happening at the voyage's current moment and never moves the
 * clock (John, 11 Nov: "a cinematic for what is currently going on"). The page keeps
 * running its own frame and clock; it hands over the camera each frame through update().
 */
import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

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
  /** Cloud cover now, 0..1: no night-sky shot under a thick overcast. */
  cloud?(): number;
  /** The sound toggle, for the N key. */
  toggleSound?(): void;
  /** A fade to black is starting (seconds long): the sound dips with it (sound.ts duck). */
  fade?(seconds: number): void;
  /** How much bigger than our 3 m kayak the boat is: the close shots stand back by this much. */
  scale?(): number;
}

type ShotKind = "orbit" | "dolly" | "track" | "skim" | "wide" | "drone" | "vista" | "sunset" | "stars";

interface Shot {
  kind: ShotKind;
  len: number; // seconds
  seed: number; // 0..1, varies the side and angle
  side: number; // -1 or 1
}

const CSS = `
body.cinema > :not(#app):not(#cine) { opacity: 0 !important; pointer-events: none !important; transition: opacity .9s ease; }
body.cinema-out > :not(#app):not(#cine) { transition: opacity .9s ease; }
#cine { position: fixed; inset: 0; pointer-events: none; z-index: 50; display: none; }
body.cinema #cine { display: block; }
#cine .bar { position: absolute; left: 0; right: 0; height: 0; background: #000; transition: height 1.1s ease; }
#cine .bar.t { top: 0; } #cine .bar.b { bottom: 0; }
body.cinema #cine .bar { height: 6.5vh; }
#cine .dip { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity .35s ease; }
#cine .dip.on { opacity: 1; }
#cine .hint { position: absolute; left: 50%; bottom: 9vh; transform: translateX(-50%); font: 500 13px system-ui, sans-serif; color: #e8eef6;
  background: rgba(0,0,0,.45); padding: 5px 14px; border-radius: 999px; opacity: 0; transition: opacity 1.2s ease; white-space: nowrap; }
#cine .hint.on { opacity: 1; }
#cine .cap { position: absolute; left: 4vw; bottom: 9vh; font: 600 12px system-ui, sans-serif; letter-spacing: 2px; color: rgba(240,244,250,.85);
  text-shadow: 0 1px 3px rgba(0,0,0,.8); opacity: 0; transition: opacity 1.5s ease; text-transform: uppercase; }
#cine .cap.on { opacity: 1; }
`;

const ease = (u: number) => u * u * (3 - 2 * u);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

export class Cinema {
  on = false;
  /** Shot names so far, for tests and pictures. */
  readonly log: ShotKind[] = [];
  private shot: Shot | null = null;
  private t = 0;
  private cuts = 0;
  private dipAt = -1;
  private saved: { pos: THREE.Vector3; target: THREE.Vector3; fov: number; enabled: boolean } | null = null;
  private skimY: number | null = null;
  private readonly el: HTMLElement;
  private readonly dip: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly cap: HTMLElement;
  private readonly look = new THREE.Vector3();
  private readonly onKey = (e: KeyboardEvent) => {
    if (!this.on || e.repeat) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code === "KeyN") this.host.toggleSound?.(); // N is sound on every page (Elena: one key, one meaning)
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

  constructor(private readonly host: CinemaHost) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.append(style);
    this.el = document.createElement("div");
    this.el.id = "cine";
    // Constant markup only.
    this.el.innerHTML = '<div class="bar t"></div><div class="bar b"></div><div class="dip"></div><div class="cap"></div><div class="hint">Any key or click to leave · N for sound</div>';
    document.body.append(this.el);
    this.dip = this.el.querySelector(".dip") as HTMLElement;
    this.hint = this.el.querySelector(".hint") as HTMLElement;
    this.cap = this.el.querySelector(".cap") as HTMLElement;
    window.addEventListener("keydown", this.onKey, true);
    window.addEventListener("pointerdown", this.onPointer, true);
  }

  start(): void {
    if (this.on) return;
    const { camera, controls } = this.host;
    this.saved = { pos: camera.position.clone(), target: controls.target.clone(), fov: camera.fov, enabled: controls.enabled };
    controls.enabled = false;
    this.on = true;
    this.startedAt = performance.now();
    this.cuts = 0;
    this.log.length = 0;
    document.body.classList.add("cinema");
    document.body.classList.remove("cinema-out");
    this.hint.classList.add("on");
    setTimeout(() => this.hint.classList.remove("on"), 4500);
    this.next();
  }

  stop(): void {
    if (!this.on) return;
    this.on = false;
    this.shot = null;
    this.dipAt = -1;
    this.dip.classList.remove("on");
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

  /** The sky shot that fits right now, if any: the low sun at sunset (or sunrise), or
   * the stars on a clear, dark night. */
  private skyNow(): "sunset" | "stars" | null {
    const el = this.host.sunEl();
    if (el > -4 && el < 10) return "sunset";
    if (el < -12 && (this.host.cloud?.() ?? 0) <= 0.6) return "stars";
    return null;
  }

  private pick(): Shot {
    const prev = this.shot?.kind;
    const pool: ShotKind[] = ["orbit", "dolly", "track", "skim", "wide", "drone"];
    // Off real land, the land gets its own shots: twice as likely as the others.
    if (this.host.landmark?.() != null) pool.push("vista", "vista");
    // Every third cut or so, the sky when there's something in it now.
    const sky = this.skyNow();
    if (sky && this.cuts > 0 && this.cuts % 3 === 2 && prev !== sky) {
      return { kind: sky, len: 13, seed: Math.random(), side: Math.random() < 0.5 ? -1 : 1 };
    }
    // The first shot is always the orbit: it starts near where the viewer already was.
    const choices = this.cuts === 0 ? ["orbit" as ShotKind] : pool.filter((k) => k !== prev);
    const kind = choices[Math.floor(Math.random() * choices.length)];
    return { kind, len: 8 + Math.random() * 7, seed: Math.random(), side: Math.random() < 0.5 ? -1 : 1 };
  }

  private next(): void {
    this.shot = this.pick();
    this.t = 0;
    this.skimY = null;
    this.cuts++;
    this.log.push(this.shot.kind);
    this.caption();
  }

  private caption(): void {
    const words: Partial<Record<ShotKind, string>> = { stars: "Night sky" };
    const k = this.shot?.kind;
    this.cap.textContent = (k && words[k]) ?? "";
    this.cap.classList.toggle("on", !!(k && words[k]));
  }

  /** Cut now (tests and the picture script). */
  cut(kind?: ShotKind): void {
    if (!this.on) return;
    this.next();
    if (kind && this.shot && kind !== this.shot.kind) {
      this.shot = { ...this.shot, kind };
      this.log[this.log.length - 1] = kind;
      this.caption();
    }
  }

  /** Move the camera for this frame; false when the mode is off and the page's own controls run. */
  update(dt: number): boolean {
    if (!this.on || !this.shot) return false;
    this.t += dt;
    const s = this.shot;
    // A short dip to black before each cut.
    if (this.t > s.len - 0.35 && this.dipAt < 0) {
      this.dipAt = this.t;
      this.dip.classList.add("on");
      this.host.fade?.(0.7);
    }
    if (this.t >= s.len) {
      this.next();
      this.dipAt = -1;
      requestAnimationFrame(() => this.dip.classList.remove("on"));
    }
    const shot = this.shot!;
    const u = Math.min(this.t / shot.len, 1);
    this.frame(shot, u);
    return true;
  }

  private frame(s: Shot, u: number): void {
    const { camera, controls } = this.host;
    const tg = controls.target;
    const yaw = this.host.yaw();
    // Bow and beam directions in the scene.
    const bx = Math.cos(yaw);
    const bz = -Math.sin(yaw);
    const px = -bz * s.side;
    const pz = bx * s.side;
    const at = (ang: number, r: number, y: number) =>
      camera.position.set(tg.x + Math.cos(ang) * r, tg.y + y, tg.z + Math.sin(ang) * r);
    const beamAng = Math.atan2(pz, px);
    let fov = 40;
    const k0 = this.host.scale?.() ?? 1;
    this.look.copy(tg);
    switch (s.kind) {
      case "orbit": {
        const a = beamAng + (s.seed - 0.5) * 2 + s.side * u * 0.85;
        at(a, (7.5 - u * 1.2) * k0, (1.5 + Math.sin(u * Math.PI) * 0.7) * k0);
        fov = 38;
        break;
      }
      case "dolly": {
        // In from the quarter, easing to a close-up.
        const a = beamAng + s.side * (0.5 + s.seed * 0.7);
        const k = ease(u);
        at(a, lerp(24, 5.5, k) * k0, lerp(1.6, 0.85, k) * k0);
        fov = lerp(30, 42, k);
        break;
      }
      case "track": {
        // Alongside, sliding from the stern to past the bow.
        const along = lerp(-6, 6, ease(u)) * k0;
        camera.position.set(tg.x + px * 5 * k0 + bx * along, tg.y + 0.9 * k0, tg.z + pz * 5 * k0 + bz * along);
        this.look.set(tg.x + bx * along * 0.3, tg.y + 0.15 * k0, tg.z + bz * along * 0.3);
        fov = 45;
        break;
      }
      case "skim": {
        // Low over the water, crossing in front: the waves fill the bottom of the frame.
        const a = beamAng + s.side * lerp(-0.6, 0.6, u) + (s.seed - 0.5) * 0.8;
        const r = (11 + s.seed * 4) * k0;
        const x = tg.x + Math.cos(a) * r;
        const z = tg.z + Math.sin(a) * r;
        const want = this.host.water(x, z) + 0.5;
        this.skimY = this.skimY === null ? want : lerp(this.skimY, want, 0.12);
        camera.position.set(x, Math.max(this.skimY, want - 0.1), z);
        this.look.set(tg.x, tg.y + 0.35 * k0, tg.z);
        fov = 52;
        break;
      }
      case "wide": {
        // Far out and up a little: the boat small against the sea and a big sky.
        const a = beamAng + (s.seed - 0.5) * 2.4 + s.side * u * 0.12;
        at(a, 70, 7);
        this.look.set(tg.x, tg.y + 9, tg.z);
        fov = 50;
        break;
      }
      case "drone": {
        // Up and away from overhead, the wake trailing behind.
        const k = ease(u);
        camera.position.set(
          tg.x + (-bx * lerp(3, 14, k) + px * 2) * k0,
          tg.y + lerp(4, 26, k) * k0,
          tg.z + (-bz * lerp(3, 14, k) + pz * 2) * k0,
        );
        this.look.set(tg.x + bx * 2, tg.y, tg.z + bz * 2);
        fov = 48;
        break;
      }
      case "vista": {
        // From behind the boat, up a little, looking past it at the shore and the mountain.
        const b = THREE.MathUtils.degToRad(this.host.landmark?.() ?? 0);
        const dx = Math.sin(b);
        const dz = -Math.cos(b);
        const k = ease(u);
        const side = s.side * (0.25 + s.seed * 0.3);
        const cx = dx * Math.cos(side) - dz * Math.sin(side);
        const cz = dx * Math.sin(side) + dz * Math.cos(side);
        const back = lerp(26, 16, k);
        camera.position.set(tg.x - cx * back, tg.y + lerp(7, 4, k), tg.z - cz * back);
        this.look.set(tg.x + dx * 600, tg.y + 22, tg.z + dz * 600);
        fov = 42;
        break;
      }
      case "sunset": {
        // Down sun of the boat, low, so it sits against the sunset.
        const sd = this.host.sunDir();
        const h = Math.hypot(sd.x, sd.z) || 1;
        const sx = sd.x / h;
        const sz = sd.z / h;
        const off = s.side * 0.35;
        const cx = sx * Math.cos(off) - sz * Math.sin(off);
        const cz = sx * Math.sin(off) + sz * Math.cos(off);
        camera.position.set(tg.x - cx * 9 * k0, tg.y + 1.0 * k0, tg.z - cz * 9 * k0);
        this.look.set(tg.x + cx * 30 * k0, tg.y + 2.2 * k0, tg.z + cz * 30 * k0);
        fov = 50;
        break;
      }
      case "stars": {
        // Low beside the boat, tilted up at the turning sky.
        const a = beamAng + s.seed * 2 + u * 0.25;
        at(a, 6 * k0, 0.9 * k0);
        this.look.set(tg.x - Math.cos(a) * 10, tg.y + 9, tg.z - Math.sin(a) * 10);
        fov = 68;
        break;
      }
    }
    if (camera.fov !== fov) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    camera.lookAt(this.look);
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
