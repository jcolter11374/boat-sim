// The race page's 3D views: each boat on its own patch of sea, side by side
// (split screen). Each half is a small scene of its own (sky, sea, clouds,
// rain, the boat and its wake) driven by that boat's latest status from the
// simulator: where it is, which way it points, its speed and the weather it
// has there. Display only; the race itself is all in the simulator.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Atmosphere, sunPosition } from "../atmosphere";
import { Sea } from "../water";
import { Clouds, cloudFromSun, fogChance } from "../clouds";
import { Rain, rainFromRate } from "../rain";
import { BUILDERS, type BoatModel } from "../boats/model";
import { KAYAK, RANDOLPH, STOCK, STOCK_HULL, isStock, type BoatSpec } from "../boats/specs";
import { hasDetailedStock, loadStockModel } from "../boats/stock";
import { apparentFlow, rudderFor } from "../boats/gear";
import { BoatMotion, KAYAK_V4, RANDOLPH_REVB, RANDOLPH_REVC, type HullParams } from "../motion";
import { Wake } from "../wake";
import { Contact } from "../contact";
import { heightAt, Sea as LiveSea } from "../waves";
import type { Placement } from "../standin";

const KN = 1.94384;

/** What a view shows: one boat's latest status from the race simulator. */
export interface ViewState {
  t: string; // ISO time, UTC
  lat: number;
  lon: number;
  heading: number; // deg, compass
  stw: number; // m/s through the water
  outcome: string;
  weather?: { wind_u: number; wind_v: number; hs: number; tp?: number; wave_dir?: number; ghi?: number; rain?: number };
}

/** Which model and righting curve a race boat gets, from its Boatyard choices. */
export function boatFor(choices: Record<string, string>): { spec: BoatSpec; hull: HullParams } {
  const base = choices.base ?? "kayak";
  if (base === "revb") return { spec: RANDOLPH, hull: RANDOLPH_REVB };
  if (base === "revc") return { spec: RANDOLPH, hull: RANDOLPH_REVC };
  if (isStock(base)) return { spec: STOCK[base], hull: STOCK_HULL[base] };
  return { spec: KAYAK, hull: KAYAK_V4 };
}

const utc = (iso: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z");

export class BoatView {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly controls: OrbitControls;
  private readonly atmos: Atmosphere;
  private readonly sea: Sea;
  private readonly clouds = new Clouds();
  private readonly rain = new Rain();
  private readonly live: LiveSea;
  private readonly place: Placement = { x: 0, z: 0, yaw: 0 };
  private motion: BoatMotion;
  private spec: BoatSpec = KAYAK;
  private model: BoatModel | null = null;
  private wake: Wake | null = null;
  private contact: Contact | null = null;
  private state: ViewState | null = null;
  private yaw: number | null = null;
  private heave = 0;
  private storm = 0;
  private readonly bowW = new THREE.Vector3();
  /** For the smoke test: frames drawn, and what the boat shows. */
  readonly shown = { frames: 0, boat: "kayak", heading: 0, hs: 0 };

  /** The picture's quality: as asked, or for "auto" High on a graphics card and Low on
   *  software graphics, as the helm and Boatyard do (High there drew under one frame a
   *  second, so a click or screenshot in CI could wait 30 s). */
  private readonly quality: "high" | "low";

  constructor(
    private readonly box: HTMLElement,
    asked: "high" | "low" | "auto",
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.55;
    box.appendChild(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 12000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.minDistance = 2;
    this.controls.maxDistance = 60;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.enableZoom = true;
    this.atmos = new Atmosphere(this.renderer, this.scene, this.camera);
    const quality = (this.quality = asked === "auto" ? (this.atmos.software ? "low" : "high") : asked);
    const ratio = quality === "high" ? Math.min(window.devicePixelRatio, 2) : this.atmos.software ? 0.5 : 1;
    this.renderer.setPixelRatio(ratio);
    this.atmos.setPixelRatio(ratio);
    this.atmos.setBloom(false);
    this.sea = new Sea(quality);
    this.scene.add(this.sea.mesh, this.clouds.group, this.rain.mesh);
    this.live = new LiveSea(undefined, { n: quality === "high" ? 20 : 12, smoothing: 0.4 });
    this.motion = new BoatMotion(KAYAK_V4, this.place);
    this.resize();
    this.setBoat(KAYAK, KAYAK_V4);
  }

  resize(): void {
    const w = Math.max(this.box.clientWidth, 10);
    const h = Math.max(this.box.clientHeight, 10);
    this.renderer.setSize(w, h);
    this.atmos.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Put a boat in this view, with the camera stood back for its size. */
  setBoat(spec: BoatSpec, hull: HullParams): void {
    this.spec = spec;
    this.shown.boat = spec.key;
    this.motion = new BoatMotion(hull, this.place);
    const k = THREE.MathUtils.clamp(spec.length / KAYAK.length, 0.6, 3.4);
    this.camera.position.set(-6.5 * k, 2.2 * k, 3.5 * k);
    this.controls.target.set(0, 0.3 + Math.max(k - 1, 0) * 2.2, 0);
    this.controls.minDistance = 1.5 * k;
    this.heave = 0;
    this.build();
    if (isStock(spec.key) && !hasDetailedStock(spec.key)) {
      const key = spec.key;
      void loadStockModel(key).then((ok) => ok && this.spec.key === key && this.build());
    }
  }

  /** Rebuild the boat (after the detailed models load). */
  build(): void {
    if (this.model) {
      this.scene.remove(this.model.root);
      this.model.dispose();
    }
    if (this.wake) {
      this.scene.remove(this.wake.points);
      this.wake.dispose();
    }
    if (this.contact) {
      this.scene.remove(this.contact.collar, this.contact.spray);
      this.contact.dispose();
    }
    this.model = BUILDERS[this.spec.key](this.quality);
    this.contact = new Contact(this.model.form, this.spec, this.quality, this.model.root);
    this.contact.surface = (c, x, z, t) => this.sea.surfaceAt(c, x, z, t);
    this.contact.collar.visible = this.contact.spray.visible = !this.model.twinHull;
    this.wake = new Wake(this.quality, this.spec.cruiseSpeed, this.spec.beam, this.model.stern.x);
    this.wake.surface = (c, x, z, t) => this.sea.surfaceAt(c, x, z, t);
    this.scene.add(this.model.root, this.wake.points, this.contact.collar, this.contact.spray);
  }

  set(s: ViewState | null): void {
    this.state = s;
  }

  frame(t: number, dt: number): void {
    const s = this.state;
    const w = s?.weather;
    const hs = Math.max(w?.hs ?? 0.6, 0.05);
    const tp = Math.max(w?.tp ?? 3 + 2.5 * Math.sqrt(hs), 2);
    const wu = w?.wind_u ?? 3;
    const wv = w?.wind_v ?? 0;
    this.live.setSeaState(hs, tp, w?.wave_dir ?? 270);
    // The water flows past the boat at its speed (last frame's heading), in real time.
    const run = s && s.outcome === "at_sea" ? Math.max(s.stw, 0) * dt : 0;
    if (this.yaw !== null && run > 0) {
      const fx = run * Math.cos(this.yaw);
      const fz = -run * Math.sin(this.yaw);
      this.live.flow(fx, fz);
      this.sea.flow(fx, fz);
    }
    const comps = this.live.advance(t);
    this.sea.setSea(hs, Math.hypot(wu, wv), new THREE.Vector2(wu, -wv));
    this.sea.update(comps, t);
    // A boat that has finished or been lost sits still; otherwise it sails on its heading.
    const sailing = !s || s.outcome === "at_sea";
    const stw = s && sailing ? Math.max(s.stw, 0) : 0;
    const yaw = THREE.MathUtils.degToRad(90 - (s?.heading ?? 90));
    if (this.yaw === null) this.yaw = yaw;
    const dyaw = Math.atan2(Math.sin(yaw - this.yaw), Math.cos(yaw - this.yaw));
    const step = dyaw * Math.min(1, dt * 1.5);
    this.yaw += step;
    this.place.yaw = this.yaw;
    this.motion.pose.yaw = this.yaw;
    const off = this.camera.position.clone().sub(this.controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
    this.camera.position.copy(this.controls.target).add(off);
    this.motion.advance(comps, t);
    const flow = apparentFlow(wu, wv, stw, 90 - THREE.MathUtils.radToDeg(this.yaw));
    const m = this.model;
    if (m) {
      m.root.position.set(0, this.motion.heave - this.spec.cgBelowWaterline, 0);
      m.root.rotation.set(this.motion.roll, this.yaw, this.motion.pitch, "YZX");
      m.root.updateMatrixWorld();
      if (this.contact) {
        this.bowW.set(this.contact.bow[0], this.spec.cgBelowWaterline, this.contact.bow[1]);
        m.root.localToWorld(this.bowW);
        this.contact.update(comps, t, this.place, hs, { speed: stw, bowClearance: this.bowW.y - heightAt(comps, this.bowW.x, this.bowW.z, t), light: this.atmos.foamLight });
      }
      m.gear.update(
        { speed: stw / this.spec.cruiseSpeed, rudder: rudderFor(dt > 0 ? step / dt : 0), sun: (w?.ghi ?? 500) / 1000, comms: "", flow, failed: new Map() },
        t,
      );
      m.rig?.update(dt, { flow, plan: null, rudder: m.gear.shown.rudder });
    }
    this.wake?.update(comps, t, this.place, stw);
    const dy = this.motion.heave - this.heave;
    this.heave = this.motion.heave;
    this.camera.position.y += dy;
    this.controls.target.y += dy;
    const target = THREE.MathUtils.clamp((Math.hypot(wu, wv) * KN - 15) / 20, 0, 1);
    this.storm += (target - this.storm) * Math.min(1, dt * 1.5);
    const ms = s ? utc(s.t) : Date.UTC(2020, 3, 1, 14);
    const lat = s?.lat ?? 36.65;
    const lon = s?.lon ?? -74.94;
    const sp = sunPosition(ms, lat, lon);
    this.atmos.setCelestial(ms, lat, lon);
    this.atmos.set(sp.el, sp.az, this.storm);
    this.clouds.update(t, dt, this.camera, cloudFromSun(w?.ghi ?? null, sp.el), this.storm, fogChance(lat, lon, Math.hypot(wu, wv) * KN, ms / 86400e3), wu, -wv, this.atmos.sunDir, this.atmos.fog.color, this.atmos.ambient);
    this.clouds.closeIn(this.atmos.fog);
    this.rain.update(t, this.camera, rainFromRate(w?.rain ?? 0), wu, -wv, this.atmos.ambient);
    this.sea.setSun(this.atmos.glintDir, this.atmos.glintLight);
    this.wake?.setLight(this.atmos.foamLight);
    this.controls.update();
    const floor = heightAt(comps, this.camera.position.x, this.camera.position.z, t) + 0.35;
    if (this.camera.position.y < floor) this.camera.position.y = floor;
    this.atmos.render();
    this.shown.frames++;
    this.shown.heading = s?.heading ?? 0;
    this.shown.hs = hs;
  }
}
