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
import { Drain } from "./drain";
import { Clouds, cloudFromSun, fogChance } from "./clouds";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { apparentFlow, rudderFor } from "./boats/gear";
import { BUILDERS, hasDetailedKayak, hasDetailedRandolph, loadDetailedModels, type BoatModel } from "./boats/model";
import type { Quality } from "./boats/parts";
import { BEACHCAT, CRUISER, DINGHY, KAYAK, RANDOLPH, SAIL_DRONE, isStock, stockKeyOf, type BoatSpec, type StockKey } from "./boats/specs";
import { hasDetailedStock, loadStockModel } from "./boats/stock";
import { BEACHCAT16, BoatMotion, CRUISER31, DINGHY14, KAYAK_V4, RANDOLPH_REVB, RANDOLPH_REVC, SAIL_DRONE7, type HullParams } from "./motion";
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
  locate,
  loadReplay,
  planAt,
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
import { HORIZON, Sea } from "./water";
import { PLACE, PLACES } from "./land/place";
import { Island } from "./land/island";
import { boatName, guessVerdict, outcomeLine, storyBeats, type Beat } from "./replay/story";
import { drawPostcard, savePng } from "./replay/postcard";
import { heightAt, MixedSea as LiveSea } from "./waves";
import { SeaStateFeed, type Systems } from "./seastate";
import { advanceNow, FEED_BASE, feedToReplay, loadFeed, reportAgeH, reportAt, type Tracked } from "./replay/feed";
import { localTime } from "./replay/localtime";
import { Cinema, filmButtons } from "./cinema";
import { OceanSound } from "./sound";
import { loadPois, passes, PoiCards, type Poi } from "./pois";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const BASE = params.get("data") ?? "./voyages";
/** "Pick your launch day": ?mode=game. Spoilers (outcomes, voyage length, event marks) stay hidden. */
/** ?replay=path/to/file.json: play one replay file from anywhere on the site (the Boatyard's launches). */
const REPLAY = params.get("replay");
if (REPLAY) document.body.classList.add("single");
const GAME = params.get("mode") === "game" || document.documentElement.dataset.mode === "game"; // or <html data-mode="game">
if (GAME) document.body.classList.add("game");
/**
 * Live tracker: ?live (or <html data-mode="live">) shows the boat at its reported
 * positions from the tracker feed, then the simulator's forecast after now.
 * ?feed=path/ reads the feed from this site instead (tests); only same-site paths.
 */
const LIVE = !GAME && (params.has("live") || document.documentElement.dataset.mode === "live");
if (LIVE) document.body.classList.add("live");
const FEED = (() => {
  const f = params.get("feed");
  return f && !/^[a-z]+:|^\/\//i.test(f) ? (f.endsWith("/") ? f : `${f}/`) : FEED_BASE;
})();

// ---------- renderer; sky, light and haze come from atmosphere.ts ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, PLACE ? HORIZON * 3 : 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = 1.5;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.495;
const atmos = new Atmosphere(renderer, scene, camera);

// ---------- the boats ----------
type BoatKey = BoatSpec["key"];
/**
 * Which boat a replay is: ours, or one revision of our model of the Randolph boat
 * (#179: Rev B and Rev C each get their own menu entry, colour and roll).
 */
type Rev = "kayak" | "randolph" | "randolph_c" | StockKey;
/** The 3D model each one is drawn with (the Randolph revisions share one hull model). */
const MODEL: Record<Rev, BoatKey> = {
  kayak: "kayak",
  randolph: "randolph",
  randolph_c: "randolph",
  stock_cruiser31: "stock_cruiser31",
  stock_dinghy14: "stock_dinghy14",
  stock_beachcat16: "stock_beachcat16",
  stock_sail_drone7: "stock_sail_drone7",
};
const SPEC: Record<BoatKey, BoatSpec> = {
  kayak: KAYAK,
  randolph: RANDOLPH,
  stock_cruiser31: CRUISER,
  stock_dinghy14: DINGHY,
  stock_beachcat16: BEACHCAT,
  stock_sail_drone7: SAIL_DRONE,
};
// Rev C rolls on Rev B's numbers until Theo's Rev C righting curve (their revC_gz_curve.csv) lands.
const HULL: Record<Rev, HullParams> = {
  kayak: KAYAK_V4,
  randolph: RANDOLPH_REVB,
  randolph_c: RANDOLPH_REVC,
  stock_cruiser31: CRUISER31,
  stock_dinghy14: DINGHY14,
  stock_beachcat16: BEACHCAT16,
  stock_sail_drone7: SAIL_DRONE7,
};
const LABEL: Record<Rev, string> = {
  kayak: "Our kayak",
  randolph: "Our model of the Randolph Rev B boat (not their own simulator)",
  randolph_c: "Our model of the Randolph Rev C boat (not their own simulator)",
  stock_cruiser31: "A 31 ft cruiser (stock boat)",
  stock_dinghy14: "A 14 ft dinghy (stock boat)",
  stock_beachcat16: "A 16 ft beach cat (stock boat)",
  stock_sail_drone7: "A wind-powered ocean drone (stock boat)",
};
const SHORT: Record<Rev, string> = {
  kayak: "Our kayak",
  randolph: "Randolph Rev B (our model)",
  randolph_c: "Randolph Rev C (our model)",
  stock_cruiser31: "31 ft cruiser",
  stock_dinghy14: "14 ft dinghy",
  stock_beachcat16: "16 ft beach cat",
  stock_sail_drone7: "Ocean drone",
};
/** What the voyage menu calls each stock boat, with what it is in plain words. */
const STOCK_MENU: Record<StockKey, string> = {
  stock_cruiser31: "31 ft cruiser (a stock sailing yacht, on autopilot)",
  stock_dinghy14: "14 ft dinghy (a stock sailing dinghy, nobody aboard)",
  stock_beachcat16: "16 ft beach cat (a stock catamaran, nobody aboard)",
  stock_sail_drone7: "Wind-powered ocean drone (a stock 7 m sailing drone with a rigid wing)",
};
/** Which boat a replay's boat name is. The stock boats go by their names ("31 ft cruiser");
 * otherwise anything not Randolph is ours, and a Randolph boat is Rev B unless it says Rev C. */
const keyOf = (boat: string | undefined): Rev => {
  const b = boat ?? "";
  return stockKeyOf(b) ?? (!/randolph/i.test(b) ? "kayak" : /rev[\s_-]*c\b/i.test(b) ? "randolph_c" : "randolph");
};
let boatKey: BoatKey = "kayak";
let laneRev: Rev = "kayak";

// ---------- sea and boat ----------
// ?quality=low|high|ultra picks the starting look (the smoke test runs Low on software graphics).
let look: Look = startLook($<HTMLSelectElement>("quality"));
let quality: Quality = geometryOf(look);
const sea = new Sea(quality);
scene.add(sea.mesh);
// Rain in a blow (cosmetic: the log has wind, not rain).
const rain = new Rain();
scene.add(rain.mesh);
// Low cloud (cover read from the logged sunlight) and fog banks (cosmetic).
const clouds = new Clouds();
scene.add(clouds.group);
sea.mesh.receiveShadow = true; // boat shadows on the water (Ultra)
const place: Placement = { x: 0, z: 0, yaw: 0 };
let model: BoatModel | null = null;
let wake: Wake | null = null;
let contact: Contact | null = null;
let motion = new BoatMotion(HULL[laneRev], place);
let wet: Wetness | null = null;
let drain: Drain | null = null;
/** How much bigger than our 3 m kayak the shown boat is (cameras stand back by this much). */
let viewScale = 1;
function buildBoat(q: Quality): void {
  setForecastLook(false); // materials can be shared with the next model: put them back first
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
  if (drain) {
    scene.remove(drain.group);
    drain.dispose();
  }
  const spec = SPEC[boatKey];
  model = BUILDERS[boatKey](q);
  // A bigger boat: stand the camera back so it all fits (a 31 ft yacht's mast is 14 m up).
  const k = THREE.MathUtils.clamp(spec.length / KAYAK.length, 1, 3.4);
  if (k !== viewScale) {
    const off = camera.position.clone().sub(controls.target).multiplyScalar(k / viewScale);
    controls.target.y = 0.2 + (k - 1) * 2.2; // look at the middle of the rig, not the waterline
    camera.position.copy(controls.target).add(off);
    controls.minDistance = 1.5 * k;
    viewScale = k;
  }
  contact = new Contact(model.form, spec, q);
  scene.add(contact.collar, contact.spray);
  // Two hulls: the collar and spray follow one centred hull, so leave them off.
  contact.collar.visible = contact.spray.visible = !model.twinHull;
  wake = new Wake(q, spec.cruiseSpeed, spec.beam, model.stern.x);
  shadowsOn(model.root);
  scene.add(model.root, wake.points);
  wet = new Wetness(model.root);
  drain = new Drain(model.form, spec);
  drain.group.visible = !model.twinHull;
  scene.add(drain.group);
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
// hour's sea without jumps. Where the sea-state files are deployed
// (public/seastate/, from Priya's "Sea state data" workflow) it is the real
// mix: the local wind sea plus up to two swells from distant storms, each with
// its own height, period and direction. Elsewhere (no files, a month not
// loaded yet, the tracker) it is the replay's one combined sea.
const N_COMP = { low: 16, high: 24 } as const;
let live = new LiveSea(undefined, { n: N_COMP[quality], smoothing: 0.4 });
const seaFeed = new SeaStateFeed();
void seaFeed.init();
let seaNow: Systems | null = null; // what the Waves card describes
function seaTarget(rep: Replay, hour: number): number {
  const [lat, lon] = positionAt(rep, hour);
  seaNow = LIVE ? null : seaFeed.at(new Date(utc(rep.start) + hour * 3600e3), lat, lon);
  if (seaNow) {
    live.setSystems(seaNow.ws, seaNow.s1, seaNow.s2);
    return Math.max(Math.hypot(seaNow.ws?.hs ?? 0, seaNow.s1?.hs ?? 0, seaNow.s2?.hs ?? 0), 0.05);
  }
  // The tracker doesn't report the sea: a moderate one, and the cards say it isn't reported.
  const hs = Math.max(valueAt(rep, rep.hs, hour) ?? (LIVE ? 1.2 : 0.3), 0.05);
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
  key: Rev;
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
/** The live tracker's voyage (?live), and whether the page is showing the forecast. */
let tracked: Tracked | null = null;
/** The feed's "now" and the wall-clock time it was loaded, to carry "now" on from. */
let liveClock = { hour: 0, at: 0 };
let forecastLook = false;
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
  cloud: 0,
  fog: 0,
  wet: 0,
  drains: 0,
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
  race: (date: string, rev: "randolph" | "randolph_c" = "randolph") => selectRace(date, rev),
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
  /** Points of interest: how many loaded, and the ids the track has reached (in order). */
  pois: { loaded: 0, shown: [] as string[] },
  /** Put the camera behind the boat looking along a compass bearing (tests and screenshots). */
  aim: (bearing: number, up = false) => {
    setLookUp(up);
    const b = THREE.MathUtils.degToRad(bearing);
    const base = controls.target.y - (lifted ? LIFT : 0);
    const dist = (lifted ? 8 : 6) * viewScale;
    camera.position.set(controls.target.x - Math.sin(b) * dist, base + (lifted ? 0.4 : 1.2), controls.target.z + Math.cos(b) * dist);
  },
  lookUp: false,
  /** The sky guide's numbers: view bearing, sun, moon and North Star (degrees). */
  sky: {} as Record<string, number>,
  /** Make the postcard; returns the PNG as a data URL (for tests). */
  postcard: (): string => (rep ? postcard().toDataURL("image/png") : ""),
  /** Pour the deck off now, as after a knockdown (for tests and pictures). */
  pour: (): void => drain?.pour(),
  /** Hold the cloud cover or fog at a level (0..1) for tests and pictures; -1 follows the log. */
  force: { cloud: -1, fog: -1 },
  /** Live tracker: hours to the latest report and to now, simulated feed or not, forecast showing. */
  live: { on: LIVE, lastFix: 0, now: 0, simulated: false, forecast: false, banner: false, fixes: 0 },
  /** Jump to the latest report (the Now button). */
  goNow: () => tracked && seek(tracked.nowHour),
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
  clouds.snap();
  $("outcome").classList.remove("show");
  resetPois();
}

// ---------- points of interest (wrecks, history, ocean facts) ----------
let pois: Poi[] = [];
const poiSeen = new Set<string>();
let poiH = 0;
const poiCards = new PoiCards();
loadPois(new URL(params.get("pois") ?? "./pois.json", location.href).href).then((p) => {
  pois = p;
  status.pois.loaded = p.length;
  resetPois();
});
/** After a jump: anything the boat passed before now counts as seen, so only what's ahead pops up. */
function resetPois(): void {
  poiSeen.clear();
  poiCards.hide(true);
  if (rep && hour > 0) passes(rep, 0, hour - 1e-6, pois, poiSeen);
  poiH = hour;
}
function poisReached(): void {
  if (!rep || !pois.length || hour < poiH) return;
  const ps = passes(rep, poiH, hour, pois, poiSeen);
  poiH = hour;
  for (const p of ps) poiCards.add(p, `Day ${(p.h / 24).toFixed(1)}`);
  status.pois.shown.push(...ps.map((x) => x.poi.id));
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
/** Race: our kayak and one Randolph revision from the same launch date. */
const RACE_PREFIX: Record<"randolph" | "randolph_c", string> = { randolph: "race:", randolph_c: "race-c:" };
async function selectRace(date: string, rev: "randolph" | "randolph_c" = "randolph"): Promise<void> {
  const pair = [byKey.kayak.get(date), byKey[rev].get(date)].filter((v): v is IndexEntry => !!v);
  if (pair.length < 2) return fail(`no race for ${date}: both boats need a voyage from that day`);
  await load(pair.map((v) => v.file), `${RACE_PREFIX[rev]}${date}`);
}
/** A voyage menu value: a replay file, or a race ("race:DATE" with Rev B, "race-c:DATE" with Rev C). */
function choose(v: string): void {
  if (v.startsWith("race:")) selectRace(v.slice(5), "randolph");
  else if (v.startsWith("race-c:")) selectRace(v.slice(7), "randolph_c");
  else selectVoyage(v);
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
    const mode = lanes.length > 1 ? (lanes[1].key === "randolph_c" ? "race_c" : "race") : lanes[0].key;
    $<HTMLSelectElement>("boat").value = mode;
    fillVoyages(mode);
    $<HTMLSelectElement>("voyage").value = pick;
    $("focus").hidden = lanes.length < 2;
    const race = lanes.length > 1;
    $("lg-ours").textContent = race ? "our kayak" : "track";
    $("lg-theirs").hidden = !race;
    if (race) {
      $("lg-theirs-name").textContent = `${lanes[1].key === "randolph_c" ? "Randolph Rev C" : "Randolph Rev B"} (our model)`;
      $("lg-theirs-dot").style.background = TRACK[lanes[1].key].main;
    }
    $("sub").textContent =
      lanes.length > 1
        ? `Both boats launched the same day into the same weather. Orange is our kayak; ${lanes[1].key === "randolph_c" ? "purple is our own model of the Randolph team's Rev C" : "teal is our own model of the Randolph team's Rev B"}, not their own simulator, so their real odds may differ. Pick which one the close-up follows.`
        : isStock(lanes[0].key)
          ? `${LABEL[lanes[0].key]}, built from published specs of a common boat of its kind, sailing one simulated voyage in real weather and currents for that year. ${lanes[0].key === "stock_cruiser31" ? "Its autopilot reefs (makes the sails smaller) as the wind rises and runs the engine in a calm." : "With nobody aboard to right it, a squall or a breaking sea can turn it over for good."}`
          : lanes[0].key !== "kayak"
          ? `Our own model of the Randolph ${lanes[0].key === "randolph_c" ? "Rev C" : "Rev B"} boat (${lanes[0].key === "randolph_c" ? "from the config the Randolph team wrote in our format" : "built from their published design"}), not their own simulator, sailing one simulated voyage in real weather and currents for that year. Their real odds may differ.`
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

/** The live tracker: the feed's reports up to now, then the forecast. */
async function loadLive(course: Replay["course"], keepHour = false): Promise<void> {
  try {
    const { voyage, ghost } = await loadFeed(FEED);
    const wasNow = !tracked || Math.abs(hour - tracked.nowHour) < 0.5;
    const wasPlaying = playing;
    tracked = feedToReplay(voyage, ghost, course);
    liveClock = { hour: tracked.nowHour, at: Date.now() };
    const r = tracked.rep;
    lanes = [{ key: keyOf(r.boat), file: "live", rep: r, shown: 0 }];
    status.file = "live";
    status.boats = [r.boat];
    status.maxHour = endHour();
    status.outcome = r.outcome;
    status.shown = [];
    status.live = { on: true, lastFix: tracked.lastFixHour, now: tracked.nowHour, simulated: tracked.simulated, forecast: false, banner: tracked.simulated, fixes: tracked.fixes.length };
    $<HTMLInputElement>("scrub").max = String(endHour());
    $("boat").hidden = $("voyage").hidden = true;
    $("now").hidden = $("c-report").hidden = $("c-eta").hidden = false;
    $("h1").textContent = tracked.simulated ? "Live tracker (simulated voyage)" : "Live tracker";
    $("sub").textContent =
      "Where the kayak last reported (the main box's daily satellite report and the backup beacon's pings), then the simulator's forecast from that report: the dashed line on the chart, with the shaded band showing where most forecast runs end up. Wind and waves aren't reported, so the sea here is a stand-in.";
    $("lg-ours").textContent = "reported track";
    chart?.setGhost(tracked.ghost);
    setFocus(0, true);
    ticks();
    seek(keepHour && !wasNow ? Math.min(hour, endHour()) : tracked.nowHour);
    // A reload carries on as it was (a reload that stopped the playback looked like a glitch).
    setPlaying(keepHour && wasPlaying);
    status.ready = true;
  } catch (e) {
    fail(String(e));
  }
}

/** Past now the boat is a forecast: drawn see-through, with a tag. */
function setForecastLook(on: boolean): void {
  if (on === forecastLook || !model) return;
  forecastLook = on;
  status.live.forecast = on;
  $("forecasttag").hidden = !on;
  model.root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // See-through things are drawn after the sea, or the sea paints over them.
    o.userData.order ??= o.renderOrder;
    o.renderOrder = on ? 13 : (o.userData.order as number);
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      m.userData.solid ??= { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
      const k = m.userData.solid as { transparent: boolean; opacity: number; depthWrite: boolean };
      m.transparent = on || k.transparent;
      m.opacity = on ? k.opacity * 0.4 : k.opacity;
      m.depthWrite = on ? false : k.depthWrite;
      m.needsUpdate = true;
    }
  });
}

/** Live equipment card: what the boat's own latest report says, and which radios are heard. */
let lastLiveEquip = "";
function liveEquipment(tr: Tracked): void {
  const forecast = hour > tr.nowHour + 1e-3;
  const rpt = reportAt(tr, Math.min(hour, tr.nowHour));
  const f = rpt?.flags ?? {};
  const comms = commsAt(tr.rep, Math.min(hour, tr.nowHour));
  const chips: [string, boolean][] = [
    ["Satellite radio", comms !== "ok"],
    ["Backup beacon", tr.rep.beacon_ok?.[locate(tr.rep.h, Math.min(hour, tr.nowHour))[0]] === 0],
    [f.one_thruster ? "One motor down" : f.motors_off ? "Motors off (saving battery)" : "Motors", !!(f.one_thruster || f.motors_off)],
    ["Backup box", !!f.safe_box_down],
    [f.safe_mode ? "Backup steering" : "Main box", !!f.safe_mode || comms !== "ok"],
  ];
  const html =
    chips.map(([name, bad]) => `<span class="chip${bad ? " bad" : ""}"><i></i>${name}</span>`).join("") +
    (forecast ? `<span class="chip"><i style="background:#cfe0ff"></i>Forecast: parts as at the last report</span>` : "");
  if (html !== lastLiveEquip) {
    lastLiveEquip = html;
    $("eq").innerHTML = html; // constant names only
  }
}

/** Point the close-up and the cards at one boat. */
function setFocus(i: number, force = false): void {
  if (!lanes[i] || (i === focus && !force && rep === lanes[i].rep)) return;
  focus = i;
  status.focus = i;
  rep = lanes[i].rep;
  chart?.setLanes(lanes.map((l) => ({ rep: l.rep, colours: TRACK[l.key] })), i);
  laneRev = lanes[i].key;
  if (boatKey !== MODEL[laneRev] || !model) {
    boatKey = MODEL[laneRev];
    buildBoat(quality);
  }
  if (isStock(boatKey) && !hasDetailedStock(boatKey)) {
    const k = boatKey;
    void loadStockModel(k).then((ok) => {
      if (ok && boatKey === k) buildBoat(quality);
    });
  }
  motion = new BoatMotion(HULL[laneRev], place);
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
$("now").addEventListener("click", () => tracked && seek(tracked.nowHour));
document.querySelectorAll<HTMLButtonElement>("#warp button").forEach((b) =>
  b.addEventListener("click", () => {
    warp = Number(b.dataset.warp);
    document.querySelectorAll("#warp button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  }),
);
const scrub = $<HTMLInputElement>("scrub");
scrub.addEventListener("input", () => seek(Number(scrub.value)));
$<HTMLSelectElement>("voyage").addEventListener("change", (e) => {
  choose((e.target as HTMLSelectElement).value);
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
  choose(same ?? first);
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
const byKey: Record<Rev, Map<string, IndexEntry>> = {
  kayak: new Map(),
  randolph: new Map(),
  randolph_c: new Map(),
  stock_cruiser31: new Map(),
  stock_dinghy14: new Map(),
  stock_beachcat16: new Map(),
  stock_sail_drone7: new Map(),
};
const raceDates = (rev: "randolph" | "randolph_c" = "randolph") => [...byKey.kayak.keys()].filter((d) => byKey[rev].has(d)).sort();
const OUT: Record<string, string> = { arrived: "finished", lost: "lost", aground: "aground", disqualified: "disqualified", timeout: "still at sea" };
const fmtDay = (iso: string) =>
  new Date(utc(iso)).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
function fillVoyages(mode: string): void {
  const sel = $<HTMLSelectElement>("voyage");
  sel.innerHTML = "";
  if (mode === "race" || mode === "race_c") {
    const rev = mode === "race" ? "randolph" : "randolph_c";
    for (const d of raceDates(rev)) {
      const a = byKey.kayak.get(d)!;
      const b = byKey[rev].get(d)!;
      const name = rev === "randolph" ? "Rev B" : "Rev C";
      sel.add(new Option(`Launch ${fmtDay(a.start)}: kayak ${OUT[a.outcome] ?? a.outcome}, Randolph ${name} (our model) ${OUT[b.outcome] ?? b.outcome}`, `${RACE_PREFIX[rev]}${d}`));
    }
    return;
  }
  const list = [...byKey[mode as Rev].values()].sort((a, b) => a.start.localeCompare(b.start));
  for (const v of list) sel.add(new Option(`Launch ${fmtDay(v.start)}: ${OUT[v.outcome] ?? v.outcome}, ${v.days.toFixed(0)} days`, v.file));
}

// ---------- start ----------
setQuality(look);
// The detailed (Blender) boats, when the build has them: swap them in once loaded.
loadDetailedModels().then((ok) => {
  status.detailed = ok;
  status.models = [hasDetailedKayak() && "kayak", hasDetailedRandolph() && "randolph"].filter((m): m is string => !!m);
  (status as unknown as { stockModels: () => string[] }).stockModels = () =>
    (["stock_cruiser31", "stock_dinghy14", "stock_beachcat16", "stock_sail_drone7"] as StockKey[]).filter(hasDetailedStock);
  if (ok) buildBoat(quality);
});
camera.position.set(-5.6, 2.0, 4.6);
controls.target.set(0, 0.2, 0);
// ---------- real land (?place=pico) ----------
{
  const pick = $<HTMLSelectElement>("placepick");
  for (const p of Object.values(PLACES)) {
    const o = document.createElement("option");
    o.value = p.key;
    o.textContent = p.name;
    pick.appendChild(o);
  }
  pick.value = PLACE?.key ?? "";
  pick.addEventListener("change", () => {
    const q = new URLSearchParams(location.search);
    if (pick.value) q.set("place", pick.value);
    else q.delete("place");
    q.delete("spot");
    location.search = q.toString();
  });
}
let island: Island | null = null;
if (PLACE) {
  // Look past the boat towards the land.
  const a = THREE.MathUtils.degToRad(PLACE.look);
  camera.position.set(-Math.sin(a) * 6.5, 1.6, Math.cos(a) * 6.5);
  controls.maxDistance = 120;
  $("credits").prepend(document.createTextNode(`${PLACE.credit} · `));
  void Island.load(PLACE, quality).then((isl) => {
    island = isl;
    if (isl) scene.add(isl.group);
    else toast("The land files aren't published on this copy of the site yet, so there's only sea here.", PLACE!.name, "#8ab4ff");
    (status as unknown as { land: boolean; surf: number }).land = !!isl;
    (status as unknown as { land: boolean; surf: number }).surf = isl?.surfTriangles ?? 0;
  });
}
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
    if (byKey.randolph.size) modes.push(["randolph", "Randolph Rev B (our model, not their simulator)"]);
    if (byKey.randolph_c.size) modes.push(["randolph_c", "Randolph Rev C (our model, not their simulator)"]);
    if (raceDates().length) modes.push(["race", "Race: our kayak vs our model of Randolph Rev B"]);
    if (raceDates("randolph_c").length) modes.push(["race_c", "Race: our kayak vs our model of Randolph Rev C"]);
    for (const k of Object.keys(STOCK_MENU) as StockKey[]) if (byKey[k].size) modes.push([k, STOCK_MENU[k]]);
    for (const [value, text] of modes) boatSel.add(new Option(text, value));
    boatSel.disabled = modes.length < 2;
    const wantRace = params.get("race");
    const want = params.get("voyage");
    if (LIVE) {
      // The race lines come from any replay file (every voyage sails the same race).
      const course = (await loadReplay(BASE, index[0].file)).course;
      await loadLive(course);
      // The feed is rebuilt hourly; look again every 10 minutes.
      setInterval(() => loadLive(course, true), 10 * 60e3);
    } else if (REPLAY) {
      await selectVoyage(REPLAY);
    } else if (GAME) {
      // The sea behind the picker: our kayak's first launch day, waiting at the start.
      const first = [...byKey.kayak.values()].sort((a, b) => a.start.localeCompare(b.start))[0] ?? index[0];
      await selectVoyage(first.file, false);
      openPicker();
    } else if (wantRace) await selectRace(wantRace, params.get("rev") === "c" ? "randolph_c" : "randolph");
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

// ---------- cinematic mode and sound ----------
const sunElAt = (h: number) => {
  if (!rep) return 0;
  const [la, lo] = positionAt(rep, h);
  return Number.isFinite(la) ? sunPosition(utc(rep.start) + h * 3600e3, la, lo).el : 0;
};
const cine = new Cinema({
  camera,
  controls,
  water: (x, z) => heightAt(live.advance(last), x, z, last),
  yaw: () => smoothYaw ?? 0,
  // What is happening now: the voyage clock runs on as it was (John, 11 Nov).
  sunEl: () => sunElAt(hour),
  sunDir: () => atmos.sunDir,
  cloud: () => clouds.cover,
  landmark: () => (island ? PLACE!.look : null),
  toggleSound: () => sound.toggle(),
  scale: () => viewScale,
});
const sound = new OceanSound();
filmButtons(cine, sound);
(status as unknown as { cine: Cinema }).cine = cine;

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
  // The live tracker's "now" moves on with the clock between feed reloads.
  if (tracked) advanceNow(tracked, liveClock.hour + (Date.now() - liveClock.at) / 3600e3);
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
        // Too fast to see the roll: just show the water running off afterwards.
        else if (e.kind === "capsize" && li === focus && warp <= 600) drain?.pour();
        const who = lanes.length > 1 ? `${SHORT[l.key]} · ` : "";
        toast(describeEvent(e, l.rep.boat), `${who}Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
      }
    }
    poisReached();
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
    if (!LIVE && hour >= endHour() && !ended && !beatShown && beatIdx >= beats.length) {
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
    // A sailing yacht leans on its sails: the replay's heel, which the waves rock about.
    // Once it has turned over (lost), nothing holds it on its side.
    // (The log's last row can come a little before the final event.)
    const atEnd = hour >= rep.h[rep.h.length - 1] - 1e-6;
    const over = rep.events.some((e) => (e.h <= hour || atEnd) && e.kind === "lost" && /capsiz|stayed over/i.test(e.detail));
    motion.heel = rep.heel && !over ? THREE.MathUtils.degToRad(valueAt(rep, rep.heel, hour) ?? 0) : 0;
    // Turned over for good (a dinghy or cat with nobody to right it): over it goes, the
    // way it was leaning, and it floats upside down.
    if (over && !motion.capsized) motion.capsized = motion.roll < 0 ? -1 : 1;
    if (!over) motion.capsized = 0;
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
    if (model && drain) {
      drain.update(dt, motion.roll, model.root, atmos.ambient, renderer.domElement.clientHeight);
      status.drains = drain.count;
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
      if (model.rig) {
        model.rig.update(dt, { flow: apparentFlow(wu, wv, stw, shownHdg), plan: planAt(rep, hour), rudder: model.gear.shown.rudder });
        (status as unknown as { rig: object }).rig = { ...model.rig.shown, heel: THREE.MathUtils.radToDeg(motion.roll), over: motion.capsized };
      }
      status.gear = { parts: model.gear.parts(), now: model.gear.shown, failed: [...failed.keys()] };
      if (tracked) liveEquipment(tracked);
      else equipment(rep, failed);
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
    // Off real land the sky is the place's own (the replay still brings the weather).
    const [lat, lon] = PLACE ? [PLACE.lat, PLACE.lon] : positionAt(rep, hour);
    const sp = sunPosition(utc(rep.start) + hour * 3600e3, lat, lon);
    // Moon, its phase and the stars where they really were from this spot at this time.
    if (Number.isFinite(lat)) atmos.setCelestial(utc(rep.start) + hour * 3600e3, lat, lon);
    sunEl = sp.el;
    sunAz = sp.az;
    atmos.set(sp.el, sp.az, storm);
    const when = utc(rep.start) / 86400e3 + hour / 24; // calendar day, so a given day is foggy in every replay
    clouds.update(
      t,
      dt,
      camera,
      status.force.cloud >= 0 ? status.force.cloud : cloudFromSun(valueAt(rep, rep.ghi, hour), sp.el),
      storm,
      status.force.fog >= 0 ? status.force.fog : fogChance(lat, lon, Math.hypot(wu, wv) * 1.94384, when),
      wu,
      -wv,
      atmos.sunDir,
      atmos.fog.color,
      atmos.ambient,
    );
    clouds.closeIn(atmos.fog);
    status.cloud = clouds.cover;
    status.fog = clouds.fog;
    // Scene x is east, -z is north.
    // The logged rain when the replay has it; older replays only have wind, so rain follows the storm.
    const rate = rep.rain ? valueAt(rep, rep.rain, hour) : null;
    rain.update(t, camera, rate != null ? rainFromRate(rate) : rainFromStorm(storm), wu, -wv, atmos.ambient);
    status.rain = rain.amount;
    // Wet from rain and from spray once the waves get up.
    // Soaked for a while after a knockdown, drying off over a minute or so.
    const dunked = drain ? 1 - THREE.MathUtils.smoothstep(drain.sinceDrain, 20, 80) : 0;
    const wetNow = Math.min(1, Math.max(dunked, rain.amount + THREE.MathUtils.smoothstep(valueAt(rep, rep.hs, hour) ?? 0, 1, 4) * 0.8));
    wet?.set(wetNow);
    status.wet = wetNow;
    sea.setSun(atmos.glintDir, atmos.glintLight);
    wake?.setLight(atmos.ambient);
    island?.update(t, atmos.fog.color, atmos.ambient, hs, storm);
    // The live cards overwrite some of the replay's, so they must update in the same frame:
    // drawn a frame apart, the battery, its bar and the captions flicker between the two.
    const fresh = hud(rep, stw, hs);
    if (tracked) {
      setForecastLook(hour > tracked.nowHour + 1e-3);
      if (fresh) liveHud(tracked);
    }
    status.hour = hour;
    sound.update(dt, {
      wind: Math.hypot(wu, wv),
      hs,
      tp: valueAt(rep, rep.tp, hour) ?? 3 + 2.5 * Math.sqrt(hs),
      rain: rain.amount,
      near: camera.position.distanceTo(controls.target),
    });
  }
  if (!cine.update(dt)) controls.update();
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

let pickBoat: Rev = "kayak";
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
  const choices: [Rev, string, string][] = [["kayak", "Our kayak", "3 m, solar-electric motors"]];
  if (byKey.randolph.size) choices.push(["randolph", "Randolph Rev B", "our model of it · a small sailboat"]);
  if (byKey.randolph_c.size) choices.push(["randolph_c", "Randolph Rev C", "our model of their newer design"]);
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
  stock_cruiser31: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak"],
  stock_dinghy14: ["sail", "rudder", "electronics_main", "comms", "beacon"],
  stock_beachcat16: ["sail", "rudder", "electronics_main", "comms", "beacon"],
  stock_sail_drone7: ["sail", "rudder", "electronics_main", "comms", "beacon", "leak"],
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
      name =
        p === "beacon" && boatKey === "randolph"
          ? "Backup tracker"
          : p === "sail" && isStock(boatKey)
            ? "Sails"
            : (PART_NAME[p] ?? p);
    }
    return `<span class="chip${bad ? " bad" : ""}" data-part="${p}"><i></i>${name}</span>`;
  });
  const html = chips.join("");
  if (html !== lastEquip) {
    lastEquip = html;
    $("eq").innerHTML = html;
  }
}

/** The live tracker's cards: battery only from a fresh report, report age, forecast arrival. */
/** The live tracker's cards, over the replay's; call only right after hud() updated. */
function liveHud(tr: Tracked): void {
  const forecast = hour > tr.nowHour + 1e-3;
  const rpt = forecast ? null : reportAt(tr, hour);
  const rptH = rpt ? (utc(rpt.t) - utc(tr.rep.start)) / 3600e3 : -1;
  const fresh = rpt && rpt.soc != null && hour - rptH <= 36;
  $("h-soc").innerHTML = fresh ? `${Math.round(rpt.soc! * 100)}<small>%</small>` : "-";
  const bar = $("h-socbar");
  bar.style.width = fresh ? `${Math.round(rpt.soc! * 100)}%` : "0%";
  bar.style.background = !fresh ? "" : rpt.soc! < 0.2 ? "var(--bad)" : rpt.soc! < 0.4 ? "var(--warn)" : "var(--good)";
  $("h-charge").textContent = forecast ? "forecast: not known" : fresh ? `reported ${fmtAgo(hour - rptH)}` : "no recent report";
  const sub = $("h-stw").nextElementSibling;
  if (sub) sub.textContent = forecast ? "forecast" : "between reports";
  const age = Math.min(hour, tr.nowHour) === tr.nowHour && !forecast ? tr.nowHour - tr.lastFixHour : reportAgeH(tr, Math.min(hour, tr.nowHour));
  $("l-age").innerHTML = forecast ? "-" : `${age < 1 ? "<1" : age < 48 ? age.toFixed(age < 10 ? 1 : 0) : (age / 24).toFixed(1)}<small>${age < 48 ? "h ago" : "days ago"}</small>`;
  const comms = commsAt(tr.rep, Math.min(hour, tr.nowHour));
  $("l-src").textContent = forecast ? "not there yet" : comms === "ok" ? "daily report + beacon" : comms === "beacon" ? "backup beacon only" : "silent";
  $("h-sun").textContent = forecast ? "forecast" : comms === "ok" ? "reporting home" : comms === "beacon" ? "beacon only" : "SILENT";
  const g = tr.ghost;
  const d = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
  $("l-eta").textContent = g ? d(g.eta.p50) : "-";
  $("l-range").textContent = g ? `${d(g.eta.p10)} to ${d(g.eta.p90)} · ${Math.round(g.p_finish * g.runs)} of ${g.runs} runs finish` : "no forecast yet";
  $("w-day").textContent = forecast ? `Forecast, day ${(hour / 24).toFixed(1)}` : `Day ${(hour / 24).toFixed(1)} · now is day ${(tr.nowHour / 24).toFixed(1)}`;
}
const fmtAgo = (h: number) => (h < 1 ? "under an hour ago" : h < 48 ? `${Math.round(h)} h ago` : `${(h / 24).toFixed(1)} days ago`);

let lastHud = -1;
/** The cards, ten times a second; true when they were redrawn this call. */
function hud(r: Replay, stw: number, hs: number): boolean {
  const now = performance.now();
  if (now - lastHud < 100) return false;
  lastHud = now;
  const day = hour / 24;
  $("h-day").textContent = day.toFixed(1);
  $("h-date").textContent = fmtDate(r, hour);
  $("w-day").textContent = GAME ? `Day ${day.toFixed(1)}` : `Day ${day.toFixed(1)} of ${(endHour() / 24).toFixed(1)}`;
  $("w-date").textContent = fmtDate(r, hour);
  const [plat, plon] = positionAt(r, hour);
  $("h-local").textContent = $("w-local").textContent = localTime(utc(r.start) + hour * 3600e3, plat, plon, warp < 1 / 60);
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
  // With the real mix: the swell is what the boat feels most, so name it.
  const sw = seaNow?.s1 && seaNow.s1.hs >= 0.3 ? seaNow.s1 : null;
  $("h-tp").textContent =
    (tp != null ? `${tp.toFixed(0)} s apart` : "") +
    (wd != null ? `, from the ${compass(wd)}` : "") +
    (sw ? `; swell ${sw.hs.toFixed(1)} m from the ${compass(sw.dirFrom)}` : "");
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
  return true;
}
