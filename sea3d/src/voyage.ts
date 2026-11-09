// Phase 2: replay one simulated voyage of our kayak.
//
// Everything shown comes from a replay file written by the simulator
// (boatsim.runner.replay): position, heading, speed, battery, the weather and
// sea the boat met each hour, and what happened. Between logged hours the page
// interpolates; at each logged hour it shows exactly the logged value.
//
// Two clocks: voyage time (hours since launch) runs at the chosen time warp;
// the close-up sea runs in real time, so the waves always move naturally while
// their size and direction follow the voyage hour by hour.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { BUILDERS, type BoatModel } from "./boats/model";
import type { Quality } from "./boats/parts";
import { KAYAK } from "./boats/specs";
import { BoatMotion, KAYAK_V4 } from "./motion";
import { Chart, TONE_COLOUR, type LandBounds } from "./replay/chart";
import {
  angleAt,
  commsAt,
  describeEvent,
  distanceKm,
  isNotable,
  lastHour,
  loadIndex,
  loadReplay,
  positionAt,
  toneOf,
  valueAt,
  type IndexEntry,
  type Replay,
} from "./replay/data";
import type { Placement } from "./standin";
import { Wake } from "./wake";
import { Atmosphere, sunPosition } from "./atmosphere";
import { Sea } from "./water";
import { heightAt, Sea as LiveSea } from "./waves";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const BASE = params.get("data") ?? "./voyages";

// ---------- renderer; sky, light and haze come from atmosphere.ts ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.5;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.495;
const atmos = new Atmosphere(renderer, scene, camera);

// ---------- sea and boat ----------
let quality = ($<HTMLSelectElement>("quality").value as Quality) ?? "high";
const sea = new Sea(quality);
scene.add(sea.mesh);
const place: Placement = { x: 0, z: 0, yaw: 0 };
let model: BoatModel | null = null;
let wake: Wake | null = null;
let motion = new BoatMotion(KAYAK_V4, place);
function buildBoat(q: Quality): void {
  if (model) {
    scene.remove(model.root);
    model.dispose();
  }
  if (wake) {
    scene.remove(wake.points);
    wake.dispose();
  }
  model = BUILDERS.kayak(q);
  wake = new Wake(q, KAYAK.cruiseSpeed, KAYAK.beam, model.stern.x);
  scene.add(model.root, wake.points);
}
function setQuality(q: Quality): void {
  quality = q;
  sea.setQuality(q);
  buildBoat(q);
  live = new LiveSea(undefined, { n: N_COMP[q], smoothing: 0.4 });
  if (rep) {
    seaTarget(rep, hour);
    live.snap();
  }
  const ratio = q === "high" ? Math.min(window.devicePixelRatio, 2) : 1;
  renderer.setPixelRatio(ratio);
  atmos.setBloom(q === "high");
  atmos.setPixelRatio(ratio);
}

// ---------- the sea of a voyage hour ----------
// Theo's live sea (#133): realistic JONSWAP wave trains that ease toward each
// hour's logged Hs, Tp and wave direction without jumps. The inputs are already
// interpolated between logged hours, so only a short easing is needed.
const N_COMP = { low: 16, high: 24 } as const;
let live = new LiveSea(undefined, { n: N_COMP[quality], smoothing: 0.4 });
function seaTarget(rep: Replay, hour: number): number {
  const hs = Math.max(valueAt(rep, rep.hs, hour) ?? 0.3, 0.05);
  const tp = Math.max(valueAt(rep, rep.tp, hour) ?? 3 + 2.5 * Math.sqrt(hs), 2);
  const from = angleAt(rep, rep.wave_dir, hour) ?? 270;
  live.setSeaState(hs, tp, from);
  return hs;
}

// ---------- chart ----------
const land = new Image();
let chart: Chart | null = null;
const chartBox = $("chartbox");
chartBox.addEventListener("click", () => chartBox.classList.toggle("big"));

// ---------- state ----------
let rep: Replay | null = null;
let hour = 0;
let playing = false;
let warp = 24; // voyage hours per real second
let shownEvents = 0;
let ended = false;
const status = {
  ready: false,
  error: "",
  file: "",
  hour: 0,
  maxHour: 0,
  playing: false,
  frames: 0,
  outcome: "",
  shown: [] as string[],
  positionAt: (h: number): [number, number] => (rep ? positionAt(rep, h) : [NaN, NaN]),
  /** Where the chart draws the boat right now (same function as above). */
  boatPosition: (): [number, number] => (rep ? positionAt(rep, hour) : [NaN, NaN]),
  setHour: (h: number) => seek(h),
  play: () => setPlaying(true),
  pause: () => setPlaying(false),
  select: (f: string) => selectVoyage(f),
};
(window as unknown as { __replay: typeof status }).__replay = status;

/** Replay times are UTC; add the Z when the file leaves the zone off. */
const utc = (iso: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z");
const fmtDate = (rep: Replay, h: number) => {
  const d = new Date(utc(rep.start) + h * 3600e3);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) +
    " " + d.toISOString().slice(11, warp < 1 / 60 ? 19 : 16) + " UTC"; // seconds when they tick by
};
const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const compass = (deg: number) => COMPASS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];

function setPlaying(p: boolean): void {
  playing = p && !!rep;
  if (playing && rep && hour >= lastHour(rep)) seek(0);
  $("play").innerHTML = playing ? "&#10073;&#10073;" : "&#9654;";
  status.playing = playing;
}

function seek(h: number): void {
  if (!rep) return;
  hour = Math.min(Math.max(h, 0), lastHour(rep));
  shownEvents = rep.events.filter((e) => e.h <= hour).length;
  ended = false; // the loop shows the outcome card if this is the end
  seaTarget(rep, hour);
  live.snap();
  $("outcome").classList.remove("show");
}

function toast(text: string, when: string, colour: string): void {
  const box = $("toasts");
  const t = document.createElement("div");
  t.className = "toast glass";
  t.style.setProperty("--c", colour);
  const b = document.createElement("b");
  b.textContent = when;
  t.append(b, document.createTextNode(text));
  box.prepend(t);
  while (box.children.length > 4) box.lastChild!.remove();
  setTimeout(() => t.remove(), 6000);
}

const OUTCOME: Record<string, [string, string]> = {
  arrived: ["Finished!", "var(--good)"],
  lost: ["Boat lost", "var(--bad)"],
  aground: ["Ran aground", "var(--bad)"],
  disqualified: ["Disqualified", "var(--bad)"],
  timeout: ["Still at sea", "var(--warn)"],
};
function showOutcome(): void {
  if (!rep) return;
  const [title, colour] = OUTCOME[rep.outcome] ?? [rep.outcome, "var(--ink)"];
  $("o-title").textContent = title;
  $("o-title").style.color = colour;
  const last = [...rep.events].reverse().find((e) => isNotable(e));
  const days = `after ${rep.days.toFixed(1)} days`;
  const why =
    rep.outcome === "arrived"
      ? "Reached the 25 km target circle off Portugal, which counts as a finish under the race rules."
      : rep.outcome === "timeout"
        ? "Still sailing when the simulation stopped, so it doesn't count as a finish."
        : last
          ? describeEvent(last) + "."
          : "";
  $("o-text").textContent = `${days}. ${why}`;
  $("outcome").classList.add("show");
}

async function selectVoyage(f: string): Promise<void> {
  try {
    const r = await loadReplay(BASE, f);
    rep = r;

    chart?.setReplay(r);
    status.file = f;
    status.maxHour = lastHour(r);
    status.outcome = r.outcome;
    status.shown = [];
    motion = new BoatMotion(KAYAK_V4, place);
    wake?.reset();
    ticks(r);
    $<HTMLInputElement>("scrub").max = String(lastHour(r));
    $<HTMLSelectElement>("voyage").value = f;
    seek(0);
    setPlaying(true);
    status.ready = true;
  } catch (e) {
    fail(String(e));
  }
}

function ticks(r: Replay): void {
  const box = $("ticks");
  box.innerHTML = "";
  const max = lastHour(r) || 1;
  for (const e of r.events) {
    if (!isNotable(e)) continue;
    const i = document.createElement("i");
    i.style.left = `${(100 * e.h) / max}%`;
    i.style.background = TONE_COLOUR[toneOf(e)];
    i.title = describeEvent(e);
    box.appendChild(i);
  }
}

function fail(msg: string): void {
  status.error = msg;
  const box = $("error");
  box.style.display = "block";
  box.textContent = `Couldn't load the voyages: ${msg}`;
}

// ---------- controls ----------
$("play").addEventListener("click", () => setPlaying(!playing));
document.querySelectorAll<HTMLButtonElement>("#warp button").forEach((b) =>
  b.addEventListener("click", () => {
    warp = Number(b.dataset.warp);
    document.querySelectorAll("#warp button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }),
);
const scrub = $<HTMLInputElement>("scrub");
scrub.addEventListener("input", () => seek(Number(scrub.value)));
$<HTMLSelectElement>("voyage").addEventListener("change", (e) => selectVoyage((e.target as HTMLSelectElement).value));
$<HTMLSelectElement>("quality").addEventListener("change", (e) => setQuality((e.target as HTMLSelectElement).value as Quality));
$("o-again").addEventListener("click", () => {
  seek(0);
  setPlaying(true);
});
$("o-close").addEventListener("click", () => $("outcome").classList.remove("show"));
window.addEventListener("keydown", (e) => {
  if (e.key === " " && !(e.target instanceof HTMLSelectElement)) {
    e.preventDefault();
    setPlaying(!playing);
  }
});
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  atmos.setSize(window.innerWidth, window.innerHeight);
});

// The link to the showroom only works where both pages are served together.
if (!location.pathname.endsWith("voyage.html")) document.querySelector<HTMLElement>("#top a")!.style.display = "none";

// ---------- start ----------
setQuality(quality);
camera.position.set(-5.6, 2.0, 4.6);
controls.target.set(0, 0.2, 0);
(async () => {
  try {
    const [index, bounds] = await Promise.all([
      loadIndex(BASE),
      fetch("./land.json").then((r) => r.json() as Promise<LandBounds>),
      new Promise<void>((ok, bad) => {
        land.onload = () => ok();
        land.onerror = () => bad(new Error("land.png"));
        land.src = "./land.png";
      }),
    ]);
    chart = new Chart($<HTMLCanvasElement>("chart"), land, bounds);
    const sel = $<HTMLSelectElement>("voyage");
    const OUT: Record<string, string> = { arrived: "finished", lost: "lost", aground: "aground", disqualified: "disqualified", timeout: "still at sea" };
    index.forEach((v: IndexEntry) => {
      const o = document.createElement("option");
      o.value = v.file;
      const d = new Date(utc(v.start));
      o.textContent = `Launch ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })}: ${OUT[v.outcome] ?? v.outcome}, ${v.days.toFixed(0)} days`;
      sel.appendChild(o);
    });
    if (!index.length) throw new Error("the voyage list is empty");
    const want = params.get("voyage");
    // Default: the longest voyage, which has the most to watch.
    const longest = index.reduce((m, v) => (v.days > m.days ? v : m), index[0]);
    await selectVoyage(index.find((v) => v.file === want)?.file ?? longest.file);
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
  }
})();

// ---------- loop ----------
const clock = new THREE.Clock();
let last = 0;
let rigHeave = 0;
let smoothYaw: number | null = null;
let storm = 0; // 0 fair .. 1 gale, eased
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  const dt = Math.min(t - last, 0.1);
  last = t;
  if (rep && playing) {
    hour = Math.min(hour + dt * warp, lastHour(rep));
    if (hour >= lastHour(rep)) setPlaying(false);
  }
  if (rep) {
    // Events reached since last frame.
    while (shownEvents < rep.events.length && rep.events[shownEvents].h <= hour) {
      const e = rep.events[shownEvents++];
      if (!isNotable(e)) continue;
      status.shown.push(e.kind);
      // A knockdown: give the boat a hard shove so the physics rolls it over and
      // rights it again (the keel and dome do the righting, as designed).
      if (e.kind === "capsize" && warp <= 24) motion.rollRate += (Math.random() < 0.5 ? -1 : 1) * 7;
      toast(describeEvent(e), `Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
    }
    if (hour >= lastHour(rep) && !ended) {
      ended = true;
      showOutcome();
    }
    const hs = seaTarget(rep, hour);
    const comps = live.advance(t);
    {
      const wu = valueAt(rep, rep.wind_u, hour) ?? 0;
      const wv = valueAt(rep, rep.wind_v, hour) ?? 0;
      sea.setSea(hs, Math.hypot(wu, wv), new THREE.Vector2(wu, -wv)); // north = -z
    }
    sea.update(comps, t);
    // Heading: compass degrees -> scene yaw (bow along (cos yaw, -sin yaw) in x east, z south).
    const hdg = angleAt(rep, rep.heading, hour) ?? 90;
    const yaw = THREE.MathUtils.degToRad(90 - hdg);
    if (smoothYaw === null) smoothYaw = yaw;
    const dyaw = Math.atan2(Math.sin(yaw - smoothYaw), Math.cos(yaw - smoothYaw));
    const step = dyaw * Math.min(1, dt * 2.5);
    smoothYaw += step;
    place.yaw = smoothYaw;
    motion.pose.yaw = smoothYaw;
    // Turn the camera with the boat so the view keeps its framing.
    const off = camera.position.clone().sub(controls.target);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
    camera.position.copy(controls.target).add(off);
    motion.advance(comps, t);
    if (model) {
      model.root.position.set(0, motion.heave - KAYAK.cgBelowWaterline, 0);
      model.root.rotation.set(motion.roll, smoothYaw, motion.pitch, "YZX");
      model.animate(t);
    }
    const stw = Math.max(valueAt(rep, rep.stw, hour) ?? 0, 0);
    wake?.update(comps, t, place, stw);
    // Camera rides the swell.
    const dy = motion.heave - rigHeave;
    rigHeave = motion.heave;
    camera.position.y += dy;
    controls.target.y += dy;
    // Weather mood from the logged wind: greyer, darker and closer in a blow;
    // the sun where it really was for this hour and place.
    const wu = valueAt(rep, rep.wind_u, hour) ?? 0;
    const wv = valueAt(rep, rep.wind_v, hour) ?? 0;
    const target = THREE.MathUtils.clamp((Math.hypot(wu, wv) * 1.94384 - 15) / 20, 0, 1);
    storm += (target - storm) * Math.min(1, dt * 1.5);
    const [lat, lon] = positionAt(rep, hour);
    const sp = sunPosition(utc(rep.start) + hour * 3600e3, lat, lon);
    atmos.set(sp.el, sp.az, storm);
    sea.setSun(atmos.glintDir, atmos.glintLight);
    wake?.setLight(atmos.ambient);
    hud(rep, stw, hs);
    status.hour = hour;
  }
  controls.update();
  if (rep) {
    const floor = heightAt(live.advance(t), camera.position.x, camera.position.z, t) + 0.35;
    if (camera.position.y < floor) camera.position.y = floor;
  }
  atmos.render();
  chart?.draw(rep ? hour : 0, performance.now());
  status.frames++;
});

let lastHud = -1;
function hud(r: Replay, stw: number, hs: number): void {
  const now = performance.now();
  if (now - lastHud < 100) return;
  lastHud = now;
  const day = hour / 24;
  $("h-day").textContent = day.toFixed(1);
  $("h-date").textContent = fmtDate(r, hour);
  $("w-day").textContent = `Day ${day.toFixed(1)} of ${r.days.toFixed(1)}`;
  $("w-date").textContent = fmtDate(r, hour);
  if (document.activeElement !== scrub) scrub.value = String(hour);
  const soc = valueAt(r, r.soc, hour);
  $("h-soc").innerHTML = soc == null ? "-" : `${Math.round(soc * 100)}<small>%</small>`;
  const bar = $("h-socbar");
  bar.style.width = `${Math.round((soc ?? 0) * 100)}%`;
  bar.style.background = soc == null ? "" : soc < 0.2 ? "var(--bad)" : soc < 0.4 ? "var(--warn)" : "var(--good)";
  $("h-stw").innerHTML = `${(stw * 1.94384).toFixed(1)}<small>kt</small>`;
  const u = valueAt(r, r.wind_u, hour);
  const v = valueAt(r, r.wind_v, hour);
  if (u != null && v != null) {
    const spd = Math.hypot(u, v) * 1.94384;
    const from = (THREE.MathUtils.radToDeg(Math.atan2(-u, -v)) + 360) % 360;
    $("h-wind").innerHTML = `${spd.toFixed(0)}<small>kt</small><span class="arrow" style="transform:rotate(${from + 180}deg)">&#8593;</span>`;
    $("h-winddir").textContent = `from the ${compass(from)}`;
  }
  $("h-hs").innerHTML = `${hs.toFixed(1)}<small>m</small>`;
  const tp = valueAt(r, r.tp, hour);
  const wd = angleAt(r, r.wave_dir, hour);
  $("h-tp").textContent = (tp != null ? `${tp.toFixed(0)} s apart` : "") + (wd != null ? `, from the ${compass(wd)}` : "");
  const here = positionAt(r, hour);
  if (Number.isFinite(here[0])) {
    const km = Math.max(distanceKm(here, r.course.target) - r.course.target_radius_m / 1000, 0);
    $("h-dist").innerHTML = `${km < 10 ? km.toFixed(1) : Math.round(km).toLocaleString("en-GB")}<small>km</small>`;
  }
  const ghi = valueAt(r, r.ghi, hour);
  const sunTxt = ghi == null ? "" : ghi > 20 ? "daylight" : "night";
  const comms = commsAt(r, hour);
  const commsTxt = comms === "ok" ? "reporting home" : comms === "beacon" ? "beacon only" : comms === "silent" ? "SILENT" : "";
  $("h-sun").textContent = [commsTxt, sunTxt].filter(Boolean).join(" · ");
}
