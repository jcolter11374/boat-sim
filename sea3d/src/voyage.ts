// Phase 2: replay one simulated voyage of our kayak, or of our model of the
// Randolph boat, or race the two from the same launch date on one map.
//
// Everything shown comes from a replay file written by the simulator
// (boatsim.runner.replay): position, heading, speed, battery, the weather and
// sea the boat met each hour, and what happened. Between logged hours the page
// interpolates; at each logged hour it shows exactly the logged value.
//
// Two clocks: voyage time (hours since launch) runs at the chosen time warp;
// the close-up sea runs in real time, so the waves always move naturally while
// their size and direction follow the voyage hour by hour.

import { Rain, rainFromRate, rainFromStorm } from "./rain";
import { Wetness } from "./boats/wet";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { apparentFlow, rudderFor } from "./boats/gear";
import { BUILDERS, hasDetailedKayak, hasDetailedRandolph, loadDetailedModels, type BoatModel } from "./boats/model";
import type { Quality } from "./boats/parts";
import { KAYAK, RANDOLPH, type BoatSpec } from "./boats/specs";
import { BoatMotion, KAYAK_V4, RANDOLPH_REVB, type HullParams } from "./motion";
import { Chart, TONE_COLOUR, TRACK, type LandBounds } from "./replay/chart";
import {
  angleAt,
  commsAt,
  describeEvent,
  distanceKm,
  failuresAt,
  PART_NAME,
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
import { Contact } from "./contact";
import { Atmosphere, sunPosition } from "./atmosphere";
import { FpsGuard, geometryOf, shadowsOn, startLook, type Look } from "./ultra";
import { Sea } from "./water";
import { boatName, guessVerdict, outcomeLine, storyBeats, type Beat } from "./replay/story";
import { drawPostcard, savePng } from "./replay/postcard";
import { heightAt, Sea as LiveSea } from "./waves";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const BASE = params.get("data") ?? "./voyages";
/** "Pick your launch day": ?mode=game. Spoilers (outcomes, voyage length, event marks) stay hidden. */
/** ?replay=path/to/file.json: play one replay file from anywhere on the site (the Boatyard's launches). */
const REPLAY = params.get("replay");
if (REPLAY) document.body.classList.add("single");
const GAME = params.get("mode") === "game" || document.documentElement.dataset.mode === "game"; // or <html data-mode="game">
if (GAME) document.body.classList.add("game");

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

// ---------- the boats ----------
type BoatKey = BoatSpec["key"];
const SPEC: Record<BoatKey, BoatSpec> = { kayak: KAYAK, randolph: RANDOLPH };
const HULL: Record<BoatKey, HullParams> = { kayak: KAYAK_V4, randolph: RANDOLPH_REVB };
const LABEL: Record<BoatKey, string> = { kayak: "Our kayak", randolph: "Our model of the Randolph boat (not their own simulator)" };
const SHORT: Record<BoatKey, string> = { kayak: "Our kayak", randolph: "Randolph (our model)" };
/** Which 3D model a replay's boat name gets. Anything not Randolph is ours. */
const keyOf = (boat: string | undefined): BoatKey => (/randolph/i.test(boat ?? "") ? "randolph" : "kayak");
let boatKey: BoatKey = "kayak";

// ---------- sea and boat ----------
// ?quality=low|high|ultra picks the starting look (the smoke test runs Low on software graphics).
let look: Look = startLook($<HTMLSelectElement>("quality"));
let quality: Quality = geometryOf(look);
const sea = new Sea(quality);
scene.add(sea.mesh);
// Rain in a blow (cosmetic: the log has wind, not rain).
const rain = new Rain();
scene.add(rain.mesh);
sea.mesh.receiveShadow = true; // boat shadows on the water (Ultra)
const place: Placement = { x: 0, z: 0, yaw: 0 };
let model: BoatModel | null = null;
let wake: Wake | null = null;
let contact: Contact | null = null;
let motion = new BoatMotion(HULL[boatKey], place);
let wet: Wetness | null = null;
function buildBoat(q: Quality): void {
  if (model) {
    scene.remove(model.root);
    model.dispose();
  }
  if (wake) {
    scene.remove(wake.points);
    wake.dispose();
  }
  if (contact) {
    scene.remove(contact.collar, contact.spray);
    contact.dispose();
  }
  const spec = SPEC[boatKey];
  model = BUILDERS[boatKey](q);
  contact = new Contact(model.form, spec, q);
  scene.add(contact.collar, contact.spray);
  wake = new Wake(q, spec.cruiseSpeed, spec.beam, model.stern.x);
  shadowsOn(model.root);
  scene.add(model.root, wake.points);
  wet = new Wetness(model.root);
}
function setQuality(l: Look): void {
  look = l;
  const q = geometryOf(l);
  quality = q;
  sea.setQuality(q);
  buildBoat(q);
  live = new LiveSea(undefined, { n: N_COMP[q], smoothing: 0.4 });
  if (rep) {
    seaTarget(rep, hour);
    live.snap();
  }
  // Low on software graphics (no graphics card) draws at half resolution to keep moving.
  const ratio = q === "high" ? Math.min(window.devicePixelRatio, 2) : atmos.software ? 0.5 : 1;
  renderer.setPixelRatio(ratio);
  atmos.setBloom(q === "high");
  atmos.setUltra(l === "ultra");
  atmos.setPixelRatio(ratio);
  status.look = l;
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
/** One boat's voyage on the page; a race has two. */
interface Lane {
  key: BoatKey;
  file: string;
  rep: Replay;
  shown: number; // events already announced
}
let lanes: Lane[] = [];
let focus = 0; // which lane the close-up and the cards follow
let rep: Replay | null = null; // lanes[focus].rep
let hour = 0;
let playing = false;
let warp = 1 / 3600; // voyage hours per real second: real time to start (John)
let ended = false;
// The launch-day game (?mode=game).
let beats: Beat[] = [];
let beatIdx = 0;
let beatShown = false;
let beatLeft = 0; // seconds of frames left before the beat goes away (frame time, so slow computers still get to read it)
const BEAT_S = 7; // seconds a story beat stays up before the voyage carries on
let guess: boolean | null = null; // the optional guess: true = "it will make it"
let gamePicked = false; // a voyage picked in the game is on screen
/** The page's clock runs until the longer voyage ends. */
const endHour = () => lanes.reduce((m, l) => Math.max(m, lastHour(l.rep)), 0);
const status = {
  rain: 0,
  wet: 0,
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
  /** Race both boats from this launch date (YYYY-MM-DD). */
  race: (date: string) => selectRace(date),
  /** Boat names of the voyages on screen, and which one the close-up follows. */
  boats: [] as string[],
  /** True once a detailed Blender model is in use; models names which ones. */
  detailed: false,
  models: [] as string[],
  /** low, high or ultra. */
  look: "high" as string,
  /** The close-up boat's moving parts and what they show now. */
  gear: {} as Record<string, unknown>,
  /** Foam collar strength and live spray drops. */
  contact: { collar: 0, spray: 0 },
  focus: 0,
  setFocus: (i: number) => setFocus(i),
  /** positionAt for any lane (0 = first boat, 1 = second in a race). */
  lanePositionAt: (i: number, h: number): [number, number] => (lanes[i] ? positionAt(lanes[i].rep, h) : [NaN, NaN]),
  /** The launch-day game: picks, story beats shown so far, and the result. */
  game: { on: GAME, picking: false, guess: "", beats: [] as string[], beat: "", result: "" },
  /** Put the camera behind the boat looking along a compass bearing (tests and screenshots). */
  aim: (bearing: number, up = false) => {
    setLookUp(up);
    const b = THREE.MathUtils.degToRad(bearing);
    const base = controls.target.y - (lifted ? LIFT : 0);
    const dist = lifted ? 8 : 6;
    camera.position.set(controls.target.x - Math.sin(b) * dist, base + (lifted ? 0.4 : 1.2), controls.target.z + Math.cos(b) * dist);
  },
  lookUp: false,
  /** The sky guide's numbers: view bearing, sun, moon and North Star (degrees). */
  sky: {} as Record<string, number>,
  /** Make the postcard; returns the PNG as a data URL (for tests). */
  postcard: (): string => (rep ? postcard().toDataURL("image/png") : ""),
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
  if (p && beatShown) hideBeat();
  playing = p && !!rep;
  if (playing && rep && hour >= endHour()) seek(0);
  $("play").innerHTML = playing ? "&#10073;&#10073;" : "&#9654;";
  status.playing = playing;
}

function seek(h: number): void {
  if (!rep) return;
  hour = Math.min(Math.max(h, 0), endHour());
  for (const l of lanes) l.shown = l.rep.events.filter((e) => e.h <= hour).length;
  beatIdx = beats.filter((b) => b.h < hour).length;
  hideBeat();
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
function verdict(r: Replay): string {
  const last = [...r.events].reverse().find((e) => isNotable(e));
  return r.outcome === "arrived"
    ? "Reached the 25 km target circle off Portugal, which counts as a finish under the race rules."
    : r.outcome === "timeout"
      ? "Still sailing when the simulation stopped, so it doesn't count as a finish."
      : last
        ? describeEvent(last, r.boat).replace(/\.?$/, ".")
        : "";
}
function showOutcome(): void {
  if (!rep) return;
  if (GAME && gamePicked) {
    $("o-kicker").textContent = `${boatName(rep)} · launched ${fmtDay(rep.start)}`;
    if (guess !== null) {
      const v = guessVerdict(rep, guess);
      $("o-title").textContent = v.title;
      $("o-title").style.color = v.right ? "var(--good)" : "var(--warn)";
      $("o-text").textContent = `${outcomeLine(rep)} ${v.text}`;
      status.game.result = v.right ? "right" : "wrong";
    } else {
      const [title, colour] = OUTCOME[rep.outcome] ?? [rep.outcome, "var(--ink)"];
      $("o-title").textContent = title;
      $("o-title").style.color = colour;
      $("o-text").textContent = outcomeLine(rep);
      status.game.result = "seen";
    }
  } else if (lanes.length > 1) {
    // Race: who finished, and who finished first.
    const done = lanes.filter((l) => l.rep.outcome === "arrived").sort((a, b) => a.rep.days - b.rep.days);
    const title = done.length ? `${SHORT[done[0].key]} wins` : "Neither boat finished";
    $("o-title").textContent = title;
    $("o-title").style.color = done.length ? "var(--good)" : "var(--bad)";
    $("o-text").textContent = lanes
      .map((l) => `${LABEL[l.key]}: ${(OUTCOME[l.rep.outcome] ?? [l.rep.outcome])[0].replace("!", "")} after ${l.rep.days.toFixed(1)} days.`)
      .join(" ");
  } else {
    const [title, colour] = OUTCOME[rep.outcome] ?? [rep.outcome, "var(--ink)"];
    $("o-title").textContent = title;
    $("o-title").style.color = colour;
    $("o-text").textContent = `after ${rep.days.toFixed(1)} days. ${verdict(rep)}`;
  }
  $("outcome").classList.add("show");
}

async function selectVoyage(f: string, autoplay = true): Promise<void> {
  await load([f], f, autoplay);
}
/** Race: both boats' voyages from the same launch date. */
async function selectRace(date: string): Promise<void> {
  const pair = [byKey.kayak.get(date), byKey.randolph.get(date)].filter((v): v is IndexEntry => !!v);
  if (pair.length < 2) return fail(`no race for ${date}: both boats need a voyage from that day`);
  await load(pair.map((v) => v.file), `race:${date}`);
}
async function load(files: string[], pick = files[0], autoplay = true): Promise<void> {
  try {
    const reps = await Promise.all(files.map((f) => (f === REPLAY ? loadReplay(".", f.replace(/^\.\//, "")) : loadReplay(BASE, f))));
    lanes = reps.map((r, i) => ({ key: keyOf(r.boat), file: files[i], rep: r, shown: 0 }));
    status.file = files.join(",");
    status.boats = reps.map((r) => r.boat);
    status.maxHour = endHour();
    status.outcome = reps.map((r) => r.outcome).join(",");
    status.shown = [];
    // In the game the bar always spans the longest possible voyage, so it can't give the ending away.
    $<HTMLInputElement>("scrub").max = String(GAME ? Math.max(endHour(), 150 * 24) : endHour());
    const mode = lanes.length > 1 ? "race" : lanes[0].key;
    $<HTMLSelectElement>("boat").value = mode;
    fillVoyages(mode);
    $<HTMLSelectElement>("voyage").value = pick;
    $("focus").hidden = lanes.length < 2;
    const race = lanes.length > 1;
    $("lg-ours").textContent = race ? "our kayak" : "track";
    $("lg-theirs").hidden = !race;
    $("sub").textContent =
      lanes.length > 1
        ? "Both boats launched the same day into the same weather. Orange is our kayak; teal is our own model of the Randolph boat, not their own simulator, so their real odds may differ. Pick which one the close-up follows."
        : lanes[0].key === "randolph"
          ? "Our own model of the Randolph boat (built from their published design), not their own simulator, sailing one simulated voyage in real weather and currents for that year. Their real odds may differ."
          : "Our v4 kayak sailing one simulated voyage: real weather and currents for that year, with its battery, breakdowns and all.";
    setFocus(0, true);
    ticks();
    beats = GAME && gamePicked ? storyBeats(lanes[0].rep) : []; // none behind the picker
    seek(0);
    setPlaying(autoplay);
    status.ready = true;
  } catch (e) {
    fail(String(e));
  }
}

/** Point the close-up and the cards at one boat. */
function setFocus(i: number, force = false): void {
  if (!lanes[i] || (i === focus && !force && rep === lanes[i].rep)) return;
  focus = i;
  status.focus = i;
  rep = lanes[i].rep;
  chart?.setLanes(lanes.map((l) => ({ rep: l.rep, colours: TRACK[l.key] })), i);
  if (boatKey !== lanes[i].key || !model) {
    boatKey = lanes[i].key;
    buildBoat(quality);
  }
  motion = new BoatMotion(HULL[boatKey], place);
  wake?.reset();
  smoothYaw = null;
  seaTarget(rep, hour);
  live.snap();
  document.querySelectorAll<HTMLButtonElement>("#focus button").forEach((b) => {
    b.setAttribute("aria-pressed", String(Number(b.dataset.lane) === i));
    const l = lanes[Number(b.dataset.lane)];
    if (l) b.textContent = SHORT[l.key];
  });
  lastHud = 0;
}

function ticks(): void {
  const box = $("ticks");
  box.innerHTML = "";
  const max = endHour() || 1;
  for (const l of lanes)
    for (const e of l.rep.events) {
      if (!isNotable(e)) continue;
      const i = document.createElement("i");
      i.style.left = `${(100 * e.h) / max}%`;
      i.style.background = TONE_COLOUR[toneOf(e)];
      i.title = (lanes.length > 1 ? `${SHORT[l.key]}: ` : "") + describeEvent(e, l.rep.boat);
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
$<HTMLSelectElement>("voyage").addEventListener("change", (e) => {
  const v = (e.target as HTMLSelectElement).value;
  if (v.startsWith("race:")) selectRace(v.slice(5));
  else selectVoyage(v);
});
$<HTMLSelectElement>("boat").addEventListener("change", (e) => {
  const mode = (e.target as HTMLSelectElement).value;
  fillVoyages(mode);
  const first = $<HTMLSelectElement>("voyage").options[0]?.value;
  if (!first) return;
  // Keep the same launch date when that boat (or race) has it.
  const date = lanes[0] ? lanes[0].rep.start.slice(0, 10) : "";
  const opts = Array.from($<HTMLSelectElement>("voyage").options).map((o) => o.value);
  const same = opts.find((v) => v.endsWith(date) || (date && v.includes(`_${date}`)) || v === `voyage_${date}.json`);
  const v = same ?? first;
  if (v.startsWith("race:")) selectRace(v.slice(5));
  else selectVoyage(v);
});
document.querySelectorAll<HTMLButtonElement>("#focus button").forEach((b) =>
  b.addEventListener("click", () => setFocus(Number(b.dataset.lane))),
);
$<HTMLSelectElement>("quality").addEventListener("change", (e) => setQuality((e.target as HTMLSelectElement).value as Look));
$("o-again").addEventListener("click", () => {
  if (GAME) {
    $("outcome").classList.remove("show");
    openPicker();
    return;
  }
  seek(0);
  setPlaying(true);
});
$("o-postcard").addEventListener("click", () => {
  if (!rep) return;
  savePng(postcard(), `postcard_${keyOf(rep.boat)}_${rep.start.slice(0, 10)}.png`);
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

// ---------- voyage list ----------
/** Index entries by boat, keyed by launch date. */
const byKey: Record<BoatKey, Map<string, IndexEntry>> = { kayak: new Map(), randolph: new Map() };
const raceDates = () => [...byKey.kayak.keys()].filter((d) => byKey.randolph.has(d)).sort();
const OUT: Record<string, string> = { arrived: "finished", lost: "lost", aground: "aground", disqualified: "disqualified", timeout: "still at sea" };
const fmtDay = (iso: string) =>
  new Date(utc(iso)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function fillVoyages(mode: string): void {
  const sel = $<HTMLSelectElement>("voyage");
  sel.innerHTML = "";
  if (mode === "race") {
    for (const d of raceDates()) {
      const a = byKey.kayak.get(d)!;
      const b = byKey.randolph.get(d)!;
      sel.add(new Option(`Launch ${fmtDay(a.start)}: kayak ${OUT[a.outcome] ?? a.outcome}, Randolph (our model) ${OUT[b.outcome] ?? b.outcome}`, `race:${d}`));
    }
    return;
  }
  const list = [...byKey[mode as BoatKey].values()].sort((a, b) => a.start.localeCompare(b.start));
  for (const v of list) sel.add(new Option(`Launch ${fmtDay(v.start)}: ${OUT[v.outcome] ?? v.outcome}, ${v.days.toFixed(0)} days`, v.file));
}

// ---------- start ----------
setQuality(look);
// The detailed (Blender) boats, when the build has them: swap them in once loaded.
loadDetailedModels().then((ok) => {
  status.detailed = ok;
  status.models = [hasDetailedKayak() && "kayak", hasDetailedRandolph() && "randolph"].filter((m): m is string => !!m);
  if (ok) buildBoat(quality);
});
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
    if (!index.length) throw new Error("the voyage list is empty");
    for (const v of index) byKey[keyOf(v.boat)].set(v.start.slice(0, 10), v);
    const boatSel = $<HTMLSelectElement>("boat");
    const modes: [string, string][] = [["kayak", "Our kayak"]];
    if (byKey.randolph.size) modes.push(["randolph", "Randolph boat (our model, not their simulator)"]);
    if (raceDates().length) modes.push(["race", "Race: our kayak vs our model of Randolph"]);
    for (const [value, text] of modes) boatSel.add(new Option(text, value));
    boatSel.disabled = modes.length < 2;
    const wantRace = params.get("race");
    const want = params.get("voyage");
    if (REPLAY) {
      await selectVoyage(REPLAY);
    } else if (GAME) {
      // The sea behind the picker: our kayak's first launch day, waiting at the start.
      const first = [...byKey.kayak.values()].sort((a, b) => a.start.localeCompare(b.start))[0] ?? index[0];
      await selectVoyage(first.file, false);
      openPicker();
    } else if (wantRace) await selectRace(wantRace);
    else {
      // Default: our longest voyage, which has the most to watch.
      const ours = [...byKey.kayak.values()];
      const pool = ours.length ? ours : index;
      const longest = pool.reduce((m, v) => (v.days > m.days ? v : m), pool[0]);
      await selectVoyage(index.find((v) => v.file === want)?.file ?? longest.file);
    }
  } catch (e) {
    fail(String(e instanceof Error ? e.message : e));
  }
})();

// ---------- loop ----------
const guard = new FpsGuard();
const bowW = new THREE.Vector3();
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
    hour = Math.min(hour + dt * warp, endHour());
    if (hour >= endHour()) setPlaying(false);
  }
  if (rep) {
    // Events reached since last frame, for every boat on screen.
    for (const [li, l] of lanes.entries()) {
      while (l.shown < l.rep.events.length && l.rep.events[l.shown].h <= hour) {
        const e = l.rep.events[l.shown++];
        if (e.kind === "message_sent" && li === focus) model?.gear.flashLight(t);
        if (!isNotable(e)) continue;
        status.shown.push(e.kind);
        // A knockdown: give the boat a hard shove so the physics rolls it over and
        // rights it again (the keel and dome do the righting, as designed).
        if (e.kind === "capsize" && warp <= 24 && li === focus) motion.rollRate += (Math.random() < 0.5 ? -1 : 1) * 7;
        const who = lanes.length > 1 ? `${SHORT[l.key]} · ` : "";
        toast(describeEvent(e, l.rep.boat), `${who}Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
      }
    }
    // Story beats (game): stop at each one, then carry on.
    if (GAME && !beatShown && beatIdx < beats.length && beats[beatIdx].h <= hour) showBeat(beats[beatIdx++]);
    if (beatShown) {
      beatLeft -= dt;
      if (beatLeft <= 0) {
        hideBeat();
        if (hour < endHour()) setPlaying(true);
      } else $("b-timer").style.transform = `scaleX(${beatLeft / BEAT_S})`;
    }
    // The result card waits for the last story beat.
    if (hour >= endHour() && !ended && !beatShown && beatIdx >= beats.length) {
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
      model.root.position.set(0, motion.heave - SPEC[boatKey].cgBelowWaterline, 0);
      model.root.rotation.set(motion.roll, smoothYaw, motion.pitch, "YZX");
    }
    const stw = Math.max(valueAt(rep, rep.stw, hour) ?? 0, 0);
    if (model && contact) {
      // Foam where the hull meets the water, spray when the bow drops into a wave.
      model.root.updateMatrixWorld();
      bowW.set(contact.bow[0], SPEC[boatKey].cgBelowWaterline, contact.bow[1]);
      model.root.localToWorld(bowW);
      const clear = bowW.y - heightAt(comps, bowW.x, bowW.z, t);
      contact.update(comps, t, place, hs, { speed: stw, bowClearance: clear, light: atmos.ambient });
      status.contact = { ...contact.shown };
    }
    if (model) {
      // Working equipment from the log: props with speed, rudder with the turn,
      // wing and vane with the apparent wind, panels with the sun, the comms light.
      const wu = valueAt(rep, rep.wind_u, hour) ?? 0;
      const wv = valueAt(rep, rep.wind_v, hour) ?? 0;
      const shownHdg = 90 - THREE.MathUtils.radToDeg(smoothYaw);
      const failed = failuresAt(rep, hour);
      model.gear.update(
        {
          speed: stw / SPEC[boatKey].cruiseSpeed,
          rudder: rudderFor(dt > 0 ? step / dt : 0),
          sun: (valueAt(rep, rep.ghi, hour) ?? 0) / 1000,
          comms: commsAt(rep, hour) ?? "",
          flow: apparentFlow(wu, wv, stw, shownHdg),
          failed,
        },
        t,
      );
      status.gear = { parts: model.gear.parts(), now: model.gear.shown, failed: [...failed.keys()] };
      equipment(rep, failed);
    }
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
    // Moon, its phase and the stars where they really were from this spot at this time.
    if (Number.isFinite(lat)) atmos.setCelestial(utc(rep.start) + hour * 3600e3, lat, lon);
    sunEl = sp.el;
    sunAz = sp.az;
    atmos.set(sp.el, sp.az, storm);
    // Scene x is east, -z is north.
    // The logged rain when the replay has it; older replays only have wind, so rain follows the storm.
    const rate = rep.rain ? valueAt(rep, rep.rain, hour) : null;
    rain.update(t, camera, rate != null ? rainFromRate(rate) : rainFromStorm(storm), wu, -wv, atmos.ambient);
    status.rain = rain.amount;
    // Wet from rain and from spray once the waves get up.
    const wetNow = Math.min(1, rain.amount + THREE.MathUtils.smoothstep(valueAt(rep, rep.hs, hour) ?? 0, 1, 4) * 0.8);
    wet?.set(wetNow);
    status.wet = wetNow;
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
  // Ultra: focus on the boat, shadows round it; back to High if this computer can't keep up.
  if (atmos.ultra) {
    atmos.setFocus(camera.position.distanceTo(controls.target));
    atmos.shadowAround(controls.target, 4);
  }
  if (guard.tick(t, look === "ultra")) {
    $<HTMLSelectElement>("quality").value = "high";
    setQuality("high");
    toast("Switched to High quality: Ultra was running slowly on this computer.", "Quality", "#8ab4ff");
  }
  skyGuide();
  atmos.render();
  chart?.draw(rep ? hour : 0, performance.now());
  status.frames++;
});

// ---------- "Pick your launch day" ----------
function showBeat(b: Beat): void {
  setPlaying(false);
  beatShown = true;
  beatLeft = BEAT_S;
  const box = $("beat");
  box.style.setProperty("--c", TONE_COLOUR[b.tone]);
  $("b-when").textContent = b.h < 1 ? "Day 0" : `Day ${(b.h / 24).toFixed(1)} · ${rep ? fmtDay(new Date(utc(rep.start) + b.h * 3600e3).toISOString()) : ""}`;
  $("b-title").textContent = b.title;
  // Real time is the default (John): say how to speed up, or the next beat is weeks away.
  $("b-text").textContent =
    b.kind === "launch" && warp < 1 ? `${b.text} It's running in real time now: use the speed buttons at the bottom to fast-forward.` : b.text;
  box.classList.add("show");
  status.game.beats.push(b.kind);
  status.game.beat = b.kind;
}
function hideBeat(): void {
  if (!beatShown) return;
  beatShown = false;
  $("beat").classList.remove("show");
  status.game.beat = "";
}
$("b-next").addEventListener("click", () => {
  hideBeat();
  if (hour < endHour()) setPlaying(true);
});

let pickBoat: BoatKey = "kayak";
let pickDate = "";
let pickGuess: boolean | null = null;
function pickButton(label: string, sub: string, pressed: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  const s = document.createElement("small");
  s.textContent = sub;
  b.append(s);
  b.setAttribute("aria-pressed", String(pressed));
  b.addEventListener("click", onClick);
  return b;
}
function drawPicker(): void {
  const boats = $("g-boats");
  boats.replaceChildren();
  const choices: [BoatKey, string, string][] = [["kayak", "Our kayak", "3 m, solar-electric motors"]];
  if (byKey.randolph.size) choices.push(["randolph", "Randolph boat", "our model of it · a small sailboat"]);
  for (const [k, label, sub] of choices)
    boats.append(
      pickButton(label, sub, pickBoat === k, () => {
        pickBoat = k;
        if (!byKey[k].has(pickDate)) pickDate = "";
        drawPicker();
      }),
    );
  const dates = $("g-dates");
  dates.replaceChildren();
  for (const d of [...byKey[pickBoat].keys()].sort()) {
    const day = new Date(utc(d + "T12:00"));
    const label = day.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
    dates.append(
      pickButton(label, String(day.getUTCFullYear()), pickDate === d, () => {
        pickDate = d;
        drawPicker();
      }),
    );
  }
  document.querySelectorAll<HTMLButtonElement>("#g-guess button").forEach((b) =>
    b.setAttribute("aria-pressed", String(pickGuess !== null && (b.dataset.guess === "yes") === pickGuess)),
  );
  $<HTMLButtonElement>("g-go").disabled = !pickDate;
  $("g-need").textContent = pickDate ? "" : "Pick a launch day to start.";
}
document.querySelectorAll<HTMLButtonElement>("#g-guess button").forEach((b) =>
  b.addEventListener("click", () => {
    const g = b.dataset.guess === "yes";
    pickGuess = pickGuess === g ? null : g; // click again to take the guess back
    drawPicker();
  }),
);
function openPicker(): void {
  setPlaying(false);
  hideBeat();
  drawPicker();
  $("game").classList.add("show");
  status.game.picking = true;
}
$("g-go").addEventListener("click", async () => {
  const v = byKey[pickBoat].get(pickDate);
  if (!v) return;
  guess = pickGuess;
  status.game = { ...status.game, picking: false, guess: guess === null ? "" : guess ? "yes" : "no", beats: [], beat: "", result: "" };
  gamePicked = true;
  $("game").classList.remove("show");
  $("g-chip").textContent = guess === null ? "" : guess ? "it will make it" : "it won't make it";
  $("guesschip").hidden = guess === null;
  $("h1").textContent = `${pickBoat === "kayak" ? "Our kayak" : "Randolph boat (our model)"}, launched ${fmtDay(v.start)}`;
  await selectVoyage(v.file);
});
$("quitlink").addEventListener("click", (e) => {
  e.preventDefault();
  location.href = location.pathname;
});
if (GAME) {
  $("h1").textContent = "Pick your launch day";
  $("sub").textContent = "Watch your pick play out. The voyage stops at each big moment to tell you what happened.";
  $("playlink").hidden = true;
  $("quitlink").hidden = false;
  $("o-again").textContent = "Play again";
}

/** The postcard for the voyage on screen (game result, or just what happened). */
function postcard(): HTMLCanvasElement {
  const r = rep!;
  const v = guess !== null ? guessVerdict(r, guess) : null;
  return drawPostcard(renderer.domElement, $<HTMLCanvasElement>("chart"), {
    boat: boatName(r),
    launched: fmtDay(r.start),
    outcome: outcomeLine(r),
    guess: v ? `${v.title} ${v.text}` : "",
    finished: r.outcome === "arrived",
  });
}

// ---------- sky guide: a compass for the view, labels on the sun, moon and North Star ----------
let sunEl = 30;
let sunAz = 180;
let lastGuide = 0;
const guideBox = $<HTMLInputElement>("skyguide");
const showGuide = () => {
  $("compass").hidden = !guideBox.checked;
  $("skylabels").hidden = !guideBox.checked;
  $("lookup").hidden = !guideBox.checked;
};
// Look up: the camera orbits the boat, so it can't tilt far above the horizon on its own.
// Raising the point it looks at tips the view up about 20 degrees: horizon near the bottom, about 50 degrees up at the top.
const LIFT = 3.5; // m
let lifted = false;
function setLookUp(on: boolean): void {
  if (on === lifted) return;
  lifted = on;
  controls.target.y += on ? LIFT : -LIFT;
  if (on) {
    // Come down near the water and a little way back, so the view tilts up past the boat.
    const off = camera.position.clone().sub(controls.target);
    off.y = 0;
    off.setLength(8);
    camera.position.copy(controls.target).add(off);
    camera.position.y = controls.target.y - LIFT + 0.4;
  }
  controls.maxDistance = on ? 80 : 60;
  // Let the camera sit below the raised point (it still never goes under the water).
  controls.maxPolarAngle = Math.PI * (on ? 0.8 : 0.495);
  // A wider lens while looking up: from the horizon to about 50 degrees up.
  camera.fov = on ? 62 : 45;
  camera.updateProjectionMatrix();
  $("lookup").setAttribute("aria-pressed", String(on));
  $("lookup").textContent = on ? "\u2B07 Back to the boat" : "\u2B06 Look up at the sky";
  status.lookUp = on;
}
$("lookup").addEventListener("click", () => setLookUp(!lifted));
guideBox.addEventListener("change", showGuide);
showGuide();
const CARD: Record<number, string> = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
const RANGE = 75; // degrees either side of the view shown on the strip
const viewDir = new THREE.Vector3();
const proj = new THREE.Vector3();
function bearingOf(v: THREE.Vector3): number {
  return (THREE.MathUtils.radToDeg(Math.atan2(v.x, -v.z)) + 360) % 360;
}
function span(cls: string, text: string, x: number, colour = ""): HTMLSpanElement {
  const e = document.createElement("span");
  e.className = cls;
  e.textContent = text;
  e.style.left = `${x}px`;
  if (colour) e.style.color = colour;
  return e;
}
function skyGuide(): void {
  if (!guideBox.checked) return;
  const now = performance.now();
  if (now - lastGuide < 50) return;
  lastGuide = now;
  viewDir.copy(controls.target).sub(camera.position);
  const view = bearingOf(viewDir);
  const W = 420;
  const px = W / (2 * RANGE);
  const rel = (b: number) => ((b - view + 540) % 360) - 180;
  const xOf = (b: number) => W / 2 + rel(b) * px;
  const out: HTMLSpanElement[] = [];
  for (let b = 0; b < 360; b += 5) {
    if (Math.abs(rel(b)) > RANGE) continue;
    const x = xOf(b);
    out.push(span(b % 15 === 0 ? "tick big" : "tick", "", x));
    if (b % 15 === 0) out.push(span(CARD[b] ? `lbl card${b === 0 ? " n" : ""}` : "lbl", CARD[b] ?? String(b), x));
  }
  // What's out there along the strip: the boat's heading, the sun, the moon, the North Star.
  const night = sunEl < -6;
  const marks: [number, string, string][] = [];
  if (model) marks.push([(90 - THREE.MathUtils.radToDeg(smoothYaw ?? 0) + 360) % 360, "\u25B2 bow", "#ff8a2a"]);
  if (sunEl > -1) marks.push([sunAz, "\u2600 sun", "#ffd166"]);
  if (atmos.moonEl > -1) marks.push([bearingOf(atmos.moonDir), "\u263E moon", "#cfe0ff"]);
  const polaris = atmos.starDirs.get("North Star (Polaris)");
  if (night && polaris && polaris.y > 0) marks.push([bearingOf(polaris), "\u2605 North Star", "#ffffff"]);
  for (const [b, text, colour] of marks) if (Math.abs(rel(b)) <= RANGE) out.push(span("mk", text, xOf(b), colour));
  $("tape").replaceChildren(...out);

  // Labels in the sky itself.
  const labels: HTMLSpanElement[] = [];
  const tag = (dir: THREE.Vector3, text: string) => {
    if (dir.y < 0.005) return; // below the horizon
    proj.copy(camera.position).addScaledVector(dir, 1000).project(camera);
    if (proj.z > 1 || Math.abs(proj.x) > 1 || Math.abs(proj.y) > 1) return;
    const e = span("", text, (proj.x * 0.5 + 0.5) * window.innerWidth);
    e.style.top = `${(-proj.y * 0.5 + 0.5) * window.innerHeight}px`;
    labels.push(e);
  };
  if (sunEl > 0) tag(atmos.sunDir, "Sun");
  tag(atmos.moonDir, `Moon (${atmos.moonPhaseName})`);
  if (night && polaris) tag(polaris, "North Star: due north");
  const dubhe = atmos.starDirs.get("Dubhe");
  if (night && dubhe) tag(dubhe, "Big Dipper");
  const betel = atmos.starDirs.get("Alnilam");
  if (night && betel) tag(betel, "Orion's belt");
  $("skylabels").replaceChildren(...labels);
  status.sky = { view, sunEl, sunAz, moonEl: atmos.moonEl, moonAz: bearingOf(atmos.moonDir), moonLit: atmos.moonLit, polarisEl: polaris ? THREE.MathUtils.radToDeg(Math.asin(polaris.y)) : NaN, polarisAz: polaris ? bearingOf(polaris) : NaN };
}

// ---------- equipment card ----------
/** The parts each boat shows on the card, in order. "comms" is the satellite radio's live state. */
const EQUIPMENT: Record<BoatKey, string[]> = {
  kayak: ["thruster_port", "thruster_starboard", "rudder", "electronics_main", "electronics_safe", "comms", "beacon", "leak", "entangled"],
  randolph: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak", "entangled"],
};
let lastEquip = "";
function equipment(r: Replay, failed: Map<string, string>): void {
  const comms = commsAt(r, hour);
  const chips = EQUIPMENT[boatKey].map((p) => {
    let bad: boolean;
    let name: string;
    if (p === "comms") {
      bad = failed.has("comms_silent") || comms === "beacon" || comms === "silent";
      name = PART_NAME.comms_silent;
    } else if (p === "leak") {
      bad = failed.has("leak_main_tub") || failed.has("leak_safe_tub");
      name = PART_NAME.leak_main_tub;
    } else {
      bad = failed.has(p);
      name = p === "beacon" && boatKey === "randolph" ? "Backup tracker" : PART_NAME[p] ?? p;
    }
    return `<span class="chip${bad ? " bad" : ""}" data-part="${p}"><i></i>${name}</span>`;
  });
  const html = chips.join("");
  if (html !== lastEquip) {
    lastEquip = html;
    $("eq").innerHTML = html;
  }
}

let lastHud = -1;
function hud(r: Replay, stw: number, hs: number): void {
  const now = performance.now();
  if (now - lastHud < 100) return;
  lastHud = now;
  const day = hour / 24;
  $("h-day").textContent = day.toFixed(1);
  $("h-date").textContent = fmtDate(r, hour);
  $("w-day").textContent = GAME ? `Day ${day.toFixed(1)}` : `Day ${day.toFixed(1)} of ${(endHour() / 24).toFixed(1)}`;
  $("w-date").textContent = fmtDate(r, hour);
  if (document.activeElement !== scrub) scrub.value = String(hour);
  const soc = valueAt(r, r.soc, hour);
  $("h-soc").innerHTML = soc == null ? "-" : `${Math.round(soc * 100)}<small>%</small>`;
  const bar = $("h-socbar");
  bar.style.width = `${Math.round((soc ?? 0) * 100)}%`;
  bar.style.background = soc == null ? "" : soc < 0.2 ? "var(--bad)" : soc < 0.4 ? "var(--warn)" : "var(--good)";
  const sunNow = valueAt(r, r.ghi, hour);
  $("h-charge").textContent = sunNow == null ? "" : sunNow > 50 ? "solar charging" : "night";
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
