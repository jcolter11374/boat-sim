// Phase 1: both boats side by side on a live sea.
//
// The boats are drawn from their real measurements (boats/), float on the
// same Gerstner sea that is drawn (waves.ts), and move by Theo's wave-motion
// model (motion.ts): heave, pitch and roll from each hull's own stability.
// The simple surface follower (standin.ts) is kept as a fallback.

import * as THREE from "three";
import { detailFor } from "./seaDetail";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BUILDERS, loadDetailedModels, type BoatModel } from "./boats/model";
import type { Quality } from "./boats/parts";
import { BOATS, STOCK_HULL, type BoatSpec } from "./boats/specs";
import { BoatMotion, KAYAK_V4, RANDOLPH_REVB, type HullParams } from "./motion";
import { SurfaceFollower, toWorld, type Placement } from "./standin";
import { Wake } from "./wake";
import { Contact } from "./contact";
import { FpsGuard, geometryOf, shadowsOn, startLook, type Look } from "./ultra";
import { Atmosphere } from "./atmosphere";
import { Sea } from "./water";
import { SEA_STATES, components, heightAt, hsOf, type SeaState, type WaveComponent } from "./waves";
import { mountSailLink } from "./sailLink";
import { Clouds } from "./clouds";
import { seaUniforms } from "./seaSurface";
import { heightOf, titleHeading, titleShot } from "./framing";
import { loadMyBoat, onMyBoatChange } from "./myboat";
import { hasDetailedStock, loadStockModel } from "./boats/stock";
import type { StockKey } from "./boats/specs";
import { setBacklight } from "./boats/nightlook";
import { HERO_CLOUD, HERO_SEA, HERO_SKY_DAY, HERO_SUN, cardBelowOf, cardRightOf, heroSpec } from "./titleHero";
import { prefetchHelm } from "./helm/prefetch";

// Which motion model moves the boats. Physics by default; ?motion=standin for the fallback.
const PHYSICS = new URLSearchParams(location.search).get("motion") !== "standin";
const HULLS: Record<BoatSpec["key"], HullParams> = {
  kayak: KAYAK_V4,
  randolph: RANDOLPH_REVB,
  ...STOCK_HULL,
};
interface Mover {
  heave: number; // waterline height above still water, m
  pitch: number; // rad, bow up +
  roll: number; // rad, heel to starboard +
  advance(comps: WaveComponent[], t: number): void;
}
const MOTION_LABEL = PHYSICS
  ? "Motion: physics model (each hull's own weight, buoyancy and stability)"
  : SurfaceFollower.label;
function newMotion(spec: BoatSpec, place: Placement, t: number): Mover {
  if (!PHYSICS) return new SurfaceFollower(spec, place);
  const m = new BoatMotion(HULLS[spec.key], place);
  m.t = t; // start from now, not from t = 0
  return m;
}
const SPACING = 2.6; // m between the boats' centrelines (display)
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const app = $("app");
const seaSelect = $<HTMLSelectElement>("sea");
const qualitySelect = $<HTMLSelectElement>("quality");
const headingSelect = $<HTMLSelectElement>("heading");
const underCheck = $<HTMLInputElement>("under");
const tourCheck = $<HTMLInputElement>("tour");
$("motion-label").textContent = MOTION_LABEL;
if (PHYSICS) $("motion-label").className = "muted";

// ---------- renderer, sky, light ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.5;
controls.maxDistance = 80;
controls.maxPolarAngle = Math.PI * 0.495;
controls.autoRotateSpeed = 0.35;

// Late-afternoon sun low over the sea, so the glint shows the wave shapes.
const atmos = new Atmosphere(renderer, scene, camera);
atmos.set(10, 330, 0, true);

// ---------- sea, boats, wakes ----------
const clock = new THREE.Clock();
// ?quality=low|high|ultra picks the starting look (the smoke test runs Low on software graphics).
let look: Look = startLook(qualitySelect);
// The title screen's Take the helm: fetch its simulator at idle so Set sail is quick (F2).
prefetchHelm(new URL(new URLSearchParams(location.search).get("sandbox") ?? "./sandbox/", location.href).href);
mountSailLink(); // "Sail this sea" follows the sea-state and quality pickers (after ?quality= is read)
let quality: Quality = geometryOf(look);
const sea = new Sea(quality);
scene.add(sea.mesh);
sea.mesh.receiveShadow = true; // boat shadows on the water (Ultra)

interface Boat {
  spec: BoatSpec;
  model: BoatModel;
  motion: Mover;
  wake: Wake;
  contact: Contact;
  place: Placement;
  tag: HTMLDivElement;
}
const boats: Boat[] = BOATS.map((spec) => {
  const tag = document.createElement("div");
  tag.className = "tag";
  tag.style.setProperty("--c", "#" + spec.colour.toString(16).padStart(6, "0"));
  tag.innerHTML = `<b></b><span></span>`;
  tag.querySelector("b")!.textContent = spec.key === "kayak" ? "Our kayak" : "Randolph boat (our model)";
  tag.querySelector("span")!.textContent = `${spec.length.toFixed(2)} m, ${spec.massKg} kg`;
  $("tags").appendChild(tag);
  const place = { x: 0, z: 0, yaw: 0 };
  return { spec, model: null!, motion: newMotion(spec, place, 0), wake: null!, contact: null!, place, tag };
});

function buildBoats(q: Quality): void {
  for (const b of boats) {
    if (b.model) {
      scene.remove(b.model.root);
      b.model.dispose();
    }
    if (b.wake) {
      scene.remove(b.wake.points);
      b.wake.dispose();
    }
    if (b.contact) {
      scene.remove(b.contact.collar, b.contact.spray);
      b.contact.dispose();
    }
    b.model = BUILDERS[b.spec.key](q);
    b.contact = new Contact(b.model.form, b.spec, q, b.model.root);
    b.contact.surface = (c, x, z, t) => sea.surfaceAt(c, x, z, t);
    scene.add(b.contact.collar, b.contact.spray);
    b.wake = new Wake(q, b.spec.cruiseSpeed, b.spec.beam, b.model.stern.x);
    b.wake.surface = (c, x, z, t) => sea.surfaceAt(c, x, z, t);
    shadowsOn(b.model.root);
    scene.add(b.model.root, b.wake.points);
  }
}

// ---------- the title hero: the player's own boat, alone, at golden hour ----------
let hero: Boat | null = null;
const heroOn = () => document.body.classList.contains("title");
const heroPlace: Placement = { x: 0, z: 0, yaw: 0 };
function buildHero(q: Quality): void {
  if (hero) {
    scene.remove(hero.model.root, hero.wake.points, hero.contact.collar, hero.contact.spray);
    hero.model.dispose();
    hero.wake.dispose();
    hero.contact.dispose();
    hero = null;
  }
  if (!heroOn()) return;
  const spec = heroSpec(loadMyBoat());
  const model = BUILDERS[spec.key](q);
  const contact = new Contact(model.form, spec, q);
  contact.collar.visible = contact.spray.visible = !model.twinHull && spec.key !== "randolph";
  const wake = new Wake(q, spec.cruiseSpeed, spec.beam, model.stern.x);
  shadowsOn(model.root);
  scene.add(model.root, wake.points, contact.collar, contact.spray);
  hero = { spec, model, motion: newMotion(spec, heroPlace, clock.getElapsedTime()), wake, contact, place: heroPlace, tag: null! };
  // A stock boat's detailed model loads on demand: swap it in when it arrives.
  if (spec.key.startsWith("stock_") && !hasDetailedStock(spec.key as StockKey)) {
    const k = spec.key as StockKey;
    void loadStockModel(k).then((ok) => ok && hero?.spec.key === k && buildHero(quality));
  }
}
const clouds = new Clouds(quality);
clouds.group.visible = false;
scene.add(clouds.group);
let heroWas = false;
/** Into or out of the title: the hero's boat, sun, sky and sea; or the two demo boats as before. */
function heroMode(): void {
  const on = heroOn();
  if (on === heroWas && (!on || hero)) return;
  heroWas = on;
  buildHero(quality);
  for (const b of boats) {
    b.model.root.visible = b.wake.points.visible = !on;
    b.contact.collar.visible = b.contact.spray.visible = !on;
    b.tag.style.visibility = on ? "hidden" : "";
  }
  clouds.group.visible = on;
  controls.enabled = !on;
  if (on) {
    atmos.cloud = HERO_CLOUD;
    atmos.set(HERO_SUN.el, HERO_SUN.az, 0, true);
    clouds.seed(HERO_SKY_DAY);
    heroPlace.yaw = titleHeading(atmos.sunDir);
    setSea("title", HERO_SEA);
    // Backlit (Ines): the near side of the boat in her own shadow, her edges and sails lit
    // by the sun behind her. Less fill from the sky dome and the sky's reflections.
    setBacklight(atmos.sunDir, 1, atmos.sun.color);
    atmos.hemi.intensity *= 0.35;
    scene.environmentIntensity = 0.25;
  } else {
    atmos.cloud = 0;
    setBacklight(atmos.sunDir, 0);
    atmos.set(10, 330, 0, true);
    seaUniforms.uSeaSky.value.set(0, 0, 0, 0);
    seaUniforms.uSeaBreak.value.set(0, 0, 0, 0);
    camera.fov = 45;
    camera.updateProjectionMatrix();
    setSea(seaSelect.value);
    placeBoats();
    goTo("side", true);
  }
}

let comps: WaveComponent[] = [];
let seaKey = seaSelect.value;
function setSea(key: string, state: SeaState = SEA_STATES[key]): void {
  seaKey = key;
  comps = components(state);
  sea.setSea(state.hs);
  for (const b of [...boats, ...(hero ? [hero] : [])]) {
    b.motion = newMotion(b.spec, b.place, clock.getElapsedTime());
    b.wake.reset();
  }
}

/** Heading of both boats relative to the waves. Positions: side by side, across the heading. */
function placeBoats(): void {
  const waves = SEA_STATES[seaKey].meanDirection; // waves travel this way (from +x towards +z)
  const rel = Number(headingSelect.value); // degrees between the bow and the wave direction
  const heading = waves + THREE.MathUtils.degToRad(rel);
  const yaw = -heading; // three.js rotation.y
  boats.forEach((b, i) => {
    const off = (i === 0 ? -0.5 : 0.5) * SPACING;
    const [x, z] = toWorld(0, off, { x: 0, z: 0, yaw });
    b.place.x = x;
    b.place.z = z;
    b.place.yaw = yaw;
    b.motion = newMotion(b.spec, b.place, clock.getElapsedTime());
    b.wake.reset();
  });
}

function setQuality(l: Look): void {
  look = l;
  const q = geometryOf(l);
  quality = q;
  sea.setQuality(q);
  sea.setDetail(detailFor(l));
  buildBoats(q);
  if (hero) buildHero(q);
  // Low on software graphics (no graphics card) draws at half resolution to keep moving.
  const ratio = q === "high" ? Math.min(window.devicePixelRatio, 2) : atmos.software ? 0.5 : 1;
  renderer.setPixelRatio(ratio);
  atmos.setBloom(q === "high");
  atmos.setUltra(l === "ultra");
  atmos.setPixelRatio(ratio);
}

// ---------- camera presets ----------
interface Shot {
  pos: [number, number, number]; // in the boats' frame: +x ahead, +z to starboard
  look: [number, number, number];
}
const SHOTS: Record<string, Shot> = {
  side: { pos: [3.5, 2.6, 7.5], look: [0, 0.2, 0] },
  kayak: { pos: [2.6, 1.5, -3.6], look: [0, 0.1, -SPACING / 2] },
  randolph: { pos: [1.8, 1.2, 3.6], look: [0, 0.35, SPACING / 2] },
  low: { pos: [9, 1.3, 1.2], look: [0, 0.3, 0] },
  high: { pos: [-14, 11, 10], look: [0, 0, 0] },
};
let tween: { from: [THREE.Vector3, THREE.Vector3]; to: [THREE.Vector3, THREE.Vector3]; t0: number } | null = null;
function shotVectors(key: string): [THREE.Vector3, THREE.Vector3] {
  const s = SHOTS[key];
  const yaw = boats[0].place.yaw;
  const w = (p: [number, number, number]) => {
    const [x, z] = toWorld(p[0], p[2], { x: 0, z: 0, yaw });
    return new THREE.Vector3(x, p[1], z);
  };
  return [w(s.pos), w(s.look)];
}
function goTo(key: string, instant = false): void {
  const to = shotVectors(key);
  document.querySelectorAll<HTMLButtonElement>("#shots button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.shot === key)));
  if (instant) {
    camera.position.copy(to[0]);
    controls.target.copy(to[1]);
    tween = null;
  } else {
    tween = { from: [camera.position.clone(), controls.target.clone()], to, t0: performance.now() };
  }
}
document.querySelectorAll<HTMLButtonElement>("#shots button").forEach((b) => b.addEventListener("click", () => goTo(b.dataset.shot!)));

// ---------- controls ----------
seaSelect.addEventListener("change", () => {
  setSea(seaSelect.value);
  placeBoats();
});
qualitySelect.addEventListener("change", () => setQuality(qualitySelect.value as Look));
headingSelect.addEventListener("change", () => {
  placeBoats();
  goTo(document.querySelector<HTMLButtonElement>('#shots button[aria-pressed="true"]')?.dataset.shot ?? "side");
});
underCheck.addEventListener("change", () => sea.setSeeThrough(underCheck.checked));
tourCheck.addEventListener("change", () => (controls.autoRotate = tourCheck.checked));
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  atmos.setSize(window.innerWidth, window.innerHeight);
});

setQuality(look);
// The detailed (Blender) boats, when the build has them: swap them in once loaded.
loadDetailedModels().then((ok) => {
  if (ok) {
    buildBoats(quality);
    heroWas = !heroOn();
    heroMode();
  }
});
setSea(seaKey);
placeBoats();
goTo("side", true);
heroMode();
new MutationObserver(heroMode).observe(document.body, { attributes: true, attributeFilter: ["class"] });
onMyBoatChange(() => heroOn() && buildHero(quality));

// ---------- hooks for the smoke test ----------
interface BoatStatus {
  key: string;
  heave: number;
  pitch: number;
  roll: number;
  surface: number; // sea height at the boat's centre
}
const status = {
  frames: 0,
  hs: 0,
  sea: seaKey,
  quality,
  seaVertices: 0,
  motion: MOTION_LABEL,
  physical: PHYSICS,
  boats: [] as BoatStatus[],
  maxRoll: {} as Record<string, number>, // largest |roll| seen since the sea state was set, rad
  /** The boat the title hero shows ("" when the title is off). */
  hero: "",
};
(window as unknown as { __sea3d: typeof status }).__sea3d = status;
seaSelect.addEventListener("change", () => (status.maxRoll = {}));

// ---------- loop ----------
/** What titleShot needs to know about the hero's boat now. */
function heroHost(t: number) {
  const b = hero!;
  return {
    camera,
    controls,
    yaw: () => b.place.yaw,
    length: () => b.spec.length,
    height: () => heightOf(b.model.root, b.model.root.position.y + b.spec.cgBelowWaterline),
    water: (x: number, z: number) => heightAt(comps, x, z, t),
    sunDir: () => atmos.sunDir,
  };
}
let heroT = 0;
function heroDt(t: number): number {
  const dt = Math.min(0.1, Math.max(0, t - heroT));
  heroT = t;
  return dt;
}
const guard = new FpsGuard();
const bowW = new THREE.Vector3();
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);
const v = new THREE.Vector3();
let rigHeave = 0; // camera height offset that follows the swell
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  sea.update(comps, t);
  status.boats = boats.map((b) => {
    b.motion.advance(comps, t);
    const root = b.model.root;
    root.position.set(b.place.x, b.motion.heave - b.spec.cgBelowWaterline, b.place.z); // heave is waterline-relative; origin is the CG
    root.rotation.set(b.motion.roll, b.place.yaw, b.motion.pitch, "YZX");
    b.model.animate(t);
    b.wake.update(comps, t, b.place);
    root.updateMatrixWorld();
    bowW.set(b.contact.bow[0], b.spec.cgBelowWaterline, b.contact.bow[1]);
    root.localToWorld(bowW);
    b.contact.update(comps, t, b.place, hsOf(comps), {
      speed: b.spec.cruiseSpeed,
      bowClearance: bowW.y - heightAt(comps, bowW.x, bowW.z, t),
      light: atmos.foamLight,
    });
    status.maxRoll[b.spec.key] = Math.max(status.maxRoll[b.spec.key] ?? 0, Math.abs(b.motion.roll));
    return {
      key: b.spec.key,
      heave: b.motion.heave,
      pitch: b.motion.pitch,
      roll: b.motion.roll,
      surface: heightAt(comps, b.place.x, b.place.z, t),
    };
  });
  if (hero) {
    const b = hero;
    b.motion.advance(comps, t);
    const root = b.model.root;
    root.position.set(b.place.x, b.motion.heave - b.spec.cgBelowWaterline, b.place.z);
    root.rotation.set(b.motion.roll, b.place.yaw, b.motion.pitch, "YZX");
    b.model.animate(t);
    b.wake.update(comps, t, b.place);
    root.updateMatrixWorld();
    bowW.set(b.contact.bow[0], b.spec.cgBelowWaterline, b.contact.bow[1]);
    root.localToWorld(bowW);
    b.contact.update(comps, t, b.place, hsOf(comps), {
      speed: b.spec.cruiseSpeed,
      bowClearance: bowW.y - heightAt(comps, bowW.x, bowW.z, t),
      light: atmos.ambient,
    });
    // The shot: titleShot's 20 s loop, the boat right of the menu, looking into the low sun.
    const card = document.getElementById("title");
    const shot = titleShot(heroHost(t), t, cardRightOf(card, window.innerWidth), cardBelowOf(card, window.innerWidth, window.innerHeight));
    camera.position.copy(shot.pos);
    camera.quaternion.copy(shot.quat);
    if (camera.fov !== shot.fov) {
      camera.fov = shot.fov;
      camera.updateProjectionMatrix();
    }
    const under = heightAt(comps, camera.position.x, camera.position.z, t) + 0.35;
    if (camera.position.y < under) camera.position.y = under;
    clouds.update(t, heroDt(t), camera, HERO_CLOUD, 0, 0, 3, 1, atmos.sunDir, atmos.fog.color, atmos.ambient);
    clouds.closeIn(atmos.fog);
    atmos.cloud = clouds.cover;
    clouds.seaSky(seaUniforms.uSeaSky.value);
    clouds.seaBreak(seaUniforms.uSeaBreak.value);
    sea.setSun(atmos.glintDir, atmos.glintLight);
    atmos.render();
    status.frames++;
    status.hs = hsOf(comps);
    status.hero = b.spec.key;
    return;
  }
  status.hero = "";
  // Camera rides the swell with the boats (mean heave), and never dips under the water.
  const meanHeave = boats.reduce((a, b) => a + b.motion.heave, 0) / boats.length;
  const dy = meanHeave - rigHeave;
  rigHeave = meanHeave;
  camera.position.y += dy;
  controls.target.y += dy;
  if (tween) for (const p of [...tween.from, ...tween.to]) p.y += dy;
  if (tween) {
    const k = Math.min((performance.now() - tween.t0) / 1200, 1);
    const e = ease(k);
    camera.position.lerpVectors(tween.from[0], tween.to[0], e);
    controls.target.lerpVectors(tween.from[1], tween.to[1], e);
    if (k >= 1) tween = null;
  }
  controls.update();
  const floor = heightAt(comps, camera.position.x, camera.position.z, t) + 0.35;
  if (camera.position.y < floor) camera.position.y = floor;
  sea.setSun(atmos.glintDir, atmos.glintLight);
  // Ultra: focus where the camera looks, shadows round both boats; back to High if too slow.
  if (atmos.ultra) {
    atmos.setFocus(camera.position.distanceTo(controls.target));
    atmos.shadowAround(controls.target, 6);
  }
  if (guard.tick(t, look === "ultra")) {
    qualitySelect.value = "high";
    setQuality("high");
  }
  atmos.render();
  // Name tags above each boat.
  const w = window.innerWidth;
  const h = window.innerHeight;
  for (const b of boats) {
    v.set(0, b.model.tagHeight, 0);
    b.model.root.localToWorld(v);
    v.project(camera);
    const show = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    b.tag.style.display = show ? "" : "none";
    if (show) b.tag.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px) translate(-50%, -100%)`;
  }
  status.frames++;
  status.hs = hsOf(comps);
  status.sea = seaKey;
  status.quality = quality;
  status.seaVertices = sea.vertexCount;
});
