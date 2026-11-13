// Take the helm: you steer our kayak across the Atlantic on a real 2020 launch,
// in hops of time, and the autopilot sails the same weather beside you as a
// ghost. The simulator runs in the browser (helm/worker.ts, Sam's
// boatsim.sandbox.helm); this page draws the boat, the chart, the forecast and
// the results card. Display only: the physics is all in the simulator.

import * as THREE from "three";
import { setRainOnSea } from "./rainRings";
import { FOAM_LAMP_UNIFORMS, NAV_NIGHT } from "./boats/navlights";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Atmosphere, sunPosition } from "./atmosphere";
import { HORIZON, Sea, inChesapeake } from "./water";
import { forcedSea } from "./seaTest";
import { seaUniforms } from "./seaSurface";
import { Mirror, reflectable } from "./mirror";
import { LAND_HORIZON, NearbyLand } from "./land/nearby";
import { BayDepths } from "./land/depth";
import { ANNAPOLIS_COURSE, BAY_WINDS, BREEZES, HARBOUR_WINDS, harbourExit, LIGHT_FINISH_WORDS, LIGHT_STONES_M, THOMAS_POINT, bestKey, readBest, runTime, saveBest, toLatLon, toTheLight, toXY, triangle, type Breeze, type Course, type CourseKind, type LatLon, type XY } from "./helm/course";
import { Buoys } from "./helm/buoys";
import { CHASE_FOV, ChaseCam } from "./helm/chaseCam";
import { PLACES } from "./land/place";
import { metresPerDegree } from "./land/shader";
import { Clouds, cloudFromSun, fogChance } from "./clouds";
import { Spindrift } from "./spindrift";
import { RainBands } from "./rainbands";
import { Traffic } from "./traffic";
import { spindrift as sprayFor, sprayVisibility } from "./storm";
import { Rain, rainFromRate, rainFromStorm } from "./rain";
import { BUILDERS, hasDetailedKayak, loadDetailedModels, type BoatModel } from "./boats/model";
import { KAYAK, PLAYABLE_STOCK, RANDOLPH, STOCK, STOCK_HULL, isStock, type BoatSpec } from "./boats/specs";
import { hasDetailedStock, loadStockModel } from "./boats/stock";
import { apparentFlow, rudderFor } from "./boats/gear";
import { BoatMotion, KAYAK_V4, RANDOLPH_REVB, RANDOLPH_REVC, type HullParams } from "./motion";
import { loadMyBoat, myBoatYardLink, saveMyBoat, type MyBoat } from "./myboat";
import { LAUNCH, SET_SAIL, fromUrl, implied, withChoices, type SetSail } from "./helm/setsail";
import { mountSetSailCard } from "./helm/setsailCard";
import { Wake } from "./wake";
import { ShortWaveRide } from "./boats/ride";
import { Contact } from "./contact";
import { heightAt, MixedSea as LiveSea } from "./waves";
import { SeaStateFeed, type Systems } from "./seastate";
import type { Placement } from "./standin";
import { Chart, TONE_COLOUR, TRACK, type LandBounds } from "./replay/chart";
import { angleAt, commsAt, describeEvent, failedPart, failuresAt, isNotable, lastHour, loadIndex, loadReplay, planAt, positionAt, toneOf, valueAt, type Replay, type ReplayEvent } from "./replay/data";
import { pickVoyage, watchWorker, type WatchInfo } from "./helm/watchSource";
import { watchLink, whoFromUrl } from "./helm/whoSteers";
import { outcomeLine } from "./replay/story";
import { racePick, raceWorker, type RaceCard, type RaceInfo } from "./helm/raceSource";
import { copyText } from "./helm/share";
import { HEADING, HeldAxis, POWER, keyAxis, latestOnly } from "./helm/keys";
import { rollFromWheel } from "./helm/wheel";
import { FrameJudge, PREF_KEY, isLevel, levelSettings, startLevel, type Level } from "./helm/autoQuality";
import { Ghost } from "./helm/ghost";
import { LIGHT_WIND_FROM, MEDAL_WORDS, ROBOT_SECS, clock as trialClock, ghostAt, medalFor, medalTime, readGhost, saveGhost, turnTrack, type Medal, type Track } from "./helm/trial";
import { COUNTS_AFTER_S, WheelSession, canTakeWheel, summary as wheelSummary, type WheelFrame, type WheelResult } from "./helm/wheelSession";
import { HelmGame, OUTCOME, airtimeText, stopText, type Card, type ForecastRow, type Heading, type Mode, type OrderResult, type BestHeading, type Outlook, type Preview, type Status, type Stop } from "./helm/game";
import { Compass } from "./helm/compass";
import { askedChallenge } from "./sailLink";
import { drawForecast } from "./helm/forecast";
import { sandboxThere } from "./sandbox";
import { OPTION_COLOURS, drawCallMap, type LandMask, type Line } from "./helm/callmap";
import { bundleUrl, loadChallenges, startLabel, type Challenge } from "./helm/challenges";
import { CALLS, HONEST, briefing, callAllowed, callToast, goalChip, missionHead, starsText, type Stars } from "./helm/mission";
import { loadPorts, portHint, portName } from "./helm/ports";
import { localTime, shortLocal, zoneLabel } from "./replay/localtime";
import { Hud, showStrip } from "./helm/hud";
import { equipmentParts } from "./replay/equipment";
import { equipmentIcons } from "./replay/hud";
import { Cinema, filmButtons, heightOf, type Moment } from "./cinema";
import { OceanSound, rigFor as rigOf } from "./sound";
import { loadPois, passes, PoiCards, wreckBelow, type Poi } from "./pois";
import { maybeJson, standing, standingText, type Board, type Grid } from "./results";
import { callLines, callName, headline, leaves, numbers, story, type Call } from "./helm/story";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
/** The Set sail card's choices this page opened with (the URL, old ?practice and ?challenge links included). */
const SS: SetSail = fromUrl(location.search);
// ?go=1 sets sail once: a reload (or Play again) comes back to the filled-in card.
if (params.get("go") === "1") history.replaceState(null, "", `${location.pathname}${withChoices(location.search, SS)}${location.hash}`);
const KN = 1.94384;
const utc = (iso: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z");

// ---------- 3D ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.55;
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.05, 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 2;
controls.maxDistance = 60;
controls.maxPolarAngle = Math.PI * 0.495;
camera.position.set(-6.5, 2.2, -3.5); // from her port side, so she heads right-to-left before the start (Ines)
controls.target.set(0, 0.3, 0);
const atmos = new Atmosphere(renderer, scene, camera);
// The picture's quality (src/helm/autoQuality.ts): ?quality= for tests, else the player's pick, else
// Low on software graphics, else Medium, stepping down to Low once under the goal card if too slow.
let storedLevel: string | null = null;
try {
  storedLevel = localStorage.getItem(PREF_KEY);
} catch {
  /* private mode: nothing remembered */
}
const qstat = { ...startLevel(location.search, storedLevel, atmos.software), median: NaN, typical: NaN, frames: 0, stepped: false };
/** Geometry is built once: Low builds the light versions, Medium and High the full ones. */
const quality = qstat.level === "low" ? "low" : "high";
const sea = new Sea(quality);
scene.add(sea.mesh);
const clouds = new Clouds(quality);
scene.add(clouds.group);
const rain = new Rain();
scene.add(rain.mesh);
// Real land near the boat (Bay mouth, Annapolis, the Azores, Lisbon), when it's in range.
let land: NearbyLand | null = null;
void NearbyLand.create(quality).then((n) => {
  land = n;
  page.landKnown = n.known;
  scene.add(n.root);
});
/** How far the view reaches now (m): out to LAND_HORIZON while land is about, eased. */
let reach = HORIZON;
// Calm water mirrors the land and the boat.
const mirror = new Mirror(quality === "high" ? 0.5 : 0.35);
const bufSize = new THREE.Vector2();
// ?spot=lat,lon puts the boat there before a game starts (for pictures and tests).
const spot = (params.get("spot") ?? "").split(",").map(Number);
const SPOT: [number, number] | null = spot.length === 2 && spot.every(Number.isFinite) ? [spot[0], spot[1]] : null;
/** After a finish at the Lisbon line: the scene moves to the coast the line points at. */
let arrival: [number, number] | null = null;
const bands = new RainBands();
scene.add(bands.mesh);
// Other ships, where the real traffic is (loaded in the background; none until it is).
let traffic: Traffic | null = null;
void Traffic.load().then((tr) => {
  traffic = tr;
  scene.add(tr.root);
});
const spray = new Spindrift(quality === "high" ? 5000 : 2000);
scene.add(spray.points);
const sprayBuf = new THREE.Vector2();
const place: Placement = { x: 0, z: 0, yaw: 0 };
// The boat you sail: our kayak, or a stock boat when the simulator offers one (the
// game's replay names it, e.g. "31 ft cruiser").
let spec: BoatSpec = KAYAK;
const HULL: Partial<Record<string, HullParams>> = {
  kayak: KAYAK_V4,
  revc: RANDOLPH_REVC,
  revb: RANDOLPH_REVB,
  ...STOCK_HULL,
};
let hull: HullParams = KAYAK_V4;
let motion = new BoatMotion(hull, place);
let model: BoatModel | null = null;
let wake: Wake | null = null;
let contact: Contact | null = null;
let ride: ShortWaveRide | null = null; // the short waves, felt for the picture only
let seaLevel: "low" | "high" = quality;
/** Draw at a level: its resolution, glow and sea mesh. The boats keep the geometry they were built with. */
function applyLevel(l: Level): void {
  qstat.level = l;
  const q = levelSettings(l, window.devicePixelRatio, atmos.software);
  renderer.setPixelRatio(q.ratio);
  atmos.setPixelRatio(q.ratio);
  atmos.setBloom(q.bloom);
  if (q.sea !== seaLevel) {
    seaLevel = q.sea;
    sea.setQuality(q.sea);
  }
  const sel = document.getElementById("picq") as HTMLSelectElement | null;
  if (sel) sel.value = l;
}
applyLevel(qstat.level);
/** Times the frames under the goal card, once, while the level is still the automatic one. */
const judge = new FrameJudge();
let judging = false;
// The player's own pick (the keys panel): it wins from now on, and is remembered.
$<HTMLSelectElement>("picq").value = qstat.level;
$<HTMLSelectElement>("picq").addEventListener("change", (e) => {
  const v = (e.currentTarget as HTMLSelectElement).value;
  if (!isLevel(v)) return;
  judging = false;
  qstat.source = "player";
  applyLevel(v);
  try {
    localStorage.setItem(PREF_KEY, v);
  } catch {
    /* private mode: for this visit only */
  }
});
function buildBoat(): void {
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
  model = BUILDERS[spec.key](quality);
  reflectable(model.root);
  contact = new Contact(model.form, spec, quality, model.root);
  ride = new ShortWaveRide(spec.length, spec.beam, contact.bow[0], model.stern.x);
  contact.surface = (c, x, z, t) => sea.surfaceAt(c, x, z, t);
  // The foam line fits single hulls the size of ours or bigger; not the twin hulls or the little Randolph boat.
  contact.collar.visible = contact.spray.visible = !model.twinHull && spec !== RANDOLPH;
  wake = new Wake(quality, spec.cruiseSpeed, spec.beam, model.stern.x);
  wake.surface = (c, x, z, t) => sea.surfaceAt(c, x, z, t);
  scene.add(model.root, wake.points, contact.collar, contact.spray);
  placeDeckLight();
}

// Night (Leo's review, #334): the sky stays as dark as the night really is, but the boat's
// own light (its all-round or masthead lantern) falls on its deck and on the foam beside it,
// so you can still see your boat. Only your boat: a light per ship would cost every
// material a light. Off by day (NAV_NIGHT is 0), so daytime looks exactly as before.
const deckLight = new THREE.PointLight(0xfff0d8, 0, 6, 2);
deckLight.name = "deck_light";
/** Candela at full night, and the lamp's light on the foam right beside it (falling away
 *  with distance, FOAM_LAMP_UNIFORMS): tuned on the kayak at 1 AM, moonless. */
const DECK_CD = 3.2;
const FOAM_AT_NIGHT = 0.3;
const lampW = new THREE.Vector3();
/** A lantern higher than this (m) is a masthead light, not a deck lantern. */
const MASTHEAD_LAMP_M = 5;
/** The deck light is a low cockpit lamp (a yacht with a masthead lantern). */
let deckYacht = false;
function placeDeckLight(): void {
  if (!model) return;
  deckLight.removeFromParent();
  const nav = model.root.getObjectByName("nav_lights");
  const lamp = nav?.children[0];
  // On a yacht the lantern is at the masthead, 12 m+ up: there it floodlit the sail like a searchlight
  // (Ines, 12 Nov), and a quarter of the way up it lit the sail from inside. Keep it low, a cockpit
  // lamp just over the deck, short-ranged, so the sails stay a faint shape at night.
  const up = lamp ? model.root.worldToLocal(lamp.getWorldPosition(new THREE.Vector3())).y : 0;
  deckYacht = !!(nav && lamp && up > MASTHEAD_LAMP_M);
  if (deckYacht) {
    deckLight.position.set(0, up * 0.1, 0);
    model.root.add(deckLight);
  } else if (nav && lamp) {
    deckLight.position.copy(lamp.position);
    nav.add(deckLight);
  } else {
    const box = new THREE.Box3().setFromObject(model.root);
    deckLight.position.set(0, box.max.y + 0.1, 0);
    model.root.add(deckLight);
  }
  deckLight.distance = deckYacht ? 5 : 6 * Math.max(1, spec.length / KAYAK.length);
}
/** Sail the boat the game names ("" our kayak, "revc"/"revb" for a Boatyard design on our model of the
 *  Randolph boat, or a stock id); stand the camera back for a bigger one. */
function useBoat(base: string): void {
  const k = isStock(base) ? base : null;
  const next = k ? STOCK[k] : base === "revc" || base === "revb" ? RANDOLPH : KAYAK;
  const nextHull = HULL[base] ?? KAYAK_V4;
  if (next === spec && nextHull === hull) return;
  const scale = (b: BoatSpec) => THREE.MathUtils.clamp(b.length / KAYAK.length, 1, 3.4);
  const off = camera.position.clone().sub(controls.target).multiplyScalar(scale(next) / scale(spec));
  controls.target.y += (scale(next) - scale(spec)) * 2.2;
  camera.position.copy(controls.target).add(off);
  controls.minDistance = 1.5 * scale(next);
  spec = next;
  hull = nextHull;
  motion = new BoatMotion(hull, place);
  buildBoat();
  if (k && !hasDetailedStock(k)) void loadStockModel(k).then((ok) => ok && spec.key === k && buildBoat());
}
buildBoat();
let modelsIn = false; // the detailed boats have loaded (or failed to): the shader warm-up waits for them
void loadDetailedModels().then((ok) => {
  if (ok) buildBoat();
  modelsIn = true;
});
const live = new LiveSea(undefined, { n: quality === "high" ? 24 : 16, smoothing: 0.4 });
// The real mix of wind sea and swells where they're deployed (Priya's sea-state
// files): crossed seas, as the open Atlantic usually has (Elena).
const seaFeed = new SeaStateFeed();
void seaFeed.init();
/** The 2020 launches the launch list names by number (the simulator's launch_index), at 12Z. */
const LAUNCH_DAYS = ["2020-04-01", "2020-04-15", "2020-05-01", "2020-05-15", "2020-06-01", "2020-06-15"];
/** When the chosen launch starts: the sea behind the start card is that day's. */
function launchTime(): Date | null {
  const v = ($("launch") as HTMLSelectElement | null)?.value ?? "";
  const day = /^\d+$/.test(v) ? LAUNCH_DAYS[Number(v)] : /^\d{4}-\d\d-\d\d$/.test(v) ? v : undefined;
  return day ? new Date(`${day}T12:00:00Z`) : null;
}
/** Where the boat is dropped (the start card's sea): 100 km ESE of the Bay mouth. */
const DROP: [number, number] = [36.65, -74.94];
let flowStw = 0; // the boat's speed through the water last frame (m/s)
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  atmos.setSize(window.innerWidth, window.innerHeight);
  chartDirty = true;
  if (lastForecast) drawForecast($<HTMLCanvasElement>("fc"), lastForecast, startMs);
});

// ---------- the game ----------
const sandboxBase = new URL(params.get("sandbox") ?? "./sandbox/", location.href).href;
// Watch a voyage on this same screen (M2 "One sailing screen", R1): helm.html?watch=<launch day,
// or a file the voyages index names>, or the Boatyard's ?replay=<file>. The recorded voyage
// stands in for the simulator (src/helm/watchSource.ts), so the clock, the chart and the strip
// run as they do when you sail. Nothing to steer, and no second boat.
const WATCH = !params.get("g") && (params.has("watch") || params.has("replay"));
/** The recorded voyage a watch link asks for: only files this site's index names, or a replay on this site's own origin. */
async function loadWatched(): Promise<Replay> {
  const file = params.get("replay");
  if (file) return loadReplay(".", file.replace(/^\.\//, ""));
  const base = params.get("data") ?? "./voyages";
  const v = pickVoyage(params.get("watch") ?? "", await loadIndex(base));
  if (!v) throw new Error("there are no voyages to watch on this copy of the site");
  return loadReplay(base, v.file);
}
// "Race it" on this same screen (M2, R3): helm.html?race=<a>,<b>&launch=<0..5>. Two boats, the same
// launch and weather, run by the race's own simulator worker (src/helm/raceSource.ts); boat A sails
// where your boat does and boat B where the ghost does. Nobody steers.
const RACE = !params.get("g") && !WATCH && params.has("race");
/** Nobody at the helm: a watched voyage or a race. No orders, no wheel, no calls. */
const SPECTATE = WATCH || RACE;
const raceMine = (): Record<string, string> | null => {
  const m = loadMyBoat();
  return m ? Object.fromEntries(Object.entries(m.choices).map(([k, v]) => [k, String(v)])) : null;
};
const game = new HelmGame(
  sandboxBase,
  WATCH
    ? () => watchWorker(loadWatched, (info) => (page.watch = info))
    : RACE
      ? () => raceWorker(() => new Worker(new URL("./race/worker.ts", import.meta.url), { type: "module" }), racePick(params.get("race") ?? "", params.get("launch"), raceMine()), (info) => (page.race = info))
      : undefined,
);
let startMs = 0;
let hour = 0; // shown voyage hour
let shownTo = 0; // hour the animation is heading for
let watch: "boat" | "ghost" = "boat";
let busy = false;
let order: Heading = "auto"; // every game starts on the ghost's own autopilot (#327)
let mode: Mode = "hands_on";
/** Base mode: the dial and slider make a draft until it's sent. */
let draft = false;
const shared = params.get("g");
/** The title's one-click Set sail (F1): helm.html?sail. */
const ONE_CLICK = params.has("sail") && !shared && !params.has("practice") && !SPECTATE;
// Weather challenges (challenge-data release, copied to public/challenges/).
const challengesBase = new URL(params.get("challenges") ?? "./challenges/", location.href).href;
let challenges: Challenge[] = [];
const challengesReady = loadChallenges(challengesBase).then((list) => {
  challenges = list;
  showChallenges();
});
// Ports to start from (public/ports.json): the picker stays hidden without the file,
// and for a shared game, which carries its own start.
void loadPorts(new URL(params.get("ports") ?? "./ports.json", location.href).href).then((list) => {
  page.ports = list.length;
  if (!list.length || shared) return;
  const sel = $<HTMLSelectElement>("port");
  for (const p of list) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = portName(p, list);
    sel.appendChild(o);
  }
  $("portpick").hidden = false;
  const hint = () => {
    const p = list.find((q) => q.id === sel.value);
    $("porthint").textContent = p ? portHint(p, list) : "The usual start: our support boat drops her here, then heads home.";
  };
  sel.addEventListener("change", hint);
  sel.addEventListener("change", showProloguePick);
  hint();
  showProloguePick();
});
/** The chosen challenge, if any (a shared link names it with ?c=). */
function chosenChallenge(): Challenge | undefined {
  const id = shared ? params.get("c") : $<HTMLSelectElement>("challenge").value;
  return challenges.find((c) => c.id === id);
}
let power = 0.25; // the autopilot cruises at 25 W of its 100
let maxW = 100; // full drive power, W (the simulator says, once there is an order)
/** A sailboat's own orders (#242): a sail plan and the engine; null lets the boat decide. */
let sailOrder: string | null = null;
let previewKey = ""; // the order the live preview shows (#330)
let previewTimer = 0;
let engineOrder: boolean | null = null;
let lastForecast: Awaited<ReturnType<HelmGame["forecast"]>> | null = null;
let chart: Chart | null = null;
let chartDirty = true;
let shownEvents = { boat: 0, ghost: 0 };
const page = {
  /** The picture's level, where it came from, and the timed median frame (ms) if it was judged (for tests). */
  quality: qstat,
  ready: false,
  /** Which mode the one sailing screen is in (M2): you at the helm, a recorded voyage, or a race. */
  view: (WATCH ? "watch" : RACE ? "race" : "helm") as "helm" | "watch" | "race",
  /** A race's two boats (their names, the helm's keys for their models) and its launch, once it has started. */
  race: null as RaceInfo | null,
  /** A watched voyage, whole (its length, boat and ending), once its file is in; the rows so far are game.boat. */
  watch: null as WatchInfo | null,
  /** Weather forced for pictures and tests (Iris): wind (m/s) and wind-sea height Hs (m); -1 leaves it to the data. */
  force: { wind: -1, hs: -1, skyHours: 0 },
  busy: false,
  stops: [] as Stop[],
  card: null as Card | null,
  /** Whether each boat crossed the race's start line, for the results card. */
  started: { me: true, ghost: true },
  /** Where the finished build stands on Results: "board", "odds" or "none" ("" until shown; for tests). */
  standing: "" as "" | "board" | "odds" | "none",
  status: null as Status | null,
  frames: 0,
  /** Where the lens has slid the boat (fractions of the screen; Leo's plan item 1). */
  third: [0, 0] as number[],
  /** The voyage hour the picture shows, and the hour the simulator has reached (for tests). */
  hour: 0,
  simHour: 0,
  error: "",
  /** Base mode orders sent (accepted or not), and the last share link (for tests). */
  orders: [] as OrderResult[],
  share: "",
  /** The last live order preview shown (#330), for tests. */
  preview: null as Preview | null,
  /** Decisions the game stopped for (#328): which, and on what day (for tests). */
  decisions: [] as { kind: string; day: number; asked?: boolean }[],
  /** The open call's forecast lines and stakes (Game.outlook), for its map; null when none. */
  outlook: null as Outlook | null,
  /** Each route check (#10): when it looked, the best heading and its forecast gain (km), asked or not. */
  routeChecks: [] as { day: number; best: number; gain: number; turn: number; asked: boolean }[],
  /** The challenge being sailed, if any (for tests and share links). */
  challenge: "",
  /** The challenge a link preselected (?challenge=, from the Sea page's "Sail this sea"); "" = none. */
  asked: "",
  /** The port the game started from ("" = the usual drop), and how many the picker offers. */
  startPort: "",
  ports: 0,
  /** Points of interest: how many loaded, and the ids the track has reached (in order). */
  pois: { loaded: 0, shown: [] as string[] },
  /** Real land in view: the place, how far off its box (km), buildings and trees; and the view's reach (m). */
  land: { place: "", km: Infinity, buildings: 0, trees: 0, squares: 0, landmarks: 0 } as NearbyLand["shown"],
  /** Practice sailing: true once the Bay's depths are known to be on this copy of the site (Annapolis courses offered). */
  practiceBay: false,
  /** The time-trial ghost: shown, and how far off (m). */
  ghost: { shown: false, m: 0 },
  reach: HORIZON,
  /** How many places' land files this copy of the site has (-1 until known). */
  landKnown: -1,
  /** How strongly the sea mirrors the land and boat now (0 off .. 1 calm). */
  mirror: 0,
  /** True when the view shows the arrival off Lisbon. */
  arrival: false,
  /** "arrival" while the finish scene plays, before the results card (for tests). */
  scene: "",
  /** Look the given compass bearing past the boat (for pictures and tests). */
  aim: (bearing: number) => aimAt(bearing),
  /** Spindrift blown off the crests, 0..1 (force 8 and up), and rain curtains in view. */
  spindrift: 0,
  bands: 0,
  ships: { ships: 0, inSight: 0, nearest: Infinity, bearing: 0, kinds: { container: 0, tanker: 0, bulk: 0, fishing: 0 } } as Traffic["shown"],
  /** The wreck showing through the water below, if any (its id). */
  wreck: "",
  /** The boat the game sails: the simulator's base ("" our kayak, "revc", a stock id) and the 3D model's key (for tests). */
  get sailing() {
    return { base: game.boatBase, spec: spec.key };
  },
  /** How fast time runs, in voyage hours per second (0 = paused). */
  clock: 0,
  /** The last run's stop reason (for tests). */
  get lastStop(): Stop | null {
    return this.stops.at(-1) ?? null;
  },
};
/** For pictures and reviews: the boat's on-screen box now, in pixels of the canvas (hull, mast and all). */
(page as unknown as { boatBox: () => { w: number; h: number; x: number; y: number } | null }).boatBox = () => {
  if (!model) return null;
  const b = new THREE.Box3().setFromObject(model.root);
  const lo = new THREE.Vector2(Infinity, Infinity);
  const hi = new THREE.Vector2(-Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    const p = new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).project(camera);
    lo.min(new THREE.Vector2(p.x, p.y));
    hi.max(new THREE.Vector2(p.x, p.y));
  }
  const W = renderer.domElement.width;
  const H = renderer.domElement.height;
  return { w: Math.round(((hi.x - lo.x) / 2) * W), h: Math.round(((hi.y - lo.y) / 2) * H), x: Math.round(((lo.x + hi.x) / 4 + 0.5) * W), y: Math.round((0.5 - (lo.y + hi.y) / 4) * H) };
};
(window as unknown as { __helm: typeof page }).__helm = page;

game.onProgress = (t) => {
  $("busytext").textContent = t;
  // The one-click start says one plain thing while it loads, with how far along (F1/F2).
  const pct = /(\d+)%/.exec(t)?.[1];
  $("loadtext").textContent = ONE_CLICK ? `Getting the weather ready…${pct ? ` ${pct}%` : ""}` : t;
};
// Load the simulator while the player reads the start card, so Set sail starts at once (#322).
void (WATCH ? game.warm() : sandboxThere(sandboxBase).then((ok) => (ok ? game.warm() : undefined)));

const compass = new Compass($<HTMLCanvasElement>("dial"), (deg) => setOrder(deg));
// The sailing screen's panels (src/helm/hud.ts): strip, drawer, corner map, toasts.
const hud = new Hud({
  mapResized: () => {
    chartDirty = true;
  },
  forecastOpened: () => {
    if (lastForecast) drawForecast($<HTMLCanvasElement>("fc"), lastForecast, startMs);
  },
  keysOff: () => !page.ready || !!page.status?.over,
});

function rep(which = watch): Replay | null {
  return which === "boat" ? game.boat : game.ghost;
}

function setBusy(b: boolean, text = ""): void {
  busy = b;
  page.busy = b;
  document.body.classList.toggle("busy", b);
  $("busytext").textContent = text;
  for (const el of Array.from(document.querySelectorAll<HTMLButtonElement>(".needs-idle"))) el.disabled = b || !!page.status?.over;
}

function fail(e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  page.error = msg;
  console.error(e);
  note(`The simulator stopped: ${msg}`, "Error", TONE_COLOUR.bad);
  setBusy(false);
}

// ---------- no link (Maya, 12 Nov) ----------
// The boat is unmanned: once its main box (with the satellite modem in it) dies, or the
// satellite link goes silent for good, nothing from base reaches it. The orders drawer locks
// with the reason; the clock and the camera keep working, and you watch the backup box sail.
const NO_LINK_WORDS: Record<string, string> = {
  main_box: "The main computer has failed, and the satellite link went with it. Your orders can't reach her any more. The backup steers her east on the stored route.",
  comms_silent: "The satellite link has gone silent for good. Your orders can't reach her any more. She sails on with the last order she heard.",
};
/** The drawer's banner, after "No link.": what you can still do (Leo, Elena). */
const NO_LINK_BANNER: Record<string, string> = {
  main_box: "She can't hear you now. The backup steers her east on her own. Watch, or jump ahead to see how she does.",
  comms_silent: "She can't hear you now. She sails on with the last order she heard. Watch, or jump ahead to see how she does.",
};
/** The log event that cuts the link, if this one does: its toast is the no-link toast (one toast, not two). */
function linkCutBy(e: ReplayEvent): string | null {
  // A sailboat has one box and no backup: its own words (describeEvent) say so.
  if (e.kind !== "part_failed" || document.body.classList.contains("sailboat")) return null;
  const { part } = failedPart(e);
  return part === "electronics_main" ? "main_box" : part === "comms_silent" ? "comms_silent" : null;
}
/** The lost link is the news: older toasts (a stale battery figure) leave so it stands alone (Ines). */
function noteAlone(text: string, when: string, colour: string): void {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("#notes .note:not(.out)"))) hud.dropToast(el);
  note(text, when, colour);
}
/** Link-cutting events already told by the note of the pause they caused. */
const pausedFor = new Set<number>();
/** "You and the ghost · Day 1.5" when the ghost lost it at the same hour (same dice), else "You · Day 1.5". */
function linkLabel(e: ReplayEvent): string {
  const both = (rep("ghost")?.events ?? []).some((o) => Math.abs(o.h - e.h) < 1 && describeEvent(o, "") === describeEvent(e, ""));
  return `${both ? "You and the ghost" : "You"} · Day ${(e.h / 24).toFixed(1)}`;
}
const LOCKED_IDS = ["coach", "dialrow", "powerrow", "power", "sailrow", "preview", "powerhint", "sendrow"];
let linkCut = "";
function lockOrders(why: string, announce: boolean): void {
  if (linkCut) return;
  linkCut = why;
  document.body.classList.add("no-link");
  $("orders").classList.add("locked");
  // Out of reach for the keyboard too, not only the mouse (Lena). The clock and share link stay.
  for (const id of LOCKED_IDS) {
    const el = document.getElementById(id);
    if (el) el.inert = true;
  }
  // What no longer applies goes (Leo): the day-of-this-order preview and the autopilot hint.
  $("preview").hidden = true;
  $("powerhint").hidden = true;
  $("nolink").hidden = false;
  $("nolinktext").textContent = NO_LINK_BANNER[why] ?? "She can't hear you now.";
  $("c-orderv").textContent = "No link";
  $("orders-tab").classList.add("nolink");
  $("orders-tab").querySelector("span")!.textContent = "Orders: no link";
  if (announce) note(NO_LINK_WORDS[why] ?? "Your orders can't reach the boat any more.", `Day ${(shown ?? page.status)!.day.toFixed(1)}`, TONE_COLOUR.bad);
}

async function setOrder(h: Heading, p = power): Promise<void> {
  if (SPECTATE) return; // a recorded voyage or a race sails itself
  if (linkCut) {
    note("No link: she can't hear you.", `Day ${(page.status?.day ?? 0).toFixed(1)}`, TONE_COLOUR.warn);
    return;
  }
  order = h;
  power = p;
  if (mode === "base" && page.ready) {
    // From base an order is a satellite message, one a day: draft it, then send.
    draft = true;
    showOrder();
    return;
  }
  showOrder();
  if (!page.ready) return;
  try {
    await game.order(h, p, sailOrder, engineOrder);
    page.status = game.status;
    present();
  } catch (e) {
    fail(e);
  }
}

const dayOf = (iso: string) => (utc(iso) - startMs) / 86400e3;

/** Base mode: send the drafted order. */
async function sendOrder(): Promise<void> {
  if (SPECTATE) return;
  if (busy || !page.ready) return;
  try {
    const r = await game.order(order, power, sailOrder, engineOrder);
    page.status = game.status;
    page.orders.push(r);
    const d = page.status!.day;
    if (r.no_link) {
      lockOrders(r.no_link, true);
    } else if (!r.accepted) {
      note(`Base can send one order a day. The next can go on day ${dayOf(r.next_allowed!).toFixed(1)}; your draft is kept until then.`, `Day ${d.toFixed(1)}`, TONE_COLOUR.warn);
    } else {
      draft = false;
      note(
        r.arrives
          ? `Order sent from base. It waits for the boat's next check-in and reaches it on day ${dayOf(r.arrives).toFixed(1)}, planned from where the boat was at its last report.`
          : "Order sent from base, but the satellite link didn't get it through. Try again tomorrow.",
        `Day ${d.toFixed(1)}`,
        TONE_COLOUR.info,
      );
    }
    present();
  } catch (e) {
    fail(e);
  }
}

let sharing = false;

async function shareLink(): Promise<void> {
  if (busy || !page.ready || sharing) return;
  sharing = true;
  $("sharetext").textContent = "Making the link...";
  try {
    const code = await game.save();
    const url = new URL(location.href);
    url.search = "";
    url.searchParams.set("g", code);
    if (page.challenge) url.searchParams.set("c", page.challenge); // so the link opens the right weather
    page.share = url.href;
    // Show the link at once, as text to select and copy by hand; the clipboard
    // only gets a moment and can't keep the player waiting (#293).
    const field = document.createElement("input");
    field.id = "sharelink";
    field.readOnly = true;
    field.value = url.href;
    field.addEventListener("focus", () => field.select());
    const label = document.createElement("span");
    label.textContent = "Here's the link";
    const tail = document.createTextNode(`: it opens this game at day ${page.status!.day.toFixed(1)}, same weather and luck. `);
    $("sharetext").replaceChildren(label, tail, field);
    if (await copyText(url.href, navigator.clipboard)) label.textContent = "Link copied";
  } catch (e) {
    $("sharetext").textContent = "";
    fail(e);
  } finally {
    sharing = false;
  }
}

function showOrder(): void {
  compass.set({ order });
  $("b-wheel").hidden = !wheelOffered() || wheel.on;
  $("ordertext").textContent =
    order === "auto"
      ? "Autopilot steering, like the ghost"
      : order === "finish"
        ? "Straight at the finish"
        : order === "route" ? "Following the autopilot's route" : `Steering ${String(Math.round(order)).padStart(3, "0")}°`;
  $("c-orderv").textContent = linkCut ? "No link" : document.body.classList.contains("at-wheel") ? "At the wheel" : order === "auto" ? "Autopilot" : order === "finish" ? "To the finish" : order === "route" ? "The route" : `Steer ${String(Math.round(order)).padStart(3, "0")}°`;
  $("b-auto").setAttribute("aria-pressed", String(order === "auto"));
  $("b-auto").hidden = mode === "base"; // base can't hand the boat to the ghost's autopilot
  $("b-finish").setAttribute("aria-pressed", String(order === "finish"));
  // On autopilot the autopilot sets its own power, as it does for the ghost.
  $<HTMLInputElement>("power").disabled = order === "auto";
  $("b-route").setAttribute("aria-pressed", String(order === "route"));
  const s = page.status;
  if (s && s.order.power > 0) maxW = s.power_w / s.order.power;
  const w = Math.round(power * maxW);
  const yacht = isStock(spec.key); // a stock boat: the power is its engine's
  $("powerlabel").textContent = yacht ? "Engine power" : "Motor power";
  $("powerhint").textContent = order === "auto"
    ? "The autopilot sets its own power, as it does for the ghost. Pick another order to set yours."
    : yacht
    ? "On Auto the boat motors only in a calm. The tank holds about 15 hours of diesel; once it's empty the boat waits for wind."
    : "The autopilot cruises at 25%. More is faster, but the sun has to refill the battery, and at empty the motors stop until it does.";
  const pct = `${Math.round(power * 100)}%`;
  $("powertext").textContent = yacht
    ? power === 0 || engineOrder === false
      ? "Off: sails only"
      : engineOrder
        ? `${pct}, running whatever the wind`
        : `${pct} in a calm; sails otherwise`
    : power === 0
      ? "Motors off: drifting"
      : `${pct} power, about ${w} W`;
  showSailOrders();
  $("sendrow").hidden = !(mode === "base" && page.ready);
  if (mode === "base") {
    const sent = page.status?.order;
    $("sendtext").textContent = draft ? "Not sent yet: base sends one order a day." : sent ? "This is the last order base sent." : "";
    $("send").textContent = draft ? "Send this order from base" : "Sent";
    ($("send") as HTMLButtonElement).disabled = !draft || busy;
  }
  schedulePreview();
}

// ---------- live order preview (#330) ----------
// Under the controls: what this order would do over the next day. A copy of your boat
// sails it in today's forecast (never the true weather: the ghost only sees forecasts)
// and is thrown away (Game.preview): the simulator's own numbers, no breakdowns or knockdowns. Hands on only. While time
// runs it updates when the order changes; paused, also as the days go by.
function schedulePreview(): void {
  const el = $("preview");
  if (mode !== "hands_on" || !page.ready || page.status?.over) {
    el.hidden = true;
    previewKey = "";
    return;
  }
  const key = `${order}|${power.toFixed(2)}|${sailOrder}|${engineOrder}|${rate > 0 ? "" : Math.floor((page.status?.day ?? 0) * 4)}`;
  if (key === previewKey) return;
  previewKey = key;
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(async () => {
    const p = await game.preview(order, power, sailOrder, engineOrder).catch(() => null);
    if (key !== previewKey) return; // the order changed again meanwhile
    page.preview = p;
    el.hidden = !p;
    if (p) el.textContent = previewText(p);
  }, 250);
}

function previewText(p: Preview): string {
  const kn = p.stw * 1.943844;
  const km = Math.round(p.km);
  const soc = Math.round(p.soc * 100);
  const when = p.hours >= 23.5 ? "On today's forecast, a day of this order" : `On today's forecast, in ${Math.round(p.hours)} hours of this order`;
  const end: Record<string, string> = { arrived: "you would reach the finish", aground: "you would run aground", left_data_box: "you would sail off our weather map" };
  if (p.outcome !== "at_sea" && end[p.outcome]) return `${when}, ${end[p.outcome]}.`;
  const prog = km > 0 ? `${km.toLocaleString()} km closer to the finish` : km < 0 ? `${(-km).toLocaleString()} km further from the finish` : "no closer to the finish";
  const left = page.status?.boat.km_to_finish ?? 0;
  const pace = km > 5 && p.hours >= 23.5 ? ` (about ${Math.round(left / km)} days to go at that pace)` : "";
  return `${when}: about ${kn.toFixed(1)} kn (${(kn * 1.852).toFixed(1)} km/h), battery ${soc > 0 ? "+" : soc < 0 ? "−" : "±"}${Math.abs(soc)}%, ${prog}${pace}.`;
}

function bearing(a: [number, number], b: [number, number]): number {
  const [la1, lo1] = a.map((v) => (v * Math.PI) / 180);
  const [la2, lo2] = b.map((v) => (v * Math.PI) / 180);
  const y = Math.sin(lo2 - lo1) * Math.cos(la2);
  const x = Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(lo2 - lo1);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const compassWord = (deg: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(((deg % 360) + 360) % 360 / 45) % 8];

/** Base mode (#214): the page shows what base knows, not the true boat, until the end. */
const hidden = () => page.status?.show_true_position === false && !page.card;

function kmTo(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const h = Math.sin(((b[0] - a[0]) * r) / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(((b[1] - a[1]) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// ---------- sails and engine (sailboats only, #242) ----------
const PLAN_WORDS: Record<string, [string, string]> = {
  full: ["Full", "All sail up: fastest in light and moderate wind"],
  reef1: ["Reef 1", "Mainsail made a little smaller (reefed) for a fresh breeze"],
  reef2: ["Reef 2", "Mainsail made smaller again for strong wind"],
  storm: ["Storm", "Only small storm sails: for a gale"],
  main_only: ["Main only", "Mainsail up, front sail (jib) rolled away"],
  down: ["Down", "No sails up (bare poles): the boat drifts, or motors"],
};
const ENGINE_WORDS: [string, boolean | null, string][] = [
  ["Auto", null, "The boat decides: it motors only in a calm"],
  ["On", true, "Motor at the power below, whatever the wind"],
  ["Off", false, "Keep the engine off and save the diesel"],
];
let sailPlansShown = "";
/** The Sails and Engine buttons: built once for the boat's own plans, then kept in step with the orders. */
function showSailOrders(): void {
  const sailing = page.status?.sailing;
  $("sailrow").hidden = !sailing;
  document.body.classList.toggle("sailboat", !!sailing);
  if (!sailing) return;
  const key = `${sailing.plans.join()}|${sailing.has_engine}`;
  if (key !== sailPlansShown) {
    sailPlansShown = key;
    const mk = (label: string, title: string, on: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", on);
      return b;
    };
    $("sailbtns").replaceChildren(
      mk("Auto", "The boat decides: it makes the sails smaller as the wind rises", () => void setSails(null, engineOrder)),
      ...sailing.plans.map((p) => {
        const [label, title] = PLAN_WORDS[p] ?? [p, p];
        const b = mk(label, title, () => void setSails(p, engineOrder));
        b.dataset.plan = p;
        return b;
      }),
    );
    $("enginebtns").replaceChildren(
      ...ENGINE_WORDS.map(([label, v, title]) => {
        const b = mk(label, title, () => void setSails(sailOrder, v));
        b.dataset.engine = String(v);
        return b;
      }),
    );
  }
  $("enginerow").hidden = !sailing.has_engine;
  for (const b of Array.from($("sailbtns").children) as HTMLElement[]) b.setAttribute("aria-pressed", String((b.dataset.plan ?? null) === sailOrder));
  for (const b of Array.from($("enginebtns").children) as HTMLElement[]) b.setAttribute("aria-pressed", String(b.dataset.engine === String(engineOrder)));
}
async function setSails(sails: string | null, engine: boolean | null): Promise<void> {
  if (busy) return;
  sailOrder = sails;
  engineOrder = engine;
  // The autopilot sets its own sails; choosing them takes over, on its route.
  await setOrder(order === "auto" ? "route" : order, power);
}
/** One plain line on what the sails and engine are doing now. */
function sailText(s: Status): string {
  const g = s.sailing!;
  const plan = g.plan ? (PLAN_WORDS[g.plan]?.[0] ?? g.plan).toLowerCase() : "?";
  const bits = [`Sails ${g.plan === "down" ? "down" : plan}${s.order.sails ? "" : " (auto)"}`];
  if (g.heel_deg != null) bits.push(`leaning ${Math.abs(g.heel_deg).toFixed(0)}°`);
  if (g.has_engine) bits.push(`engine ${g.engine_on ? "on" : "off"}${g.fuel_l != null ? `, ${g.fuel_l.toFixed(0)} L diesel` : ""}`);
  // A sailboat can't sail straight into the wind, or well dead downwind: it zigzags.
  if (g.tactic === "beat") bits.push("zigzagging upwind");
  else if (g.tactic === "run") bits.push("zigzagging downwind");
  // A watch you trimmed at the wheel (phase 2): how it compares with the autopilot, and how long it lasts.
  if (s.trim) {
    const left = (utc(s.trim.until) - utc(s.boat.t)) / 3600e3;
    if (left > 0) bits.push(`your trim ${Math.round(s.trim.share * 100)}% (autopilot ${Math.round(s.trim.factor * 100)}%) for ${left.toFixed(1)} h more`);
  }
  return bits.join(" · ");
}

/** The trim chip under the time bar (Leo): "Your trim: +1.8 km" counting up through a wheel
 * watch, held for a few seconds after it ends. Distance, not percent: it means more. */
let chipGain: number | null = null;
let chipBase: number | null = null;
let chipHold: ReturnType<typeof setTimeout> | undefined;
function showTrimChip(s: Status): void {
  const c = $("trimchip");
  const g = s.trim?.gain_km;
  if (s.trim && g != null) {
    clearTimeout(chipHold);
    chipHold = undefined;
    chipGain = g;
    chipBase = (s.trim_gain_km ?? g) - g; // all watches before this one
    c.hidden = false;
  } else if (chipGain != null && !chipHold) {
    // The watch ended between two looks (at 6 h/s it lasts under a second): its final
    // gain is what the running total grew by since it began.
    if (s.trim_gain_km != null && chipBase != null) chipGain = s.trim_gain_km - chipBase;
    chipHold = setTimeout(() => {
      c.hidden = true;
      chipGain = null;
      chipHold = undefined;
    }, 5000);
  }
  if (chipGain == null) return;
  const km = Math.abs(chipGain) < 10 ? Math.abs(chipGain).toFixed(1) : String(Math.round(Math.abs(chipGain)));
  c.textContent = `Your trim: ${chipGain < 0 ? "−" : "+"}${km} km${s.trim ? "" : " (watch over)"}`;
  c.classList.toggle("lost", chipGain < 0);
}

/** Where the panel's local time is reckoned (the boat, or base's estimate of it). */
let whenHere: [number, number] | null = null;
let whenDrawn = "";
/** The panel's day, date and local time, and the 3D day label, all at the hour the picture
 *  is drawing, every frame: running, paused by you, or paused by a stop (audit A2, #372).
 *  The rest of the panel waits for the picture as before (`shown`), so nothing tells you
 *  the future; these three just never lag or lead it. */
function drawWhen(force = false): void {
  const st = page.status;
  const r = rep();
  if (!st || !page.ready) return;
  const h = r ? Math.min(hour, lastHour(r)) : st.day * 24;
  const ms = utc(st.boat.t) - st.day * 86400e3 + Math.round(h * 60) * 60e3; // to the minute
  const key = `${ms} ${whenHere}`;
  if (!force && key === whenDrawn) return;
  whenDrawn = key;
  const day = `Day ${(h / 24).toFixed(1)}`;
  $("clock").textContent = day;
  if (!whenHere) return;
  $("day").textContent = day;
  $("when").textContent = new Date(ms).toUTCString().slice(5, 22) + " UTC";
  $("local").textContent = localTime(ms, whenHere[0], whenHere[1]);
  // The strip's date beside the day: the boat's local time and its zone, short; UTC on hover.
  $("c-date").textContent = `${shortLocal(ms, whenHere[0], whenHere[1])} ${zoneLabel(whenHere[0], whenHere[1], ms)}`; // the zone too: locked item S1
  $("c-date").title = $("when").textContent ?? "";
  drawGoal(ms);
}

/** The challenge being sailed, when it has a goal. */
function mission(): (Challenge & { goal: NonNullable<Challenge["goal"]> }) | null {
  const c = challenges.find((x) => x.id === page.challenge);
  return c?.goal ? (c as Challenge & { goal: NonNullable<Challenge["goal"]> }) : null;
}
/**
 * The goal in the strip's time cell (Jonas): "Day 4 of 9" in place of the day, and "storm centre
 * 380 km" in place of the date, with the colour on the km figure only. The cell has room for
 * one line beside the time buttons, so the goal takes that line rather than adding one.
 */
function drawGoal(ms: number): void {
  const m = mission();
  const chip = $("goalchip");
  if (!m || !whenHere) {
    chip.hidden = true;
    $("c-date").hidden = false;
    return;
  }
  const g = goalChip(m.goal, m.start, ms, whenHere[0], whenHere[1]);
  $("day").textContent = g.day;
  chip.hidden = !g.storm;
  $("c-date").hidden = !!g.storm;
  const km = chip.querySelector<HTMLElement>(".g-km")!;
  km.textContent = g.km;
  km.dataset.state = g.state;
}

/** The battery level last told: a fall of 30 points from it is told again, without pausing. */
let socTold: number | null = null;
function batteryNote(s: Status): void {
  if (hidden() || s.over) return;
  const soc = s.boat.soc;
  if (socTold === null || soc > socTold) socTold = soc; // a sunny day raises the bar
  else if (soc <= socTold - 0.3 && soc > 0.2) {
    socTold = soc;
    note(`The battery is down to ${Math.round(soc * 100)}%.`, `Day ${s.day.toFixed(1)}`, TONE_COLOUR.info);
  }
}

function showStatus(): void {
  const s = shown ?? page.status;
  if (!s) return;
  batteryNote(s);
  // The link goes when the picture gets there (a shared game opens with it already gone: no toast).
  // Its toast comes with the failure itself (newEvents): one toast, not two (Leo, Elena).
  if (s.no_link && !linkCut) lockOrders(s.no_link, false);
  showTrimChip(page.status ?? s);
  const b = s.boat;
  const finish = (game.boat?.course.target ?? [39.5, -13.5]) as [number, number];
  const est = hidden() ? s.base?.estimate : undefined;
  const last = s.base?.last_report;
  // Where the page believes the boat is: the truth, or base's estimate.
  const here: [number, number] = est ? [est.lat, est.lon] : [b.lat, b.lon];
  const fb = bearing(here, finish);
  whenHere = here;
  drawWhen(true);
  let toGo = b.km_to_finish;
  let lead = s.lead_km;
  if (est) {
    const radius = (game.boat?.course.target_radius_m ?? 25000) / 1000;
    toGo = Math.max(kmTo(here, finish) - radius, 0);
    lead = s.ghost.km_to_finish - toGo;
  }
  $("tofinish").textContent = est
    ? `About ${Math.round(toGo).toLocaleString()} km to go (base's guess, ${Math.round(est.age_h)} h old)`
    : `${Math.round(toGo).toLocaleString()} km to the finish`;
  const about = est ? "About " : "";
  const other = page.race?.names[1];
  $("lead").textContent = WATCH ? "" : other ? (Math.abs(lead) < 1 ? `Level with ${other}` : lead > 0 ? `${Math.round(lead)} km ahead of ${other}` : `${Math.round(-lead)} km behind ${other}`) : Math.abs(lead) < 1 ? "Level with the autopilot ghost" : lead > 0 ? `${about}${Math.round(lead)} km ahead of the ghost` : `${about}${Math.round(-lead)} km behind the ghost`;
  $("lead").className = lead >= 0 ? "good" : "bad";
  const socNow = est ? last?.soc ?? null : b.soc;
  const soc = socNow == null ? 0 : Math.round(socNow * 100);
  $("battext").textContent = socNow == null ? "Battery: no report yet" : est ? `Battery ${soc}% at last report` : `Battery ${soc}%`;
  $("batbar").style.width = `${soc}%`;
  $("batbar").style.background = soc < 15 ? "var(--bad)" : soc < 35 ? "var(--warn)" : "var(--good)";
  $("speed").textContent = est ? " · speed unknown" : ` · ${(b.stw * KN).toFixed(1)} kn through the water`;
  const w = s.weather;
  let windTo: number | null = null;
  let kn = 0;
  if (w) {
    kn = Math.hypot(w.wind_u, w.wind_v) * KN;
    windTo = (Math.atan2(w.wind_u, w.wind_v) * 180) / Math.PI;
    const from = compassWord(windTo + 180);
    const cur = Math.hypot(w.current_u, w.current_v) * KN;
    $("weather").textContent = `Wind ${kn.toFixed(0)} kn from the ${from} · waves ${w.hs.toFixed(1)} m · current ${cur.toFixed(1)} kn ${compassWord((Math.atan2(w.current_u, w.current_v) * 180) / Math.PI)}ward`;
  }
  compass.set({ heading: est ? last?.hdg ?? b.heading : b.heading, finish: fb, windTo, windKn: kn });
  // The race with the ghost; in base mode, also what base knows (the picture's numbers would be the truth).
  showStrip(
    est
      ? { lead, guess: true, heading: last?.hdg ?? null, speedKn: null, ...(s.sailing ? { heel: null } : { battery: socNow == null ? null : soc }) }
      : {
          lead,
          guess: false,
          heading: Number.isFinite(b.heading) ? b.heading : null,
          speedKn: b.stw * KN,
          ...(s.sailing ? { heel: s.sailing.heel_deg ?? null } : { battery: socNow == null ? null : soc }),
          ...(w ? { windKn: kn, windTo, waves: w.hs } : {}),
        },
  );
  $("m-togo").textContent = `${est ? "about " : ""}${Math.round(toGo).toLocaleString()} km to go`;
  $("c-wind").title = `${$("weather").textContent}. Click for the 5-day forecast (F)`;
  if (s.mode === "base" && s.base) {
    const last = dayOf(s.base.last_report.t);
    const w = s.base.waiting;
    $("baseline").textContent = `Base last heard from the boat on day ${last.toFixed(1)}.${w.length ? ` Order on its way: it reaches the boat on day ${dayOf(w[0].due).toFixed(1)}.` : ""}`;
  } else $("baseline").textContent = "";
  showSailOrders();
  $("sailline").hidden = !s.sailing;
  if (s.sailing) $("sailline").textContent = sailText(s);
  $("ghostline").textContent = WATCH ? "" : `${other ?? "Ghost"}: battery ${Math.round(s.ghost.soc * 100)}%, ${Math.round(s.ghost.km_to_finish).toLocaleString()} km to go${s.ghost.outcome !== "at_sea" ? `, ${OUTCOME[s.ghost.outcome] ?? s.ghost.outcome}` : ""}`;
  showOrder();
}

// ---------- notes ----------
/** A toast at the top (Leo's plan, item 6): gone on its own, longer for a warning; the reason
 * the clock stopped stays until it runs again. All of them go into the big map's log. */
function note(text: string, when: string, colour: string, hl?: string): void {
  hud.toast(text, when, colour, { warn: colour === TONE_COLOUR.warn || colour === TONE_COLOUR.bad, sticky: /^Paused:/.test(text), hl });
}

function newEvents(): void {
  // Only what the picture has got to: the simulator runs ahead of it.
  const seen = (who: "boat" | "ghost") => rep(who)?.events.filter((e) => isNotable(e) && e.h <= hour + 1e-6) ?? [];
  const evs = { boat: seen("boat"), ghost: seen("ghost") };
  // The same thing to both boats at the same hour (both knocked flat by one wave) is one
  // note, "You and the ghost", not two (audit 13, #334).
  const same = (a: ReplayEvent, b: ReplayEvent) => Math.abs(a.h - b.h) < 1 && describeEvent(a, "") === describeEvent(b, "");
  for (const who of ["boat", "ghost"] as const) {
    const other = who === "boat" ? evs.ghost : evs.boat;
    for (const e of evs[who].slice(shownEvents[who])) {
      const both = other.some((o) => same(e, o));
      if (both && who === "ghost") continue; // told with your boat's note
      const label = both ? "You and the ghost" : who === "boat" ? "You" : "Ghost";
      // A watched voyage has one boat and nobody at the helm: the note names the boat, as Watch a voyage does.
      // A race names each boat (the same thing to both is still one note, told with boat A's).
      if (SPECTATE) {
        const name = rep(who)?.boat ?? "";
        note(describeEvent(e, name), `${RACE ? `${both ? "Both boats" : name} · ` : ""}Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
        if (who === "boat" && hour - e.h < 3) moment(e);
        continue;
      }
      const cut = who === "boat" ? linkCutBy(e) : null;
      if (cut && pausedFor.has(e.h)) continue; // the pause's own note tells it
      const text = cut ? NO_LINK_WORDS[cut] : describeEvent(e, who === "boat" ? "your boat" : "the ghost");
      // The log can name one failure twice (the part, then what it means): one note is enough.
      const key = `${who} ${text}`;
      if (lastNote[key] !== undefined && e.h - lastNote[key] < 6) continue;
      lastNote[key] = e.h;
      (cut ? noteAlone : note)(text, `${label} · Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
      if (who === "boat" && hour - e.h < 3) moment(e);
    }
  }
  shownEvents.boat = evs.boat.length;
  shownEvents.ghost = evs.ghost.length;
}
const lastNote: Record<string, number> = {};

// ---------- "Sound on?" (#334) ----------
// No autoplay, ever; but sound sells the sea, and it's easy to miss the button. So once you
// set sail, ask once. "No thanks" is remembered (the sound module stores it as muted), and the
// question goes away by itself after 20 seconds.
/** The sound ask waits: one thing to read at a time at the start (Leo). It comes a minute in, or after the first call, whichever is first. */
let soundAskTimer = 0;
function askSoundLater(): void {
  if (sound.on || sound.muted || sound.remembered) return;
  clearTimeout(soundAskTimer);
  soundAskTimer = window.setTimeout(askSound, 60_000);
}
let soundAsked = false;
function askSound(): void {
  clearTimeout(soundAskTimer);
  if (soundAsked || page.card || sound.on || sound.muted || sound.remembered) return; // turned on last visit: it comes back at the first click
  soundAsked = true;
  const box = $("soundask");
  box.hidden = false;
  document.body.classList.add("asking-sound");
  const close = () => {
    box.hidden = true;
    document.body.classList.remove("asking-sound");
  };
  $("soundyes").onclick = () => {
    sound.enable();
    close();
  };
  $("soundno").onclick = () => {
    sound.disable(true);
    close();
  };
  setTimeout(close, 20_000);
}

// ---------- moments (#329) ----------
// What happens to the boat shows in the picture, not only in a note: time slows to an
// hour a second for a few seconds, a knockdown throws the boat over with a crash of
// water and a shake, a breakdown flashes a warning (the broken part already shows on
// the model), and the finish sounds a horn. The results card waits for the picture.
let kick = { t: -99, dir: 1 };
let slowUntil = 0;
/** A call coming up: slow down from `from`, turn the camera to `look` (compass), until `h` (voyage hours). */
let foresee: { from: number; h: number; look: number | null } | null = null;
let finishing = false;
const shake = new THREE.Vector3();
const stillCamera = matchMedia("(prefers-reduced-motion: reduce)").matches;

function moment(e: ReplayEvent): void {
  const now = clock.getElapsedTime();
  if (e.kind === "capsize") {
    kick = { t: now, dir: Math.random() < 0.5 ? -1 : 1 };
    ride?.knock(now, kick.dir); // thrown flat, hangs, rights itself (boats/ride.ts)
    contact?.slam(1); // under a breaking crest
    sound.crash();
    flash("spray");
    slowUntil = now + 4;
  } else if (["part_failed", "ship_strike", "one_motor", "motors_off", "battery_empty"].includes(e.kind)) {
    sound.breakdown(e.kind); // the part stopping, then the instrument's chirp
    flash("alarm");
    slowUntil = now + 3;
  } else if (e.kind === "arrived" || e.kind === "finish_line") {
    sound.horn();
    slowUntil = now + 4;
  }
}

function flash(kind: "spray" | "alarm"): void {
  const el = $("flash");
  el.className = "";
  void el.offsetWidth; // restart the animation
  el.className = kind;
}

/** Play at an hour a second: during a moment, and over the last hours before the end. */
function slowNow(t: number): boolean {
  return t < slowUntil || (finishing && shownTo - hour < 3) || (!!foresee && hour >= foresee.from && hour < foresee.h);
}

// ---------- running time ----------
async function sail(kind: "6h" | "day" | "event" | "end"): Promise<void> {
  if (busy || !page.ready || page.status?.over) return;
  setRate(0); // a skip pauses the clock: you see where it got to
  ++decisionSeq; // a look under way is for a moment that is gone
  looking = false;
  setBusy(true, "Sailing...");
  if (inFlight) await inFlight; // the clock's own run finishes first
  if (page.status?.over) return setBusy(false);
  // A jump during the last jump's replay: that replay is skipped to its end (you asked to
  // move on), so only the clock's own lead counts below (CI #391: back-to-back hops shrank).
  if (hopPlay) {
    hour = shownTo;
    hopPlay = false;
  }
  const from = hour;
  // The simulator can be some hours ahead of the picture: "until something happens" stops at
  // most 3 days on from what you see (CI #391: day 0.375 to 4.125 with the battery stop gone).
  const ahead = Math.max(0, lastHour(game.boat!) - from);
  try {
    const opts =
      kind === "6h"
        ? { hours: 6, breakdown: false }
        : kind === "day"
          ? { hours: 24, breakdown: false }
          : kind === "end"
            ? { hours: 24 * 200, breakdown: false } // the game ends by itself (finish, landfall or max days)
            : { ...untilOptions(), hours: Math.max(1, UNTIL_H - ahead) };
    const stopped = await game.run(opts);
    page.status = game.status;
    page.stops.push(stopped);
    shownTo = Math.max(lastHour(game.boat!), from);
    hour = from; // animate from where we were
    hopPlay = true;
    present();
    chartDirty = true;
    if (stopped === "breakdown") {
      // The note for it is already up (newEvents): say so plainly instead of twice.
      const e = game.boat!.events.filter(isNotable).at(-1);
      // A lost link is told once, by its own toast (newEvents), not again here (Leo, Elena).
      const cut = e ? linkCutBy(e) : null;
      if (cut && e) pausedFor.add(e.h); // told here, with the pause; newEvents leaves it
      (cut ? noteAlone : note)(cut ? NO_LINK_WORDS[cut] : e ? `Stopped: ${describeEvent(e, "your boat")}` : stopText(stopped, page.status), cut && e ? linkLabel(e) : `Day ${page.status!.day.toFixed(1)}`, cut ? TONE_COLOUR.bad : TONE_COLOUR.warn);
    } else if (callDue()) {
      // Stopped for the challenge's big call: the card says why, not "three quiet days".
    } else if (!(kind !== "event" && stopped === "time"))
      note(stopText(stopped, page.status), `Day ${page.status!.day.toFixed(1)}`, stopped === "ghost_passed" || stopped === "silence" ? TONE_COLOUR.warn : stopped === "passed_ghost" ? TONE_COLOUR.good : TONE_COLOUR.info);
    await refreshForecast();
    if (page.status?.over) finishing = true; // the results wait for the picture (#329)
    // A challenge's big call (and the toast after it) come on a skip too: "Until something
    // happens" stops on the call's day, and the call is the something.
    else if (mission()) maybeDecide(true);
  } catch (e) {
    fail(e);
    return;
  }
  setBusy(false);
}

// ---------- the clock (John, 11 Nov) ----------
// Once you set sail, time runs by itself at a speed picked on the time bar, like a
// flight sim's time compression, and pauses when something happens (the stops of
// "until something happens"). The simulator runs a little ahead of the picture in
// short runs, so a new order takes effect within about a second of play.
/** Real time: a second of the voyage every second, in voyage hours per second. */
const REAL_TIME = 1 / 3600;
/** Voyage hours per second to start at: what a hop used to play at. (T4, the helm's starting speed, is John's call.) */
const DEFAULT_RATE = 6;
let rate = 0;
let lastRate = DEFAULT_RATE;
/**
 * A new voyage's first hours play at an hour a second, then the clock steps up to
 * DEFAULT_RATE by itself (Elena, 12 Nov): at six hours a second, the morning of the drop
 * was gone in two seconds and a new player's first look was a night sea. The voyage hour
 * to step up at, or null once the player picks a speed or pauses.
 */
let easeUpAt: number | null = null;
const FIRST_HOURS = 6;
/** The rate a speed button stands for ("rt" is real time). */
const rateOf = (b: HTMLElement): number => (b.dataset.rate === "rt" ? REAL_TIME : Number(b.dataset.rate));
/** The stop conditions armed when the clock started (so "a big battery drop" is measured from then). */
let armed: Record<string, number | boolean> | null = null;
let inFlight: Promise<void> | null = null;
/** The clock is paused and no simulator run is on its way. */
const clockIdle = (): boolean => !rate && !inFlight;
let forecastAt = -Infinity;
/** The simulator runs ahead of the picture (the clock's runs, and a skip while it plays
 *  out). The panels show each status once the picture gets to its hour, so they never
 *  tell you the future, and the 3D day label and the panel agree (#322). page.status
 *  is always the simulator's latest; `shown` is what the panels show. */
const pending: { at: number; st: Status }[] = [];
let shown: Status | null = null;

/** Show the simulator's latest status once the picture has got to it. */
function present(st: Status | null = page.status): void {
  if (!st) return;
  const at = Math.min(st.day * 24, Math.max(shownTo, hour)); // the track's last row can fall short of the status hour
  while (pending.length && pending[pending.length - 1].at >= at - 1e-6) pending.pop(); // superseded
  if (hour >= at - 1e-6) {
    pending.length = 0;
    shown = st;
    showStatus();
  } else pending.push({ at, st });
}
/** After a stop pauses the clock, the picture still plays on to the moment it happened, at this speed. A pause you press freezes it at once. */
let drainRate = 0;
/** A skip's hours playing out (the old hop playback). */
let hopPlay = false;

function applyPending(all = false): void {
  let changed = false;
  while (pending.length && (all || hour >= pending[0].at - 1e-6)) {
    shown = pending.shift()!.st;
    changed = true;
  }
  if (changed) showStatus();
}

function setRate(r: number, drain = false): void {
  easeUpAt = null;
  drainRate = drain && rate > 0 ? rate : 0;
  if (r > 0) {
    $("decide").hidden = true;
    $("fcbox").classList.remove("lit");
    hud.unstick();
    hud.clockRuns();
    lastRate = r;
    if (!rate) armed = untilOptions();
  } else armed = null;
  rate = r;
  page.clock = r;
  showClock();
}

function showClock(): void {
  const off = !page.ready || !!page.status?.over;
  $("timebar").hidden = off;
  $("timestate").hidden = off;
  if (off) $("keyhint").hidden = true;
  $("timebar").classList.toggle("paused", rate === 0);
  const pause = $("t-pause");
  pause.setAttribute("aria-pressed", String(rate === 0));
  pause.textContent = rate === 0 ? "▶" : "❚❚";
  pause.title = rate === 0 ? "Carry on (space bar)" : "Pause (space bar)";
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#timebar .rate"))) b.setAttribute("aria-pressed", String(rate > 0 && rateOf(b) === rate));
  $("timestate").textContent = rate === 0 ? "Paused: press ▶ or a speed to carry on" : rate === REAL_TIME ? "▶ Real time" : rate === 1 ? "▶ 1 hour a second" : rate < 24 ? `▶▶ ${rate} hours a second` : rate === 24 ? "▶▶▶ 1 day a second" : `▶▶▶ ${rate / 24} days a second`;
}

/** One short run of the simulator, ahead of the picture. */
async function clockRun(): Promise<void> {
  const hours = Math.min(72, Math.max(1, rate * 1.5));
  try {
    const stopped = await game.run({ ...(armed ?? untilOptions()), hours });
    page.stops.push(stopped);
    page.status = game.status;
    shownTo = Math.max(lastHour(game.boat!), shownTo);
    present();
    chartDirty = true;
    if (stopped === "battery") {
      // Reaching the reserve is news, not a choice: a note, and the clock runs on.
      // The night call ("ease off before dark?") is the battery stop with a choice in it (Leo, F5).
      armed = untilOptions(); // only the reserve stops it now; big drops are batteryNote's
      const d = `Day ${game.status!.day.toFixed(1)}`;
      whenAt(game.status!.day * 24, () => note(stopText(stopped, game.status), d, TONE_COLOUR.info));
    } else if (stopped !== "time") {
      setRate(0, true);
      const d = `Day ${game.status!.day.toFixed(1)}`;
      if (stopped === "breakdown") {
        const e = game.boat!.events.filter(isNotable).at(-1);
        const cut = e ? linkCutBy(e) : null;
        if (cut && e) pausedFor.add(e.h); // one toast for a lost link, with the pause (Leo, Elena)
        whenAt(game.status!.day * 24, () => (cut ? noteAlone : note)(`Paused: ${cut ? NO_LINK_WORDS[cut] : e ? describeEvent(e, "your boat") : stopText(stopped, game.status)}`, cut && e ? linkLabel(e) : d, cut ? TONE_COLOUR.bad : TONE_COLOUR.warn));
      } else if (stopped !== "over")
        whenAt(game.status!.day * 24, () => note(`Paused: ${stopText(stopped, game.status)}`, d, stopped === "ghost_passed" || stopped === "silence" ? TONE_COLOUR.warn : stopped === "passed_ghost" ? TONE_COLOUR.good : TONE_COLOUR.info));
    }
    // The forecast strip: fresh every half day of play, and at every pause.
    if (game.status!.day * 24 - forecastAt >= 12 || rate === 0) {
      forecastAt = game.status!.day * 24;
      await refreshForecast();
    }
    if (stopped === "time" || stopped === "battery") maybeDecide();
    if (game.status?.over) {
      // The picture plays on to the end, slowing for the last hours; then the results (#329).
      setRate(0, true);
      drainRate = Math.max(drainRate, 6);
      finishing = true;
    }
  } catch (e) {
    setRate(0);
    fail(e);
  }
}

/** A forecast look (route check, chase, a Stream call that may be only a note) is under way:
 * the simulator waits where it is so the answer fits the moment, but the clock is not
 * paused. The picture plays on up to the simulator and the time bar keeps its speed; only a
 * card, if the look ends in one, pauses the clock (CI #391: a look read as "Paused"). */
let looking = false;

/** "Until something happens" runs at most this long (the simulator's own cap, 72 h). */
const UNTIL_H = 72;

/** This frame's share of the clock: move the picture on, and keep the simulator ahead of it. */
function tickClock(dt: number): boolean {
  if (!(rate > 0) || busy || !page.ready || page.status?.over || cine.on) return false;
  // Ease off as the simulator's lead runs down, so a slow computer sees slower, smooth time rather than stop-start.
  if (easeUpAt !== null && hour >= easeUpAt) setRate(DEFAULT_RATE);
  const ahead = shownTo - hour;
  const r = clock.getElapsedTime() < slowUntil ? Math.min(rate, 1) : rate; // a moment (#329) plays at an hour a second
  hour = Math.min(shownTo, hour + dt * (ahead >= r / 2 ? r : r * Math.max(0.2, (2 * ahead) / r)));
  if (!inFlight && !looking && shownTo - hour < rate)
    inFlight = clockRun().finally(() => {
      inFlight = null;
    });
  return true;
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#timebar .rate"))) b.addEventListener("click", () => setRate(rateOf(b)));
$("t-pause").addEventListener("click", () => setRate(rate ? 0 : lastRate));
// Keys, so it feels like steering rather than filling in a form (Leo's review): Space
// pauses or carries on, 1-3 pick a speed, Left/Right turn 5 degrees, Up/Down change power.
const SPEED_KEYS: Record<string, number> = { Digit1: REAL_TIME, Digit2: 1, Digit3: 6, Digit4: 24, Digit5: 96, Numpad1: REAL_TIME, Numpad2: 1, Numpad3: 6, Numpad4: 24, Numpad5: 96 };
/** The key hint under the time bar: for the first minute, or until a key is used. */
let keyHintTimer: ReturnType<typeof setTimeout> | undefined;
function hideKeyHint(): void {
  const k = $("keyhint");
  if (k.hidden || k.classList.contains("gone")) return;
  k.classList.add("gone");
  clearTimeout(keyHintTimer);
  keyHintTimer = setTimeout(() => (k.hidden = true), 1000);
}
// Held arrows (Rosa, src/helm/keys.ts): a tap is 5 degrees or 5 %, Shift is 1; holding keeps
// it moving, faster the longer you hold. The dial follows every frame; the simulator is told a
// few times a second and where it stopped, newest order only.
const sendHeading = latestOnly<number>((h) => setOrder(h));
const sendPower = latestOnly<number>((p) => setOrder(order, p));
const axes = {
  heading: new HeldAxis(
    {
      value: () => (typeof order === "number" ? order : headingNow()),
      preview: (h) => {
        order = h;
        showOrder();
      },
      commit: sendHeading,
    },
    HEADING,
  ),
  power: new HeldAxis(
    {
      value: () => power,
      preview: (p) => {
        power = p;
        $<HTMLInputElement>("power").value = String(Math.round(p * 100));
        showOrder();
      },
      commit: sendPower,
    },
    POWER,
  ),
};
function releaseKeys(): void {
  axes.heading.release(performance.now());
  axes.power.release(performance.now());
}
addEventListener("blur", () => {
  releaseKeys();
  wheel.release();
});

/** Resolves after the browser has painted the current DOM, so a long simulator call can't hold it back. */
const nextPaint = () => new Promise<void>((res) => requestAnimationFrame(() => setTimeout(res, 0)));

// "Take the wheel" (Rosa, Gameplay; plan reviewed by Leo): sail the boat yourself in real
// time. The voyage clock waits while you do; for now a spell doesn't move the voyage.
let wheelRate = 0; // the clock's speed before the spell, to carry on at
let wheelNow: WheelFrame | null = null;
/** Where the last wheel frame had the boat (metres from the spell's start). */
let wheelLast: { x: number; y: number } | null = null;
const wheel = new WheelSession({
  ended: (r) => void (prologueDone ? prologueEnded(r) : PRACTICE ? practiceEnded(r) : wheelEnded(r)),
  note: (text) => note(text, "At the wheel", TONE_COLOUR.warn),
});
(window as unknown as { __wheel: WheelSession }).__wheel = wheel;
/** Phase 2 (Sam, Theo, Maya): a spell of a minute or more sets how well the boat is trimmed
 * for the next watch, as an order the simulator sails (clamped there), never by moving the boat here. */
async function wheelEnded(r: WheelResult): Promise<void> {
  wheelNow = null;
  // Esc is answered in the frame it's pressed (Leo): the strip shows the order the boat goes back
  // to now; the camera eases out on its own time. If the simulator still has to take the spell's
  // trim, the cell says so ("Autopilot…") until it lands, and the page paints before it starts.
  showOrder();
  let counts: { hours: number } | null = null;
  const st = page.status;
  if (r.sailedSecs >= COUNTS_AFTER_S && st?.sailboat && st.trim !== undefined && mode === "hands_on") {
    const cell = $("c-orderv");
    cell.textContent = `${cell.textContent}…`;
    await nextPaint();
    try {
      if (inFlight) await inFlight;
      const o = await game.order(order, power, sailOrder, engineOrder, r.share);
      page.status = game.status;
      if (o.trim_until) {
        counts = { hours: Math.round((utc(o.trim_until) - utc(page.status!.boat.t)) / 3600e3) };
        // The chart draws this watch brighter (Leo). A new watch cuts the last one short.
        const from = (utc(page.status!.boat.t) - startMs) / 3600e3;
        const last = trimWatches.at(-1);
        if (last && last[1] > from) last[1] = from;
        trimWatches.push([from, (utc(o.trim_until) - startMs) / 3600e3]);
        chartDirty = true;
      }
      present();
    } catch (e) {
      console.warn("the simulator didn't take the spell's trim", e);
    }
  }
  note(wheelSummary(r, counts), "At the wheel", r.reached ? TONE_COLOUR.good : TONE_COLOUR.info);
  showOrder();
  setRate(wheelRate);
}
// "Practice sailing" (Leo): helm.html?practice. The cruiser, no voyage and no simulator to
// load. Off Annapolis (Leo's plan, Maya approved 12 Nov) it's a course: the triangle or the
// run to Thomas Point Light, in a breeze you pick, timed against your best, and the Bay's
// depths end the run in shallow water. Where this copy of the site has no Bay squares, it's
// the old drills: a spell to a mark in a steady wind, a new one each time.
// Practice never feeds a voyage, the odds or the leaderboard (Maya's condition 1).
const PRACTICE = SS.where === "annapolis" && !SPECTATE; // ?where=annapolis, or the old ?practice
/** ?hour=21 sets the practice clock (Annapolis local time, April): for dusk and night looks. Default 10 am. */
const PRACTICE_SHIFT_H = Number.isFinite(Number(params.get("hour"))) && params.get("hour") !== null ? Number(params.get("hour")) - 10 : 0;
let practiceWind: { u: number; v: number } | null = null;
let practiceN = 0;
/** Where the practice spell began (the boat is there plus the wheel's x, y), or null. */
let practiceAt: LatLon | null = null;
/** The last place the boat was, so the view stays put between runs. */
let practiceHere: LatLon | null = null;
let practiceCourse: Course | null = null;
let practiceBreeze: Breeze = SS.breeze;
let depths: BayDepths | null = null;
const depthsReady = BayDepths.create().then((d) => {
  depths = d;
  showProloguePick();
  return d;
});
const buoys = new Buoys();
scene.add(buoys.group);
// Time trials (Elena approved 12 Nov): your best run's ghost, the course you last sailed.
const ghost = new Ghost();
scene.add(ghost.group);
let ghostTrack: Track | null = null;
let lastTrial: CourseKind | null = null;
/** The wind direction of the run being sailed (ghosts are kept turned to a north wind). */
let trialFrom = 0;
(window as unknown as { __buoys: Buoys }).__buoys = buoys; // for the proof frames and tests
function windFrom(fromDeg: number, kn: number): { u: number; v: number } {
  const ms = kn / 1.943844;
  const toward = ((fromDeg + 180) * Math.PI) / 180;
  return { u: Math.sin(toward) * ms, v: Math.cos(toward) * ms };
}
async function practiceSpell(kind: CourseKind | "drill"): Promise<void> {
  $("practice-end").hidden = true;
  buoys.set([]);
  if (kind === "drill" || !depths?.known) {
    const kinds = [
      { kn: 12, off: 90, name: "a reach: the wind from the side" },
      { kn: 10, off: 0, name: "a beat: the mark is upwind, so zigzag (tack) toward it" },
      { kn: 16, off: 165, name: "a run: the wind behind you" },
      { kn: 22, off: 70, name: "a fresh breeze: reef if she leans too far" },
    ];
    const k = kinds[practiceN++ % kinds.length];
    const from = (practiceN * 137) % 360; // a different compass each time
    practiceWind = windFrom(from, k.kn);
    // Mark bearing: `off` degrees from the wind; for a beat the mark is straight upwind and the
    // boat starts close-hauled.
    const mark = (from + k.off + 360) % 360;
    const heading = k.off === 0 ? (from + 50) % 360 : mark;
    practiceCourse = null;
    practiceAt = practiceHere = null;
    const ok = await wheel.start({ boatKey: "stock_cruiser31", heading, speedMs: 0, windU: practiceWind.u, windV: practiceWind.v, plan: "full", markBearing: mark });
    if (ok) {
      buoys.set([wheel.wheel!.markXY()]); // the drill's mark is a real buoy too
      banner(`Practice ${practiceN}: ${k.kn} knots, ${k.name}.`);
    }
    return;
  }
  // The triangle is laid to the wind, so any direction sails the same; the light run has a fixed wind so its times compare.
  const from = kind === "light" ? LIGHT_WIND_FROM : BAY_WINDS[Math.floor(Math.random() * BAY_WINDS.length)];
  const br = BREEZES[practiceBreeze];
  const trialKey = bestKey(kind, practiceBreeze);
  const stored = kind === "triangle" || kind === "light" ? readGhost(trialKey) : null;
  ghostTrack = stored ? turnTrack(stored, from) : null;
  trialFrom = from;
  lastTrial = kind;
  ghost.set(ghostTrack ? BUILDERS[spec.key](quality) : null);
  practiceWind = windFrom(from, br.kn);
  const c = kind === "triangle" ? triangle(from) : toTheLight();
  practiceCourse = c;
  practiceAt = practiceHere = c.start;
  depths.prefetch(c.start.lat, c.start.lon, 3000);
  const o = c.start;
  const gate = c.marks[c.marks.length - 1].gate;
  if (c.kind === "triangle") buoys.set(c.marks.slice(0, 2).map((m) => toXY(o, m)).concat([{ x: 0, y: 0 }]));
  else buoys.set(gate ? gate.map((g) => toXY(o, g)) : [], !!gate);
  const ok = await wheel.start({
    boatKey: "stock_cruiser31",
    heading: c.heading,
    speedMs: 0,
    windU: practiceWind.u,
    windV: practiceWind.v,
    plan: practiceBreeze === "fresh" ? "reef1" : "full",
    course: { marks: c.marks.map((m) => ({ ...toXY(o, m), name: m.name, gate: m.gate && ([toXY(o, m.gate[0]), toXY(o, m.gate[1])] as [XY, XY]) })), radiusM: c.radiusM },
    trial: kind === "triangle" || kind === "light" ? { best: ghostTrack } : undefined,
    depthAt: (x, y) => {
      const p = toLatLon(o, { x, y });
      depths!.prefetch(p.lat, p.lon);
      // The light's stones aren't in the survey: treat them as just awash.
      const s = toXY(THOMAS_POINT, p);
      if (Math.hypot(s.x, s.y) < LIGHT_STONES_M) return 0;
      return depths!.at(p.lat, p.lon);
    },
  });
  if (ok) {
    const point = (d: number) => ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][Math.round(d / 45) % 8];
    banner(c.kind === "triangle" ? `The triangle · ${br.kn} knots from the ${point(from)}` : `To Thomas Point Light · ${br.kn} knots from the ${point(from)} · ${LIGHT_FINISH_WORDS}`);
  } else practiceAt = null;
}
function practiceEnded(r: WheelResult): void {
  const c = practiceCourse;
  if (practiceAt && wheelLast) practiceHere = toLatLon(practiceAt, wheelLast);
  practiceAt = null;
  buoys.set([]);
  ghost.set(null);
  const card = $("practice-end");
  card.classList.remove("trial");
  $("practice-result").hidden = true;
  let text = wheelSummary(r, null).replace(/ (Sail a minute|Sail at least a minute|Your voyage waited|She keeps your trim|For the next).*$/, "");
  if (c) {
    const key = bestKey(c.kind, practiceBreeze);
    const pct = Math.round(r.share * 100);
    if (r.aground) text = `Shallow water: her keel touched the bottom ${r.markTimes.length ? `after ${r.markTimes.length} of ${r.marks} marks` : "before the first mark"}, so this run ends here. Watch the depth at the top of the wheel panel and steer for deeper water. Try again?`;
    else if (!r.reached) text = `Handed back after ${runTime(r.seconds)}, with ${r.markTimes.length} of ${r.marks} marks. Try again?`;
    else if (c.kind === "triangle" || c.kind === "light") {
      const before = saveBest(key, r.seconds);
      if (r.track) saveGhost(key, turnTrack(r.track, -trialFrom));
      showResult(c.kind, r.seconds, before);
      text = `Finished ${c.name} in ${runTime(r.seconds)}, trimmed at ${pct}% of her best speed.`;
    } else {
      const before = saveBest(key, r.seconds);
      const pb = before == null ? "Your first time on this course in this breeze." : r.seconds < before ? `A new best (it was ${runTime(before)})!` : `Your best: ${runTime(before)}.`;
      text = `Finished ${c.name} in ${runTime(r.seconds)} of boat time, trimmed at ${pct}% of her best speed. ${pb}`;
    }
  }
  $("practice-sum").textContent = text;
  if (c) practiceCard();
  // The course and wind are picked on the Set sail card (M1 piece 3), so the end card only
  // offers the same course again or the card ("Another course"), a drill included.
  const retry = !card.classList.contains("trial") && (c?.kind === "triangle" || c?.kind === "light");
  if (retry) {
    $("practice-ghost").textContent = "Try again";
    $("practice-result").hidden = false;
    // Only the buttons: no medal or time for a run that didn't finish (style, as .medal sets its own display).
    for (const el of Array.from($("practice-result").children)) (el as HTMLElement).style.display = el.classList.contains("result-go") ? "" : "none";
  } else for (const el of Array.from($("practice-result").children)) (el as HTMLElement).style.display = "";
  $("practice-again").hidden = retry || card.classList.contains("trial");
  card.hidden = false;
  $("practice-what").hidden = true;
}
/** A time trial's result: the medal, the time against your best, and what the next medal needs. */
function showResult(kind: "triangle" | "light", secs: number, before: number | null): void {
  const medal = medalFor(secs, kind, practiceBreeze);
  const box = $("practice-result");
  const m = box.querySelector<HTMLElement>(".medal")!;
  m.dataset.medal = medal ?? "";
  m.querySelector(".medal-name")!.textContent = medal ? MEDAL_WORDS[medal] : "Finished";
  const by = (d: number) => (d < 60 ? `${Math.round(d)} s` : trialClock(d));
  const vs = before == null ? "your first time" : secs < before ? `a new best, by ${by(before - secs)}` : `${by(secs - before)} slower than your best`;
  box.querySelector(".result-time")!.textContent = `${trialClock(secs)} · ${vs}`;
  const up: Medal | null = medal === "gold" ? null : medal === "silver" ? "gold" : medal === "bronze" ? "silver" : "bronze";
  box.querySelector(".result-next")!.textContent = up ? `${MEDAL_WORDS[up]}: under ${trialClock(medalTime(up, kind, practiceBreeze))}` : secs < ROBOT_SECS[kind][practiceBreeze] ? `Faster than the autopilot (${trialClock(ROBOT_SECS[kind][practiceBreeze])})` : `The autopilot: ${trialClock(ROBOT_SECS[kind][practiceBreeze])}. Beat it?`;
  // The first run has no ghost to race yet (Leo): "Try again"; after that, "Race your best run".
  $("practice-ghost").textContent = before == null ? "Try again" : "Race your best run";
  box.hidden = false;
  $("practice-end").classList.add("trial");
  $("practice-end").querySelector("h1")!.textContent = `${kind === "triangle" ? "The triangle" : "Thomas Point Light"} · ${BREEZES[practiceBreeze].kn} knots`;
}
/** The end card's heading for a run that isn't a time trial (the course itself is picked on the Set sail card). */
function practiceCard(): void {
  if (!$("practice-end").classList.contains("trial")) $("practice-end").querySelector("h1")!.textContent = "Practice sailing";
}
/** Back to the Set sail card, Annapolis still picked with the course and breeze you last sailed (M1 piece 3). */
function practiceToCard(): void {
  $("practice-end").hidden = true;
  $("practice-result").hidden = true;
  $("practice-end").classList.remove("trial");
  $("start").hidden = false;
}
if (PRACTICE) {
  document.body.classList.add("practice");
  // The Set sail card is practice's front door too (M1 piece 3): it opens with Annapolis picked,
  // unless a link already chose (?go=1 with a course).
  $("start").hidden = params.get("go") === "1" && !!SS.course;
  useBoat("stock_cruiser31");
  // Both "Another course" buttons go back to the card; "Race your best run" sails the same course again.
  $("practice-again").addEventListener("click", practiceToCard);
  $("practice-ghost").addEventListener("click", () => void (lastTrial && practiceSpell(lastTrial)));
  $("practice-other").addEventListener("click", practiceToCard);
  void depthsReady.then((d) => {
    page.practiceBay = d.known;
    if (d.known) {
      // Behind the Set sail card, the boat already off Annapolis with the town behind.
      practiceHere = ANNAPOLIS_COURSE;
      aimAt(290); // toward the town and the Naval Academy
      if (params.get("go") === "1" && SS.course) void practiceSpell(SS.course);
    } else if (params.get("go") === "1") void practiceSpell("drill"); // no Bay squares on this copy: the old drills
  });
}

// "Sail her out of the harbour" (Leo's plan, phase 2): before a voyage from Annapolis in a
// boat you can sail by hand, an optional spell out of the harbour to the open Bay. Then
// "four days later" the voyage starts at the Bay mouth exactly as without it: the trip
// down the Bay is skipped and doesn't count (said plainly on the card), and nothing of the
// spell reaches the simulator.
let prologueDone: ((r: WheelResult) => void) | null = null;
/** The boat key the start card would sail, if it can be sailed by hand. */
function handBoat(): string | null {
  const pick = chosenBoat();
  const k = pick === MINE ? String(startMine?.choices.base ?? "") : pick;
  return canTakeWheel(k) ? k : null;
}
function showProloguePick(): void {
  const can = !shared && $<HTMLSelectElement>("port").value === "annapolis" && !!handBoat() && !!depths?.known;
  $("prologuepick").hidden = !can;
  if (can) $("porthint").textContent = "Annapolis is up the Chesapeake Bay. The crossing starts at the Bay mouth, 4 days' sail down the Bay; that trip is skipped.";
}
async function runPrologue(boatKey: string): Promise<void> {
  const c = harbourExit();
  useBoat(boatKey); // the boat you'll sail, not the page's default kayak
  const from = HARBOUR_WINDS[Math.floor(Math.random() * HARBOUR_WINDS.length)];
  practiceWind = windFrom(from, BREEZES.good.kn);
  practiceCourse = c;
  practiceAt = practiceHere = c.start;
  depths!.prefetch(c.start.lat, c.start.lon, 4000);
  const o = c.start;
  buoys.set(c.marks.slice(0, -1).map((m) => toXY(o, m)));
  $("start").hidden = true;
  const ended = new Promise<WheelResult>((res) => (prologueDone = res));
  const ok = await wheel.start({
    boatKey,
    speed: 5, // about 20 boat-minutes, so about 4 minutes (Leo: the checkbox says so)
    backLabel: "Skip to the Bay mouth",
    heading: c.heading,
    speedMs: 0,
    windU: practiceWind.u,
    windV: practiceWind.v,
    plan: "full",
    course: { marks: c.marks.map((m) => ({ ...toXY(o, m), name: m.name })), radiusM: c.radiusM },
    depthAt: (x, y) => {
      const p = toLatLon(o, { x, y });
      depths!.prefetch(p.lat, p.lon);
      return depths!.at(p.lat, p.lon);
    },
  });
  if (!ok) {
    prologueDone = null;
    practiceAt = practiceHere = null;
    buoys.set([]);
    return;
  }
  banner("Out of Annapolis harbour · follow the marks to the open Bay · Esc skips");
  const r = await ended;
  const how = r.aground
    ? "She touched the bottom on the way out (no harm done: the harbour spell doesn't count)."
    : r.reached
      ? `You're out of the harbour: ${Math.max(1, Math.round(r.seconds / 60))} minutes at the wheel.`
      : "You skipped the rest of the way out.";
  $("prologue-sum").textContent = how;
  $("prologue-end").hidden = false;
  await new Promise<void>((res) => $("prologue-go").addEventListener("click", () => res(), { once: true }));
  $("prologue-end").hidden = true;
  practiceAt = practiceHere = null;
}
function prologueEnded(r: WheelResult): void {
  const done = prologueDone;
  prologueDone = null;
  practiceAt = null;
  buoys.set([]);
  $("practice-what").hidden = true;
  done?.(r);
}

/** How high the boat's rig stands above the water (m), from the model once it's loaded. */
const rigBox = new THREE.Box3();
let rigFor: unknown = null;
let rigTopM = 0;
function rigTop(): number {
  if (model && rigFor !== model.root) {
    rigBox.setFromObject(model.root);
    if (Number.isFinite(rigBox.max.y) && rigBox.max.y > 0.5) {
      rigTopM = rigBox.max.y - model.root.position.y;
      rigFor = model.root;
    }
  }
  return rigTopM || spec.length * 1.5; // GUESS until the model is in
}
// The sailing camera at the wheel (src/helm/chaseCam.ts; Elena approved the plan). V switches to
// the old orbit view and back; dragging the view takes it over until 4 s after you let go.
const chase = new ChaseCam();
controls.addEventListener("start", () => chase.drag(true));
controls.addEventListener("end", () => chase.drag(false));
const chaseLook = new THREE.Vector3();
let wheelFov = false;
/** Thomas Point Light from the boat, on the run to it (the camera's second subject); null otherwise. */
function lightAhead(): { bearing: number; distM: number; spanDeg?: number; leanDeg?: number } | null {
  const w = wheel.wheel;
  if (!w || !wheelNow || practiceCourse?.kind !== "light" || w.s.mark < practiceCourse.marks.length - 1) return null;
  const m = w.markXY();
  const here = wheelNow;
  const bearingOf = (p: XY) => ((Math.atan2(p.x - here.x, p.y - here.y) * 180) / Math.PI + 360) % 360;
  const distM = Math.hypot(m.x - here.x, m.y - here.y);
  const light = bearingOf(m);
  // Near the end, frame the light and its finish gate together: aim at the middle of the group, wide enough for all of it.
  const ends = practiceAt && distM < GATE_TAG_M ? practiceCourse.marks[practiceCourse.marks.length - 1].gate?.map((p) => bearingOf(toXY(practiceAt!, p))) : undefined;
  if (!ends) return { bearing: light, distM };
  const rel = [light, ...ends].map((b) => ((((b - light) % 360) + 540) % 360) - 180);
  const lo = Math.min(...rel);
  const hi = Math.max(...rel);
  return { bearing: (light + (lo + hi) / 2 + 360) % 360, distM, spanDeg: hi - lo, leanDeg: -(lo + hi) / 2 };
}
function wheelCamera(dt: number, t: number): void {
  if (cine.on) return; // the cinematic owns the lens
  const ours = !!wheelNow && chase.on;
  // Ease the lens in and out (45 is the page's own).
  const fov = ours ? chase.fov : 45;
  if (ours || wheelFov) {
    camera.fov += (fov - camera.fov) * (1 - Math.exp(-dt / 0.6));
    if (Math.abs(camera.fov - fov) < 0.05) camera.fov = fov;
    camera.updateProjectionMatrix();
    wheelFov = camera.fov !== 45;
  }
  if (!wheelNow || !wheel.wheel) {
    chase.reset();
    return;
  }
  // Compose in the screen above the wheel strip and below the top bar and goal banner.
  const strip = document.getElementById("wheel")?.getBoundingClientRect();
  const goal = document.getElementById("wheel-goal")?.getBoundingClientRect();
  const frame = { w: innerWidth, h: innerHeight, top: goal && goal.height ? goal.bottom + 6 : 50, bottom: strip && strip.height ? strip.top - 6 : innerHeight - 70, fovDeg: CHASE_FOV };
  const s = chase.update(dt, wheelNow.heading, wheel.wheel.twa(), spec.length, rigTop(), frame, stillCamera, lightAhead());
  if (!s) return;
  // A hand on the camera: a chase boat's slow bob (none with reduced motion).
  const bob = stillCamera ? 0 : Math.sin(t * 0.6) * 0.25 + Math.sin(t * 1.7 + 1) * 0.08;
  camera.position.lerp(chaseLook.set(s.pos[0], s.pos[1] + bob, s.pos[2]), s.blend);
  controls.target.lerp(chaseLook.set(s.look[0], s.look[1], s.look[2]), s.blend);
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".practice-note .info")))
  b.addEventListener("click", () => {
    const more = b.nextElementSibling as HTMLElement;
    more.hidden = !more.hidden;
    b.setAttribute("aria-expanded", String(!more.hidden));
  });
// One "Credits" link in place of the long line (Elena); the full text opens on a click.
$("credbtn").addEventListener("click", () => {
  const t = $("credtext");
  t.hidden = !t.hidden;
  $("credbtn").setAttribute("aria-expanded", String(!t.hidden));
});
/** The run's one-line banner under the goal: says what this is, then gets out of the way. */
let flashTimer = 0;
function banner(text: string): void {
  const el = $("practice-what");
  el.textContent = text;
  el.hidden = false;
  el.style.opacity = "1";
  clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    el.style.opacity = "0";
    flashTimer = window.setTimeout(() => (el.hidden = true), 900);
  }, 6000);
}

// A small pointer to the next mark (Leo): over it when it's in view, at the screen's edge when it isn't.
/** The in-view tag fades between these distances (m): the real-size buoy is easy to see by then. GUESS */
const MARK_TAG_FADE_M = 200;
const MARK_TAG_GONE_M = 70;
/** Beyond this (m) the in-view tag stays orange: the buoy is too small to see there. GUESS (Leo) */
const MARK_TAG_FAR_M = 300;
const markV = new THREE.Vector3();
/** Within this of Thomas Point Light (m), the mark tag points at the finish gate instead. GUESS */
const GATE_TAG_M = 2500;
/** The middle of the light run's finish gate, metres east and north of the course start; null on other courses. */
function gateMid(): XY | null {
  const gate = practiceCourse?.kind === "light" && practiceAt ? practiceCourse.marks[practiceCourse.marks.length - 1].gate : undefined;
  if (!gate || !practiceAt) return null;
  const [g0, g1] = gate.map((p) => toXY(practiceAt!, p));
  return { x: (g0.x + g1.x) / 2, y: (g0.y + g1.y) / 2 };
}
function markPointer(): void {
  const el = $("markptr");
  const w = wheel.wheel;
  if (!wheelNow || !w || $("wheel-goal").hidden) {
    el.hidden = true;
    return;
  }
  let m = w.markXY();
  camera.updateMatrixWorld();
  // Over a buoy's top; over the lighthouse's lantern (it's 13 m up), so the tag never hides the light itself.
  let atLight = practiceCourse?.kind === "light" && w.s.mark >= practiceCourse.marks.length - 1;
  // Near the light the tag moves to the finish gate between the two yellow marks east of it,
  // so the way to finish is plain (the camera keeps the light itself in the frame).
  const g = atLight ? gateMid() : null;
  const toGate = !!g && w.distToMark() < GATE_TAG_M;
  if (g && toGate) {
    m = g;
    atLight = false;
  }
  markV.set(m.x - wheelNow.x, atLight ? 24 : 3, -(m.y - wheelNow.y)).project(camera);
  const behind = markV.z > 1;
  let x = behind ? -markV.x : markV.x;
  let y = behind ? -markV.y : markV.y;
  const inView = !behind && Math.abs(x) < 0.95 && Math.abs(y) < 0.9;
  if (!inView) {
    const k = 0.9 / Math.max(Math.abs(x), Math.abs(y), 1e-6);
    x *= k;
    y = Math.max(-0.7, Math.min(0.75, y * k)); // keep clear of the strip and the banner
  }
  el.hidden = false;
  el.dataset.edge = inView ? "" : x < -0.85 ? "left" : x > 0.85 ? "right" : y < 0 ? "down" : "up";
  const d = toGate ? Math.hypot(m.x - wheelNow.x, m.y - wheelNow.y) : w.distToMark();
  // Over the buoy it's a quiet tag that fades once the buoy is plain to see (Elena, 12 Nov);
  // at the edge it stays a bold orange arrow, as that's the only way to find the mark.
  // Far off the buoy is a speck: keep the mark's orange so it reads as the mark (Leo); quiet once the buoy shows.
  el.toggleAttribute("data-far", inView && d > MARK_TAG_FAR_M);
  el.style.opacity = inView ? String(THREE.MathUtils.clamp((d - MARK_TAG_GONE_M) / (MARK_TAG_FADE_M - MARK_TAG_GONE_M), 0, 1)) : "1";
  const dist = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
  el.textContent = toGate ? `Finish ${dist}` : dist;
  el.style.left = `${((x + 1) / 2) * innerWidth}px`;
  el.style.top = `${((1 - y) / 2) * innerHeight}px`;
}

/** Hand-trimmed watches this game, as hours from the start, for the chart. */
const trimWatches: [number, number][] = [];
function trimRanges(): [number, number][] | undefined {
  return trimWatches.length ? trimWatches : undefined;
}
/** The results card's line on the wheel spells (Sam's trim_watches / trim_gain_km). */
function trimLine(c: Card): string {
  const n = c.trim_watches ?? 0;
  if (!n || c.trim_gain_km == null) return "";
  const km = Math.abs(c.trim_gain_km);
  const amount = km < 0.05 ? "about nothing" : `about ${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
  const way = km < 0.05 ? "" : c.trim_gain_km > 0 ? " gained" : " lost";
  return `Your trimming at the wheel was worth ${amount}${way} over ${n} watch${n > 1 ? "es" : ""}, against the autopilot's own trim.`;
}
function wheelOffered(): boolean {
  return page.ready && !SPECTATE && !page.status?.over && mode === "hands_on" && canTakeWheel(spec.key) && !cine.on;
}
async function takeWheel(): Promise<void> {
  if (wheel.on || !wheelOffered()) return;
  wheelRate = rate || lastRate;
  setRate(0, true);
  if (inFlight) await inFlight;
  const s = page.status;
  // The wind where the boat is now: the simulator's, or the track's at this hour.
  const r = rep();
  const hr = r ? Math.min(hour, lastHour(r)) : 0;
  // Last resort, at the very start: the forecast's first row (lead time zero).
  const f0 = lastForecast?.[0];
  const wu = s?.weather?.wind_u ?? (r ? valueAt(r, r.wind_u, hr) : null) ?? f0?.wind_u ?? null;
  const wv = s?.weather?.wind_v ?? (r ? valueAt(r, r.wind_v, hr) : null) ?? f0?.wind_v ?? null;
  if (!s || wu == null || wv == null) {
    note("There's no wind reading here yet: sail on a little, then take the wheel.", "At the wheel", TONE_COLOUR.warn);
    return setRate(wheelRate);
  }
  releaseKeys();
  const ok = await wheel.start({ boatKey: spec.key, heading: headingNow(), speedMs: s.boat.stw ?? 0, windU: wu, windV: wv, plan: s.sailing?.plan });
  if (!ok) return setRate(wheelRate);
  hideKeyHint();
  note("You have the wheel. Left/right steer; up pulls the sail in, down lets it out; R reefs. Sail to the mark, or Esc to hand back.", "At the wheel", TONE_COLOUR.info);
  showOrder();
}
$("b-wheel").addEventListener("click", (e) => {
  (e.currentTarget as HTMLElement).blur(); // the keys go to the wheel, not back to this button
  void takeWheel();
});
addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  // N: sound on or off, at the wheel or not (one key, one meaning: Elena).
  if (e.code === "KeyN" && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !t?.closest?.("input, select, textarea") && document.body.classList.contains("sailing")) {
    e.preventDefault();
    sound.toggle();
    return;
  }
  // A "Your call" card: 1-3 pick, Esc takes the autopilot's (before the speed keys, which share 1-4).
  if (!e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey && !t?.closest?.("input, select, textarea") && decisionKey(e)) {
    e.preventDefault();
    return;
  }
  // At the wheel (Rosa, src/helm/wheelSession.ts) the keys are the wheel's (practice has no game).
  if (wheel.on && !e.ctrlKey && !e.metaKey && !e.altKey && !t?.closest?.("input, select, textarea")) {
    if (e.code === "KeyV" && !e.repeat) {
      chase.on = !chase.on;
      note(chase.on ? "The chase camera." : "The deck view: drag to look around. V for the chase camera.", "At the wheel", TONE_COLOUR.info);
      e.preventDefault();
      return;
    }
    if (wheel.key(e, true)) e.preventDefault();
    return;
  }
  if (!page.ready || page.status?.over || busy || e.ctrlKey || e.metaKey || e.altKey || t?.closest?.("input, select, textarea, summary")) return;
  // Enter takes the wheel, unless a keyboard user has a button or link focused (then Enter presses it).
  if (e.code === "Enter" && !t?.closest?.("button:focus-visible, a:focus-visible") && wheelOffered()) {
    e.preventDefault();
    void takeWheel();
    return;
  }
  if (hud.key(e)) {
    e.preventDefault();
    return;
  }
  if (!e.repeat && e.code === "KeyC") {
    e.preventDefault();
    $("cinebtn").click();
    return;
  }
  const ax = keyAxis(e.code);
  if (e.code === "Space") {
    if (t?.closest?.("button")) return; // Space presses the focused button instead
    setRate(rate ? 0 : lastRate);
  } else if (SPEED_KEYS[e.code]) setRate(SPEED_KEYS[e.code]);
  else if (e.key === "?" || e.code === "KeyK") {
    hideKeyHint();
    hud.keys();
    e.preventDefault();
    return;
  } else if (ax && SPECTATE) return; // nothing to steer
  else if (ax) {
    // The autopilot sets its own power (#327); steering takes the boat off it.
    if (!(ax.axis === "power" && order === "auto") && !e.repeat) {
      axes[ax.axis].down(ax.dir, e.shiftKey, performance.now());
      hud.peekOrders(); // the drawer peeks open to show the dial moving
    }
  } else if (e.key === "Shift") {
    axes.heading.setFine(true);
    axes.power.setFine(true);
    return;
  } else return;
  e.preventDefault();
  hideKeyHint();
});
addEventListener("keyup", (e) => {
  if (wheel.on) {
    if (wheel.key(e, false)) e.preventDefault();
    return;
  }
  const ax = keyAxis(e.code);
  if (ax) axes[ax.axis].up(ax.dir, performance.now());
  else if (e.key === "Shift") {
    axes.heading.setFine(false);
    axes.power.setFine(false);
  }
});
/** The bearing the boat is being steered on now, when the order is "the finish" or "the route": where it's heading. */
function headingNow(): number {
  const s = page.status;
  if (!s) return 90;
  return Number.isFinite(s.boat.heading) ? s.boat.heading : bearing([s.boat.lat, s.boat.lon], (game.boat?.course.target ?? [39.5, -13.5]) as [number, number]);
}

/** "Until something happens": a big change from now, or an order arriving, at most 3 days. */
function untilOptions(): Record<string, number | boolean> {
  const st = page.status;
  const soc = st?.boat.soc ?? 1;
  const w = st?.weather;
  const wind = w ? Math.hypot(w.wind_u, w.wind_v) : 0;
  // No hours: the simulator stops by itself after 3 days of quiet sailing.
  const o: Record<string, number | boolean> = { breakdown: true };
  // Only the 20% reserve stops the clock: a big drop is a note that doesn't pause (batteryNote;
  // Leo, Rosa, 12 Nov: a stop with nothing to choose becomes a toast).
  if (soc > 0.2) o.soc_below = 0.2;
  if (wind < 15) o.wind_above = 17; // a gale coming (17 m/s is 33 knots); not again while it blows
  // A challenge's big call: stop the clock on its day, so it's asked then and not days later.
  const m = mission();
  if (st && m?.goal.call_day != null && !asked.mission && st.day < m.goal.call_day) o.hours = Math.max(0.5, (m.goal.call_day - st.day) * 24);
  return o;
}

// ---------- decisions (#328) ----------
// The clock stops for choices, not only for things that already happened: a gale in the
// forecast, a night that could run the battery flat, the Gulf Stream. Each is asked once
// per spell (a gale is not asked again for 2 days, a night for a day, the Stream until you
// leave it). Hands on only: from base, orders go by satellite and the forecast is the same.
/** `order`: what the choice would steer, so the card can show its forecast stake against the ghost. */
type Choice = {
  label: string;
  title: string;
  act: () => Promise<void> | void;
  order?: { heading: Heading; power?: number };
  /** The label once the forecast tag is beside it: no claims ("safer", "fastest") the forecast may contradict. */
  plain?: string;
  /** The option in running text, for a note ("Riding it"). */
  gist?: string;
};
/** look: the compass bearing of the problem (the gale, the Stream), for the camera to turn to as the call nears. */
type Decision = { kind: string; text: string; choices: Choice[]; look?: number; intro?: string };
/** Compass bearing (deg) of a vector given as east and north parts. */
const compassOf = (east: number, north: number): number => ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
const asked = { gale: -Infinity, night: -Infinity, stream: false, mission: false };
/** The Stream call, to say what it bought three days later (Leo): when, what, and the lead then. */
/** since: how the payoff opens when later calls are folded in; after: hours until it is told. */
let streamCall: { h: number; chose: string; lead: number; later: string[]; since?: string; after?: number } | null = null;
/** A later call made before the Stream's three days were up, so its debrief credits both (Leo). */
const alsoCalled = (what: string) => streamCall?.later.push(what);
/** The challenge's call, once made: which, and when (voyage hours), for the toast two days on. */
let missionCall: { key: string; h: number } | null = null;
const KT = 1.943844; // knots per m/s
const GALE_MS = 17; // 33 knots, gale force
const BIG_WAVES_M = 4;

function towards(u: number, v: number): string {
  const names = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
  return names[Math.round(((Math.atan2(u, v) * 180) / Math.PI + 360) / 45) % 8];
}

const kmh = (ms: number) => `${Math.round(ms * KT)} knots (about ${Math.round((ms * 3.6) / 5) * 5} km/h)`;
function inWords(hours: number): string {
  if (hours < 18) return `in about ${Math.max(1, Math.round(hours))} hours`;
  const d = Math.round((hours / 24) * 2) / 2;
  return d <= 1 ? "in about a day" : d === 1.5 ? "in about a day and a half" : `in about ${d % 1 ? `${Math.floor(d)} and a half` : d} days`;
}
/** The storm being sailed through after a "Your call", to say how it went once it's past (Leo). */
let spell: { kind: string; h: number; chose: string; km: number } | null = null;
/** The last blow you answered, so a second like it isn't asked again (Leo). */
let lastStorm: { kind: string; peakH: number; chose: string } | null = null;
/** At most one "Your call" per 2 voyage days (Leo's cadence guard), bar a clearly worse threat. */
const MIN_CALL_GAP_H = 48;

/** The decision due now, if any. */
function decisionDue(st: Status, fc: ForecastRow[] | null): Decision | null {
  if (mode !== "hands_on" || st.over || shared || st.no_link) return null;
  const h = st.day * 24;
  const w = st.weather;
  const motors = !st.sailboat && st.power_w > 0;
  const carryOn: Choice = { label: "Carry on as I am", title: "Keep the order you have", act: () => undefined };
  // A challenge's one big call (Sandy: run east, or south-east?), once, on its day.
  const m = mission();
  const call = m && CALLS[m.id];
  if (m && call && m.goal.call_day != null && !asked.mission && st.day >= m.goal.call_day) {
    asked.mission = true;
    return {
      kind: "mission",
      text: call.text,
      choices: call.options.map((o) => ({
        label: o.label,
        title: o.title,
        act: () => {
          missionCall = { key: o.key, h };
          return o.heading === "auto" ? setOrder("auto") : setOrder(o.heading, o.power ?? power);
        },
      })),
    };
  }
  // Two days after it: what the call bought you, against the ghost.
  if (missionCall && h - missionCall.h >= 48) {
    const text = callToast(missionCall.key, st.lead_km);
    whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, TONE_COLOUR.good));
    missionCall = null;
  }
  const nowWind = w ? Math.hypot(w.wind_u, w.wind_v) : 0;
  const t0 = utc(st.boat.t);
  const ahead = (fc ?? []).map((r) => ({ ...r, ah: (utc(r.t) - t0) / 3.6e6 }));
  const rough = (r: ForecastRow) => Math.hypot(r.wind_u, r.wind_v) >= GALE_MS || r.hs >= BIG_WAVES_M;
  // After a storm call: once it has blown over, say how the choice went.
  if (spell && h - spell.h >= 18 && nowWind < GALE_MS - 4 && (w?.hs ?? 0) < BIG_WAVES_M - 1 && !ahead.some((r) => r.ah > 0 && r.ah <= 12 && rough(r))) {
    const flat = (game.boat?.events ?? []).filter((e) => e.kind === "capsize" && e.h >= spell!.h).length;
    const verb: Record<string, string> = { hold: "held your course", dodge: "dodged south-east", slow: "slowed down to ride it out" };
    const gone = spell.kind === "gale" ? "The gale has passed" : "The big waves have passed";
    const how = flat ? `you were knocked flat ${flat === 1 ? "once" : `${flat} times`}` : "you stayed upright";
    const made = Math.round(spell.km - st.boat.km_to_finish);
    const progress = made > 0 ? `made ${made.toLocaleString()} km towards the finish since` : `the weather pushed you back ${(-made).toLocaleString()} km`;
    const text = `${gone}. You ${verb[spell.chose] ?? "carried on"}: ${how}, and ${progress}.${spell.chose === "dodge" ? " Aim at the finish again when you're ready." : ""}`;
    whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, flat ? TONE_COLOUR.warn : TONE_COLOUR.good));
    spell = null;
  }
  // Gale or big waves in the next 2 days, while it's not blowing yet.
  if (fc && nowWind < GALE_MS - 2 && (w?.hs ?? 0) < BIG_WAVES_M - 0.5 && h - asked.gale >= 48) {
    const rows = ahead.filter((r) => r.ah > 0 && r.ah <= 48);
    const bad = rows.find(rough);
    if (bad) {
      asked.gale = h;
      const peakW = Math.max(...rows.map((r) => Math.hypot(r.wind_u, r.wind_v)));
      const peakH = Math.max(...rows.map((r) => r.hs));
      const kind = peakW >= GALE_MS ? "gale" : "waves";
      // At most one call per 2 voyage days, and the same kind of blow isn't asked twice: the
      // last answer stands, and a toast says so (Leo). Only a clearly worse threat asks again:
      // a gale after big waves, or a peak a metre or more higher than the one last answered.
      const worse = !lastStorm || (kind === "gale" && lastStorm.kind === "waves") || peakH >= lastStorm.peakH + 1;
      if (!worse) {
        if (lastStorm) {
          const still = lastStorm.chose === "slow" && power <= 0.1 ? "still slowing down, as you chose" : lastStorm.chose === "dodge" && typeof order === "number" ? "still dodging, as you chose" : "your order stands";
          const text = `More ${kind === "gale" ? "gale" : "big waves"} ahead ${inWords(bad.ah)} (waves up to ${peakH.toFixed(1)} m): ${still}. Change it in Orders.`;
          whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, TONE_COLOUR.warn));
        }
        return null;
      }
      const toFinish = bearing([st.boat.lat, st.boat.lon], (game.boat?.course.target ?? [39.5, -13.5]) as [number, number]);
      const south = Math.round(((toFinish + 50) % 360) / 5) * 5;
      const what = kind === "gale" ? "the gale" : "the waves";
      const did: Record<string, string> = { hold: `held course through ${what}`, dodge: `dodged ${what}`, slow: `slowed for ${what}` };
      const call = (chose: string, act: () => Promise<void> | void) => () => {
        spell = { kind, h, chose, km: st.boat.km_to_finish };
        lastStorm = { kind, peakH, chose };
        alsoCalled(did[chose]);
        return act();
      };
      const choices: Choice[] = [
        // Stakes from the same 4-day look; "waves to X m" beside each is the risk side (Maya).
        // With the forecast beside them the labels carry no claims: on 23 Apr the 120° "dodge"
        // forecast 214 km gained AND 0.6 m bigger waves, so "safer, a longer way round" was
        // wrong on both counts (Sam, 12 Nov). The tag says which is faster and which rougher.
        { label: "Hold course: fastest, but a knockdown is likelier", plain: "Hold course", title: "Sail on through it", act: call("hold", () => undefined), order: { heading: order, power } },
        { label: `Dodge south-east (${south}°): safer, but a longer way round`, plain: `Turn south-east (${south}°)`, title: "Steer away from the worst of it; aim at the finish again once it has passed", act: call("dodge", () => setOrder(south)), order: { heading: south, power } },
      ];
      if (motors && power > 0.1)
        choices.push({ label: "Slow down and ride it out (10% power): less pounding, saves battery, loses time", plain: "Slow down to 10% power and ride it out", title: "The motors ease off; turn them back up after the blow", act: call("slow", () => setOrder(order === "auto" ? "route" : order, 0.1)), order: { heading: order === "auto" ? "route" : order, power: 0.1 } });
      return {
        kind,
        look: compassOf(-bad.wind_u, -bad.wind_v), // where it blows from
        text: `${kind === "gale" ? "A gale is" : "Big waves are"} forecast here ${inWords(bad.ah)}: wind up to ${kmh(peakW)} and waves up to ${peakH.toFixed(1)} m. A small boat can be knocked flat in that. What will you do?`,
        choices,
      };
    }
  }
  // A night that could run the battery flat.
  if (fc && motors && st.boat.soc < 0.35 && power > 0.15 && order !== "auto" && h - asked.night >= 24 && h - lastCallH >= MIN_CALL_GAP_H) {
    if (ahead.some((r) => r.ah > 0 && r.ah <= 12 && r.ghi < 5)) {
      asked.night = h;
      return {
        kind: "night",
        text: `The battery is at ${Math.round(st.boat.soc * 100)}% and night is coming, with no sun to charge it. At your ${Math.round(power * 100)}% power the motors could run it flat before morning, and a flat boat can't call home.`,
        choices: [
          { label: "Ease off to 10%: slower, but lasts till sunrise", title: "Turn the power back up in the morning", act: () => (alsoCalled("eased off for the night"), setOrder(order, 0.1)) },
          { ...carryOn, label: "Keep the power up: faster, but may run flat overnight", act: () => void alsoCalled("kept the power up overnight") },
        ],
      };
    }
  }
  // Three days after the Stream call: what it bought, against the ghost on autopilot (Leo).
  if (streamCall && h - streamCall.h >= (streamCall.after ?? 72)) {
    const km = Math.round(st.lead_km);
    const was = Math.round(streamCall.lead);
    const where = Math.abs(km) < 1 ? "level with the ghost" : `${Math.abs(km).toLocaleString()} km ${km > 0 ? "ahead of" : "behind"} the ghost`;
    // One number, and no credit to the Stream for a later call's doing: fold the later calls in.
    const later = streamCall.later;
    const also = later.length ? ` You also ${later.length > 1 ? `${later.slice(0, -1).join(", ")} and ${later[later.length - 1]}` : later[0]}.` : "";
    const span = `${Math.round((streamCall.after ?? 72) / 24)} days`;
    const text = later.length ? `${streamCall.since ?? "Since the Stream"}: ${where} after ${span}.${also}` : `${streamCall.chose}: ${where} after ${span}.`;
    // White on the strip's glass, with the colour on the number only (Elena).
    const num = Math.abs(km) < 1 ? undefined : `${Math.abs(km).toLocaleString()} km`;
    whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, km - was >= 0 ? TONE_COLOUR.good : TONE_COLOUR.warn, num));
    streamCall = null;
  }
  // The Gulf Stream: a river of warm water in the sea, running north-east at up to 4 knots.
  // The first real call of a crossing (Leo's first-five-minutes audit, F5; Maya's build plan):
  // asked once a voyage, the first time the boat is in it, whatever the order. Both answers
  // are ordinary orders the simulator sails in the real current; the ghost stays on auto.
  const cur = w ? Math.hypot(w.current_u, w.current_v) : 0;
  // Not in a challenge with a goal: there the Stream is neither a call nor a note (Elena, 13 Nov).
  if (w && cur >= 1 && !asked.stream && callAllowed("stream", !!m) && h - lastCallH >= MIN_CALL_GAP_H) {
    asked.stream = true;
    const toFinish = bearing([st.boat.lat, st.boat.lon], (game.boat?.course.target ?? [39.5, -13.5]) as [number, number]);
    // Wind against the current heaps the sea up into short steep waves: the Stream's real danger.
    const against = nowWind > 6 && (w.wind_u * w.current_u + w.wind_v * w.current_v) / (nowWind * cur) < -0.3;
    const knots = Math.round(cur * KT);
    const across = Math.round(toFinish) % 360;
    // One line (Elena): the card's options and their stakes carry the rest.
    return {
      kind: "stream",
      intro: `You're in the Gulf Stream, a warm current pushing ${towards(w.current_u, w.current_v)} at about ${knots} knots.`,
      look: compassOf(w.current_u, w.current_v), // down the Stream, the way it runs
      text: `The Gulf Stream: a ${knots}-knot river running ${towards(w.current_u, w.current_v)}.${against ? " Wind against it makes steep seas." : ""}`,
      choices: [
        {
          label: `Ride it ${towards(w.current_u, w.current_v)}: a free push, the longer way${against ? ", rough for now" : ""}`,
          gist: "Riding it",
          title: "Follow the planned route, which rides the current",
          order: { heading: "route", power },
          act: () => {
            streamCall = { h, chose: "Riding the Stream", lead: st.lead_km, later: [] };
            return setOrder("route");
          },
        },
        {
          label: `Cut straight across (${String(across).padStart(3, "0")}°): the short way, slower while you cross`,
          gist: "Cutting straight across",
          title: "Hold a straight course for the finish",
          order: { heading: across, power },
          act: () => {
            streamCall = { h, chose: "Cutting across the Stream", lead: st.lead_km, later: [] };
            return setOrder(Math.round(toFinish));
          },
        },
        { label: "Let the autopilot decide (what the ghost does)", title: "The autopilot's route allows for the current", act: () => setOrder("auto"), order: { heading: "auto" } },
      ],
    };
  }
  return null;
}

let decisionSeq = 0;
/** The calls made when the clock stopped, for the results card. */
const calls: Call[] = [];

/** Stop the clock and ask, when a decision is due. */
// ---------- the route check (#10, the fallback call) ----------
// When nothing has asked for a while (a random 3 to 5 voyage days, so calls don't land on a
// beat: Elena), a navigator's moment: the forecast's best line against yours over the next
// 4 days. Asked only when it's worth it: the forecast puts the best line ROUTE_GAIN_DAYS or more
// ahead of what you're doing now; otherwise the clock never stops and it looks again in a day.
const ROUTE_GAIN_DAYS = 0.25; // a quarter of a day on the ghost over the 4-day look
const ROUTE_MIN_TURN = 10; // degrees: smaller is not a different line
let lastCallH = -Infinity; // the first call of a voyage is never held back
let routeLookedH = -Infinity;
let callCount = 0;
/** Hours of quiet before the next route check: 72 to 120, fixed by the voyage and the call count. */
function quietGapH(): number {
  const x = Math.sin((callCount + 1) * 12.9898 + (game.boat?.seed ?? 0) * 0.017) * 43758.5453;
  return 72 + 48 * (x - Math.floor(x));
}
const fmtDeg = (d: number) => `${String(Math.round(d) % 360).padStart(3, "0")}°`;
function orderWords(o: Heading): string {
  return typeof o === "number" ? `your ${fmtDeg(o)}` : o === "auto" ? "the autopilot's line" : o === "route" ? "the planned route" : "straight at the finish";
}

/** The first chase (Rosa, Elena, 12 Nov): in a crossing's first days, the first time the forecast's
 * best line beats the autopilot's by over half a day AND costs something, the route check asks
 * then and there instead of waiting out its quiet days. Once a voyage. */
let chaseAsked = false;
const CHASE_FROM_H = 12; // not on the start line: she sails a little first
const CHASE_UNTIL_H = 120; // looked for in the first 5 days only: each look pauses about a second
const CHASE_EVERY_H = 12;
const CHASE_GAIN_DAYS = 0.5;
const CHASE_SEAS_M = 4;
const CHASE_SOC = 0.25;

/** Look for a better line; true if the clock was stopped to look. */
function maybeRouteCheck(st: Status): boolean {
  // No link, no orders (#404): no route looks, chases or navigator's notes to act on either.
  if (mode !== "hands_on" || st.over || shared || st.no_link || linkCut) return false;
  // A challenge with a goal has its own one big call (Sandy, #431, signed off as that): the route
  // check and the first chase stay out of it, and never start a look from a skip's stopped clock.
  if (!callAllowed("route", !!mission()) || !callAllowed("chase", !!mission())) return false;
  const h = st.day * 24;
  const quiet = h - Math.max(lastCallH, 0) >= quietGapH() && h - routeLookedH >= 24;
  const early = !chaseAsked && h >= CHASE_FROM_H && h < CHASE_UNTIL_H && h - lastCallH >= MIN_CALL_GAP_H && h - routeLookedH >= CHASE_EVERY_H;
  if (!quiet && !early) return false;
  routeLookedH = h;
  looking = true; // the simulator waits; the clock runs on (no "Paused" for a look)
  const seq = ++decisionSeq;
  const resume = () => {
    if (seq === decisionSeq) looking = false;
  };
  /** The look ends in a card: now the clock pauses, the picture plays on to the look's moment, and it asks. */
  const askAt = (show: () => void) => {
    if (seq !== decisionSeq) return;
    looking = false;
    setRate(0, true);
    whenAt(h, () => {
      if (seq === decisionSeq && rate === 0 && !game.status?.over) show();
    });
  };
  (async () => {
    const b: BestHeading | null = await game.bestHeading().catch(() => null);
    if (!b || seq !== decisionSeq) return resume();
    const mine: { heading: Heading; power: number } = { heading: order, power };
    const o = await game.outlook([{ heading: b.best, power }, mine, { heading: "auto" }], LOOK_H).catch(() => null);
    if (!o || seq !== decisionSeq) return resume();
    const [best, now, auto] = o.orders;
    const turn = Math.abs(((b.best - b.heading + 540) % 360) - 180);
    const gainKm = best.lead_km - now.lead_km;
    const pace = o.hours > 0 ? (o.ghost.km / o.hours) * 24 : 0;
    const gainDays = pace > 1 ? gainKm / pace : 0;
    // A real decision needs a price on the better line (Elena): rougher seas, or a lower battery.
    const rougher = (best.hs_max ?? 0) - (now.hs_max ?? 0) >= 0.75;
    const drains = (now.soc_min ?? 1) - (best.soc_min ?? 1) >= 0.08;
    const better = gainDays >= ROUTE_GAIN_DAYS && turn >= ROUTE_MIN_TURN;
    // The chase is weighed against the autopilot (what the ghost does), not your order.
    const autoDays = pace > 1 ? (best.lead_km - auto.lead_km) / pace : 0;
    // A price the player feels (Ines, Rosa): seas of 4 m or more and 0.75 m above the autopilot's,
    // or a battery low point under the night-call line (25%) and 8 points below the autopilot's.
    const chaseRougher = (best.hs_max ?? 0) >= CHASE_SEAS_M && (best.hs_max ?? 0) - (auto.hs_max ?? 0) >= 0.75;
    const chaseDrains = (best.soc_min ?? 1) < CHASE_SOC && (auto.soc_min ?? 1) - (best.soc_min ?? 1) >= 0.08;
    const chase = early && autoDays > CHASE_GAIN_DAYS && turn >= ROUTE_MIN_TURN && (chaseRougher || chaseDrains);
    const ask = chase || (quiet && better && (rougher || drains));
    page.routeChecks.push({ day: st.day, best: b.best, gain: gainKm, turn, asked: ask });
    if (chase) {
      chaseAsked = true;
      lastCallH = h;
      callCount++;
      page.decisions.push({ kind: "chase", day: st.day });
      // Relative words, not a compass point (Leo): "south-east" reads as "away from Portugal".
      const rad = Math.PI / 180;
      const side = Math.cos(b.best * rad) < Math.cos(b.heading * rad) ? "south" : "north";
      const deg = Math.max(5, Math.round(turn / 5) * 5);
      // "Stronger wind" only when the forecast's line really has more of it.
      const windier = (best.wind_max ?? 0) - (auto.wind_max ?? 0) >= 1;
      const d: Decision = {
        kind: "chase",
        text: windier ? `Stronger wind ${deg}° further ${side}. Chase it?` : `The forecast shows a faster line ${deg}° further ${side}. Take it?`,
        choices: [
          { label: `Bend ${deg}° ${side}`, title: `Steer ${fmtDeg(b.best)}; the route check looks again in a few days`, act: () => {
            // What it bought, told when the forecast's 4 days are up (Rosa): the truth, which can be less.
            streamCall = { h, chose: `Since you bent ${deg}° ${side}`, since: `Since you bent ${deg}° ${side}`, lead: st.lead_km, later: [], after: LOOK_H };
            return setOrder(b.best);
          }, order: { heading: b.best, power } },
          { label: order === "auto" ? "Keep your course (the autopilot's choice)" : "Back on the autopilot (what the ghost does)", title: "The autopilot steers, as it does for the ghost", act: () => setOrder("auto"), order: { heading: "auto" } },
        ],
      };
      const view: Outlook = { ...o, orders: [best, auto] };
      askAt(() => showDecision(d, view, [true, true]));
      return;
    }
    if (!quiet) return resume(); // an early look that found no chase: nothing to say
    if (better && !ask) {
      // Better and no dearer: nothing to weigh, so no card; a navigator's note instead.
      const text = `Navigator's note: the forecast favours ${fmtDeg(b.best)} over ${orderWords(order)} for the next 4 days (${timeChange(gainKm, pace)}), in no worse seas. Change it in Orders.`;
      whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, TONE_COLOUR.info));
    }
    if (!ask) return resume();
    lastCallH = h;
    callCount++;
    page.decisions.push({ kind: "route", day: st.day });
    const price = [rougher ? `rougher seas (waves to ${best.hs_max!.toFixed(1)} m, not ${now.hs_max!.toFixed(1)})` : "", drains ? `a lower battery (down to ${Math.round(best.soc_min! * 100)}%)` : ""].filter(Boolean).join(" and ");
    // The autopilot and the forecast's line agree (within 3 km): one option, not two (Elena).
    const same = pace > 1 && Math.abs(auto.lead_km - best.lead_km) / pace < 0.25;
    const d: Decision = {
      kind: "route",
      text: `Navigator's check: the forecast says ${fmtDeg(b.best)} would gain on ${orderWords(order)} over the next 4 days, but through ${price}.`,
      choices: [
        { label: `Take ${fmtDeg(b.best)}${same ? " (about what the autopilot does)" : ""}`, title: "Hold this heading; check again in a couple of days", act: () => setOrder(b.best), order: { heading: b.best, power } },
        { label: order === "auto" ? "Stay on the autopilot (what the ghost does)" : `Keep ${orderWords(order)}`, title: "Carry on as you are", act: () => undefined, order: mine },
        { label: "Let the autopilot decide (what the ghost does)", title: "Back on the autopilot", act: () => setOrder("auto"), order: { heading: "auto" } },
      ],
    };
    const picks = order === "auto" || same ? [0, 1] : [0, 1, 2];
    d.choices = picks.map((k) => d.choices[k]);
    const view: Outlook = { ...o, orders: picks.map((k) => o.orders[k]) };
    askAt(() => showDecision(d, view, picks.map(() => true)));
  })();
  return true;
}

/** Whether a call is worth a card (Elena's rule): some option beats the autopilot by a quarter
 * of a day or more over the look, and pays for it (rougher seas or a lower battery). A free win
 * or a tie is a note, not a question. Returns the note's words when it isn't worth asking. */
function notWorthAsking(d: Decision, o: Outlook, has: boolean[]): string | null {
  const auto = d.choices.findIndex((c) => c.order?.heading === "auto");
  if (auto < 0 || !has[auto]) return null;
  const pace = o.hours > 0 ? (o.ghost.km / o.hours) * 24 : 0;
  if (pace <= 1) return null;
  const base = o.orders[auto];
  let free: { i: number; days: number } | null = null;
  for (const [i, p] of o.orders.entries()) {
    if (i === auto || !has[i]) continue;
    const days = (p.lead_km - base.lead_km) / pace;
    if (days < 0.25) continue;
    const priced = (p.hs_max ?? 0) - (base.hs_max ?? 0) >= 0.5 || (base.soc_min ?? 1) - (p.soc_min ?? 1) >= 0.08;
    if (priced) return null; // a real trade: ask
    if (!free || days > free.days) free = { i, days };
  }
  // Leo's words: km, as in the strip's cell; "forecast" kept so it isn't read as a promise.
  const days = Math.round(o.hours / 24);
  const intro = d.intro ?? d.text;
  if (free) {
    const km = Math.round((o.orders[free.i].lead_km - base.lead_km) / 5) * 5;
    const gist = d.choices[free.i].gist ?? d.choices[free.i].label.split(":")[0];
    return `${intro} ${gist} looks about ${km} km better than the autopilot's line over the next ${days} days, in no rougher seas (forecast). Want to? Open Orders.`;
  }
  return `${intro} The forecast shows no better way through than the autopilot's, so she carries on.`;
}

/** A challenge's big call is due now (its day has come and it hasn't been asked). */
function callDue(): boolean {
  const m = mission();
  const st = page.status;
  return !!(m && st && m.goal.call_day != null && !asked.mission && CALLS[m.id] && st.day >= m.goal.call_day);
}
/** force: ask even with the clock stopped (a challenge's skip must not jump past its big call). */
function maybeDecide(force = false): boolean {
  const st = game.status;
  if (SPECTATE || !st || (rate === 0 && !force)) return false; // no calls to make in a recorded voyage or a race
  const d = decisionDue(st, lastForecast);
  if (!d) return maybeRouteCheck(st);
  const callBefore = lastCallH;
  lastCallH = st.day * 24;
  callCount++;
  // The Stream may come out as only a note (Elena's rule), so it looks first with the clock
  // running and pauses only for a card; a storm always asks, so it pauses now.
  const stream = d.kind === "stream";
  if (stream) looking = true;
  else setRate(0, true);
  page.decisions.push({ kind: d.kind, day: st.day });
  // See it coming (Rosa): over the last half day before the call the picture slows to an hour
  // a second and the camera turns toward the problem, so the pause lands on a picture of it.
  foresee = { from: st.day * 24 - 12, h: st.day * 24, look: d.look ?? null };
  // Asked once the picture gets there, so the question and the view agree. Carrying on
  // before then skips it; a later question replaces it.
  const seq = ++decisionSeq;
  // Each option's stake against the ghost in 2 days, from the forecast as issued (never the
  // truth), while the picture catches up. An older simulator, or a failure: no stakes.
  const orders = d.choices.map((c) => c.order);
  const stakes: Promise<Outlook | null> = orders.some(Boolean)
    ? game.outlook(orders.map((o) => o ?? { heading: "auto" }), LOOK_H).catch(() => null)
    : Promise.resolve(null);
  const has = orders.map((x) => !!x);
  const h = st.day * 24;
  if (stream) {
    void stakes.then((o) => {
      if (seq !== decisionSeq) return;
      looking = false;
      // The Stream asks only when there's something to weigh (Elena, 12 Nov); otherwise a
      // note, and the clock never stopped.
      const quiet = o ? notWorthAsking(d, o, has) : null;
      if (quiet) {
        lastCallH = callBefore; // no call was made: the cadence guard doesn't count it
        page.decisions.at(-1)!.asked = false;
        whenAt(h, () => note(quiet, `Day ${st.day.toFixed(1)}`, TONE_COLOUR.info));
        return;
      }
      setRate(0, true);
      whenAt(h, () => {
        if (seq === decisionSeq && rate === 0 && !game.status?.over) showDecision(d, o, has);
      });
    });
    return true;
  }
  whenAt(h, async () => {
    const o = await stakes;
    if (seq !== decisionSeq || rate !== 0 || game.status?.over) return;
    showDecision(d, o, has);
  });
  return true;
}

/** How far ahead the stakes look: 4 days. A 10-day look took about 4 s in Pyodide, past
 * Maya's 2 s budget; 4 days took about 1.6 s. Stakes beyond 2 days, because a 2-day gain
 * can turn into days lost at the finish (gameplay/router-north-bias.md). */
const LOOK_H = 96;
/** The gap change against the ghost, in km like the strip's "vs the ghost" cell (Leo, 12 Nov:
 * one unit on the card, the toasts and the strip). Under a quarter of a day at the ghost's
 * pace is "about the same". */
function timeChange(km: number, kmPerDay: number): string {
  const d = kmPerDay > 1 ? km / kmPerDay : 0;
  if (Math.abs(d) < 0.25) return "about the same against the ghost";
  const n = Math.max(5, Math.round(Math.abs(km) / 5) * 5);
  return km > 0 ? `about ${n} km gained on the ghost` : `about ${n} km lost to the ghost`;
}
/** Its cost beside it, where the options differ: the roughest sea, the lowest battery. */
function costWords(p: Preview, all: Preview[], waves = false, meaning = false): string {
  const out: string[] = [];
  const hs = all.map((x) => x.hs_max ?? 0);
  // On a storm card the waves are the risk being weighed, so they always show (Sam).
  // `meaning`: on the line that pays, say what the price means (Rosa, Ines). In the simulator
  // a knockdown gets likelier with bigger waves, and under 15% the motors stop to keep the
  // electronics and the radio going (autonomy/safemode.py hold_below_soc).
  if (p.hs_max != null && (waves || Math.max(...hs) - Math.min(...hs) >= 0.5))
    out.push(`waves to ${p.hs_max.toFixed(1)} m${meaning && p.hs_max >= CHASE_SEAS_M ? ": a knockdown is likelier" : ""}`);
  const soc = all.map((x) => x.soc_min ?? 1);
  if (p.soc_min != null && Math.max(...soc) - Math.min(...soc) >= 0.08)
    out.push(`battery down to ${Math.round(p.soc_min * 100)}%${meaning && p.soc_min < CHASE_SOC ? ": near the 15% where her motors stop to save the radio, so a cloudy spell could leave her drifting" : ""}`);
  return out.length ? ` · ${out.join(" · ")}` : "";
}

/** The open call's map, redrawn when an option is hovered or focused (-1: none). */
let drawDecisionMap: ((lit: number) => void) | null = null;

function showDecision(d: Decision, o: Outlook | null = null, has: boolean[] = []): void {
  $("decidetext").textContent = d.text;
  const box = $("decidebtns");
  box.replaceChildren();
  // The card is a map first (Rosa's cards, Elena's plan note 1): each option's forecast line in
  // its own colour, and the ghost's, faint and dashed. No map without the lines.
  page.outlook = o;
  const lines: (Line | null)[] = d.choices.map((_, i) => (o && has[i] ? (o.orders[i]?.track ?? null) : null));
  const st = game.status;
  const map = $<HTMLCanvasElement>("decidemap");
  const withMap = !!st && lines.some((l) => l && l.length > 1);
  map.hidden = !withMap;
  $("decide").classList.toggle("withmap", withMap);
  // The map's key, in the card's own words (Ines): the band is named only when there is one.
  const fast = !!o?.current?.u.some((u, k) => Math.hypot(u, o.current!.v[k]) >= 1);
  const band = fast ? ` Grey band: ${d.kind === "stream" ? "the Stream" : "a strong current"} (forecast).` : "";
  $("decidefoot").textContent = `Time is paused until you choose.${withMap ? ` Dashed: the ghost.${band}` : ""} Keys 1-${d.choices.length}, or Esc for the autopilot.`;
  drawDecisionMap = withMap
    ? (lit) => drawCallMap(map, chartLand, [st!.boat.lat, st!.boat.lon], lines, o?.ghost.track ?? null, lit, o?.current ?? null)
    : null;
  for (const [i, c] of d.choices.entries()) {
    const b = document.createElement("button");
    b.title = c.title;
    const key = document.createElement("kbd");
    key.textContent = String(i + 1);
    // Beside its forecast tag a label carries no claims (c.plain); without one, the full label.
    b.append(key, o && has[i] && c.plain ? c.plain : c.label);
    if (withMap && lines[i]) b.style.setProperty("--opt", OPTION_COLOURS[i % OPTION_COLOURS.length]);
    const p = o && has[i] ? o.orders[i] : null;
    if (p) {
      const k = document.createElement("span");
      k.className = "stake";
      const days = Math.round(o!.hours / 24);
      const shown = o!.orders.filter((_, j) => has[j]);
      // One tag in race terms, worded as a forecast so it can honestly be wrong (Maya, Leo).
      const pace = o!.hours > 0 ? (o!.ghost.km / o!.hours) * 24 : 0;
      k.textContent = `Forecast, next ${days} days: ${timeChange(p.lead_km - o!.lead_now_km, pace)}${costWords(p, shown, d.kind === "gale" || d.kind === "waves", d.kind === "chase" && i === 0)}${p.outcome !== "at_sea" ? ` (${p.outcome.replace(/_/g, " ")})` : ""}`;
      b.append(k);
    }
    const lightUp = (on: boolean) => drawDecisionMap?.(on ? i : -1);
    b.addEventListener("mouseenter", () => lightUp(true));
    b.addEventListener("mouseleave", () => lightUp(false));
    b.addEventListener("focus", () => lightUp(true));
    b.addEventListener("blur", () => lightUp(false));
    b.addEventListener("click", async () => {
      $("decide").hidden = true;
      page.outlook = null;
      drawDecisionMap = null;
      // For the results card's "your calls": what was chosen, and the lead on the ghost then.
      if (game.status) calls.push({ day: game.status.day, chose: callName(c.label), lead: game.status.lead_km });
      await c.act();
      setRate(lastRate);
      if (!soundAsked) window.setTimeout(askSound, 4000); // after the first call, once the clock is running again
    });
    box.append(b);
  }
  $("decide").hidden = false;
  // On the right, it sits 12 px under the chart, whatever the chart's size (Ines).
  const chartBox = document.getElementById("mapbox")?.getBoundingClientRect();
  $("decide").style.top = withMap && chartBox && chartBox.height > 0 ? `${Math.round(chartBox.bottom + 12)}px` : "";
  foresee = null;
  drawDecisionMap?.(-1);
  // With a map on the card, the 5-day strip stays shut: together they buried the boat (Elena).
  if (!withMap) {
    $("fcbox").classList.add("lit");
    hud.forecast(true, true);
  }
}

/** 1, 2, 3 pick a call's options; Esc takes the autopilot's (always one key away). */
function decisionKey(e: KeyboardEvent): boolean {
  if ($("decide").hidden) return false;
  const btns = Array.from($("decidebtns").querySelectorAll("button"));
  const n = /^Digit([1-9])$/.exec(e.code)?.[1] ?? /^Numpad([1-9])$/.exec(e.code)?.[1];
  if (n && btns[Number(n) - 1]) {
    btns[Number(n) - 1].click();
    return true;
  }
  if (e.key === "Escape") {
    (btns.find((b) => /autopilot/i.test(b.textContent ?? "")) ?? btns.at(-1))?.click();
    return true;
  }
  return false;
}

/** Things to say once the picture reaches a voyage hour: the simulator runs ahead of it. */
const due: { h: number; fn: () => void }[] = [];
function whenAt(h: number, fn: () => void): void {
  h = Math.min(h, shownTo); // the track's last row can fall short of the status hour
  if (hour >= h - 1e-6) fn();
  else due.push({ h, fn });
}
function runDue(): void {
  for (let i = 0; i < due.length; ) {
    if (hour >= due[i].h - 1e-6) due.splice(i, 1)[0].fn();
    else i++;
  }
}

async function refreshForecast(): Promise<void> {
  if (page.status?.over) return;
  lastForecast = await game.forecast();
  drawForecast($<HTMLCanvasElement>("fc"), lastForecast, startMs);
}

/** A challenge's stars on the result card, with why, and what really happened. */
function drawStars(c: Card & { stars?: Stars; ghost_stars?: Stars }): void {
  const m = mission();
  const box = $("r-stars");
  box.hidden = !m || !c.stars;
  // A challenge: the stars tell its story (whether she came through, not who won), and it has its own day.
  const ch = !!m && !!c.stars;
  $("result").classList.toggle("mission", ch);
  $("again").textContent = ch ? "Try again" : "Play again";
  if (ch) $("r-story").textContent = "";
  if (!m || !c.stars) return;
  const t = starsText(c.stars, m.goal, c.ghost_stars);
  box.querySelector(".s-stars")!.textContent = t.stars;
  box.querySelector(".s-stars")!.setAttribute("aria-label", `${c.stars.stars} of 3 stars`);
  box.querySelector(".s-none")!.textContent = t.none;
  box.querySelector(".s-why")!.textContent = t.why;
  box.querySelector(".s-ghost")!.textContent = t.ghost;
  const real = box.querySelector<HTMLElement>(".s-real")!;
  real.hidden = !m.goal.debrief;
  if (m.goal.debrief) {
    real.querySelector(".s-text")!.textContent = m.goal.debrief.text;
    real.querySelector("a")!.href = m.goal.debrief.url;
  }
}

/** A watched voyage's ending: what became of her, the days and the distance, and her track. No race, so no verdict. */
async function watchFinish(): Promise<void> {
  const c = await game.result(); // the whole voyage is game.boat now
  clearTimeout(soundAskTimer);
  soundAsked = true;
  $("soundask").hidden = true;
  document.body.classList.remove("asking-sound");
  chartDirty = true;
  await new Promise((ok) => setTimeout(ok, 2000)); // a quiet beat on her last moment
  page.card = c;
  const r = game.boat!;
  const launched = new Date(utc(r.start)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  $("r-head").textContent = outcomeLine(r);
  $("r-story").textContent = `${page.watch?.name ?? "The boat"}, launched ${launched}, with the autopilot steering all the way.`;
  const radius = r.course.target_radius_m / 1000;
  const way = r.lat.length ? Math.max(kmTo([r.lat[0] as number, r.lon[0] as number], r.course.target) - radius, 0) : 0;
  const left = game.status?.boat.km_to_finish ?? way;
  $("r-nums").replaceChildren(
    ...numbers(c, r.outcome === "arrived" ? way : way - left, way, 0)
      .slice(0, 2) // days at sea, km of the way: there's no ghost to stand against
      .map((n) => {
        const d = document.createElement("div");
        d.className = "n";
        const b = document.createElement("b");
        b.textContent = n.value;
        if (n.unit) b.append(Object.assign(document.createElement("small"), { textContent: n.unit }));
        d.append(b, Object.assign(document.createElement("span"), { textContent: n.label }));
        return d;
      }),
  );
  $("r-calls").hidden = true;
  $("r-next").replaceChildren();
  drawResultMap();
  $("again").textContent = "Watch again";
  $("result").classList.add("watched");
  document.body.classList.add("results");
  $("result").hidden = false;
  sound.settle();
  $("again").focus({ preventScroll: true });
}

/** A race's ending: who finished first, in the boats' own names; each boat's days; both tracks. */
async function raceFinish(): Promise<void> {
  const c = (await game.result()) as Card & { race: RaceCard };
  clearTimeout(soundAskTimer);
  soundAsked = true;
  $("soundask").hidden = true;
  document.body.classList.remove("asking-sound");
  chartDirty = true;
  await new Promise((ok) => setTimeout(ok, 2000));
  page.card = c;
  const names = page.race?.names ?? [c.race.boats[0].name, c.race.boats[1].name];
  const win = c.race.winner;
  // The headline keeps the full names: a Randolph boat is always "(our model)" there (John, B2). The small labels under it are short.
  const short = (n: string) => n.replace(/\s*\(our model\)$/, "");
  const lost = (i: number) => OUTCOME[c.race.boats[i].outcome] ?? c.race.boats[i].outcome.replace(/_/g, " ");
  $("r-head").textContent =
    c.race.verdict === "draw"
      ? "A draw: both finished within a day of each other."
      : win === null
        ? "Neither boat finished."
        : c.race.margin_days !== null
          ? `${names[win]} finished first, ${Math.abs(c.race.margin_days).toFixed(1)} days ahead.`
          : `${names[win]} finished. ${names[1 - win]} ${lost(1 - win)}.`;
  const launched = new Date(utc(c.race.launch)).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  $("r-story").textContent = `${names[0]} against ${names[1]}, launched ${launched} into the same weather with the same luck. One race is one roll of the dice.`;
  $("r-nums").replaceChildren(
    ...c.race.boats.map((x, i) => {
      const d = document.createElement("div");
      d.className = "n";
      const b = document.createElement("b");
      b.textContent = x.days.toFixed(1);
      b.append(Object.assign(document.createElement("small"), { textContent: "days" }));
      d.append(b, Object.assign(document.createElement("span"), { textContent: `${short(names[i])}: ${x.outcome === "arrived" ? "finished" : lost(i)}` }));
      return d;
    }),
  );
  $("r-calls").hidden = true;
  $("r-next").replaceChildren();
  drawResultMap();
  $("again").textContent = "Race again";
  $("result").classList.add("watched");
  document.body.classList.add("results");
  $("result").hidden = false;
  sound.settle();
  $("again").focus({ preventScroll: true });
}

async function finish(): Promise<void> {
  if (WATCH) return watchFinish();
  if (RACE) return raceFinish();
  const c = await game.result();
  // The sound ask doesn't land on the results.
  clearTimeout(soundAskTimer);
  soundAsked = true;
  $("soundask").hidden = true;
  document.body.classList.remove("asking-sound");
  chartDirty = true;
  hud.orders(false);
  // Over the line off Lisbon: first the arrival itself, then the results (the finish scene, #329).
  // Any other ending gets a quiet beat on the boat's last moment before the card (Leo's plan).
  if (c.boat.outcome === "arrived" && finishesOffLisbon() && !shared) await arrivalScene(c);
  else if (!shared) await new Promise((ok) => setTimeout(ok, 2000));
  page.card = c;
  const me = c.boat;
  const gh = c.ghost;
  // Under the race rules a voyage starts at the western line, about 500 km out (Sam).
  const started = { me: !!game.boat?.t_start_line || me.outcome === "arrived", ghost: !!game.ghost?.t_start_line || gh.outcome === "arrived" };
  page.started = started;
  const mi = mission();
  // A challenge has its own goal: the headline says whether she met it (Sandy: still sailing or not).
  $("r-head").textContent = mi ? missionHead(me.outcome === "goal" || me.outcome === "arrived", mi.goal) : headline(c, started);
  $("r-story").textContent = story(c, started);
  // The three big numbers: days at sea, km of the way covered, and against the ghost.
  const st = game.status;
  const rep = game.boat;
  const target = (rep?.course.target ?? [39.5, -13.5]) as [number, number];
  const radius = (rep?.course.target_radius_m ?? 25000) / 1000;
  const way = rep && rep.lat.length ? Math.max(kmTo([rep.lat[0] as number, rep.lon[0] as number], target) - radius, 0) : 0;
  const left = st ? st.boat.km_to_finish : way;
  const lead = st ? st.lead_km : 0;
  const nums = $("r-nums");
  nums.replaceChildren(
    // A challenge (Ines): the crossing's length means nothing, and the ghost line in the stars already
    // tells the ghost's story, so just the days and the km sailed.
    ...numbers(c, me.outcome === "arrived" ? way : way - left, way, lead)
      .filter((n, i) => !mi || i < 2)
      .map((n) => (mi && n.unit === "km" ? { value: n.value, unit: "", label: "km sailed" } : n))
      .map((n) => {
      const d = document.createElement("div");
      d.className = "n";
      const b = document.createElement("b");
      b.textContent = n.value;
      if (n.unit) {
        const u = document.createElement("small");
        u.textContent = n.unit;
        b.append(u);
      }
      const l = document.createElement("span");
      l.textContent = n.label;
      d.append(b, l);
      return d;
    }),
  );
  // Your calls (hands on only: from base, orders go by satellite and aren't calls).
  $("r-calls").hidden = mode !== "hands_on" || !!shared;
  $("r-calllist").replaceChildren(
    ...callLines(calls, lead).map((t) => {
      const li = document.createElement("li");
      li.textContent = t;
      return li;
    }),
  );
  drawResultMap();
  drawStars(c as Card & { stars?: Stars; ghost_stars?: Stars });
  $("r-trim").textContent = trimLine(c);
  const trouble: Record<string, string> = { capsize: "knocked flat by a wave", part_failed: "a part broke", ship_strike: "hit by a ship" };
  const line = (who: string, x: Card["boat"]) => {
    const tr = document.createElement("tr");
    const th = document.createElement("th");
    th.textContent = who;
    tr.append(th);
    const cells = [
      OUTCOME[x.outcome] ?? x.outcome,
      `${x.days.toFixed(1)} days`,
      `${Math.round(x.battery_low * 100)}%`,
      x.breakdowns.length ? x.breakdowns.map((b) => trouble[b] ?? b.replace(/_/g, " ")).join("; ") : "none",
      airtimeText(x.airtime),
    ];
    for (const c of cells) {
      const td = document.createElement("td");
      td.textContent = c;
      tr.append(td);
    }
    return tr;
  };
  const table = $("r-table");
  table.innerHTML = "<tr><th></th><th>Outcome</th><th>Time</th><th>Battery low point</th><th>Trouble</th><th>Satellite messages</th></tr>";
  table.append(line("You", me), line("Autopilot ghost", gh));
  // How it ends, in the boat's own words (#234). textContent only: the words come from the simulator.
  const ends = $("r-ends");
  ends.replaceChildren();
  for (const [who, x] of [["You", me], ["Autopilot ghost", gh]] as const) {
    const e = x.ending;
    if (!e) continue;
    const row = document.createElement("div");
    row.className = "end";
    const w = document.createElement("span");
    w.className = "who";
    w.textContent = who;
    const h = document.createElement("span");
    h.className = "head";
    h.textContent = x.outcome === "goal" ? "Still sailing" : e.headline;
    const t = document.createElement("span");
    t.className = "words";
    const when = e.day != null && x.outcome !== "arrived" ? `day ${e.day.toFixed(1)}` : "";
    // Running aground names only the spot ("38.62N 27.91W"): say what happened there.
    const words = /^\d+(\.\d+)?[NS]\s/.test(e.words) ? `came ashore at ${e.words}` : e.words;
    t.textContent = x.outcome === "goal" ? "at the challenge's deadline" : [words, e.where, when].filter(Boolean).join(", ");
    row.append(w, h, t);
    ends.append(row);
  }
  const bits: string[] = [];
  if (c.margin_days !== null) bits.push(c.margin_days > 0 ? `You finished ${c.margin_days.toFixed(1)} days ahead.` : `The ghost finished ${(-c.margin_days).toFixed(1)} days ahead.`);
  if (c.breakdowns_differ) bits.push("Note: different things broke on the two boats, so luck played a part.");
  const air = me.airtime;
  if (air)
    bits.push(
      `Satellite link: ${air.up.messages} reports sent and ${air.down.messages} orders received, ${(air.up.bytes + air.down.bytes).toLocaleString("en-US")} bytes in all. The backup beacon sent ${air.beacon_pings} positions on its own.`,
    );
  const ch = challenges.find((x) => x.id === page.challenge);
  // Plain words (Milo): "1 order given", "Launched 1 May 2020, with breakdowns on."
  const launched = new Date(`${c.launch.slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  const brk = c.breakdowns_on ? "with breakdowns on" : "with breakdowns off";
  bits.push(`${c.orders.length} order${c.orders.length === 1 ? "" : "s"} given. ${ch ? `Challenge: ${ch.title}, launched` : "Launched"} ${launched}, ${brk}.`);
  // Over the line off Lisbon: the scene moves on to the coast it points at (the line itself is far out at sea).
  if (me.outcome === "arrived" && finishesOffLisbon()) {
    showArrival();
    bits.push("Behind this card: the arrival, off Cascais near Lisbon, with Cabo da Roca and the Sintra hills to the north-west. The finish line itself is about 330 km out to sea, too far to see land from.");
  }
  // #335: the browser sails on a lighter weather file than the full runs behind the voyage replays.
  $("r-caveat").textContent = "Sailed in your browser on lighter weather data, so on a long voyage it can differ by days from the full-data voyage replays.";
  $("r-notes").textContent = bits.join(" ");
  const mine = loadMyBoat();
  if (mine) $<HTMLAnchorElement>("r-boat").href = `./${myBoatYardLink(mine)}`;
  $<HTMLAnchorElement>("r-board").href = `./leaderboard.html#${encodeURIComponent(c.build)}`;
  document.body.classList.add("results");
  $("result").hidden = false;
  sound.settle(); // a soft knock, and the sea drops to half under the card
  $("again").focus({ preventScroll: true });
  void showStanding(c.build);
}

/** Results, "where this leaves you" (one-game plan step 3): the build's place on
 *  the design leaderboard, or the Boatyard's odds for it, and the ways on. Fills
 *  in after the card shows, so a slow or missing file never holds the card up. */
async function showStanding(build: string): Promise<void> {
  const box = $("r-next");
  box.replaceChildren();
  const [board, grid] = await Promise.all([maybeJson<Board>("./leaderboard/board.json"), maybeJson<Grid>("./boatyard/index.json")]);
  if (page.card?.build !== build) return; // a newer game has finished since
  const s = standing(build, board, grid);
  const rate = s.kind === "board" ? s.row.finish_rate : s.kind === "odds" ? (s.build.odds?.odds ?? null) : null;
  const mine = loadMyBoat();
  const name = !mine || !mine.base || mine.base === "kayak" ? "Our kayak" : "This build";
  const p = document.createElement("p");
  p.className = "standing";
  p.textContent = leaves(page.card, rate, name, page.started.me);
  // Not in a challenge (Ines): the odds read as a scolding there, and they belong in the Boatyard.
  if (!mission()) box.append(p);
  const t = standingText(s);
  $("r-standing").textContent = `${t.head} ${t.detail}`;
  page.standing = s.kind;
}

/** F3: the goal, on screen from second one (Leo's first five minutes, Elena). The ghost has no hull of
 * its own on the sea (it's a tag on the horizon once apart), so the words say "from the same start" (Leo). Eight seconds over
 * the opening view, in the clear sky at the top left; a click or a key lets it go early. */
const GOAL_MS = 8000;
function goalCard(km: number): Promise<void> {
  const card = $("goalcard");
  $("goalkm").textContent = `${Math.round(km).toLocaleString("en-US")} km.`;
  card.hidden = false;
  document.body.classList.add("goal");
  judging = qstat.source === "auto" && !qstat.stepped;
  requestAnimationFrame(() => card.classList.add("in"));
  page.scene = "goal";
  return new Promise((done) => {
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      removeEventListener("keydown", end);
      removeEventListener("pointerdown", end);
      card.classList.remove("in");
      document.body.classList.remove("goal");
      page.scene = "";
      setTimeout(() => (card.hidden = true), 800);
      done();
    };
    // ?hold=goal keeps it up, for frames on slow software graphics.
    const timer = params.get("hold") === "goal" ? 0 : setTimeout(end, GOAL_MS);
    addEventListener("keydown", end);
    addEventListener("pointerdown", end);
  });
}

/** The card's small map: both whole tracks, drawn once on the chart's land. */
function drawResultMap(): void {
  const cv = $<HTMLCanvasElement>("r-map");
  if (!chartBounds || !game.boat || !(game.ghost || WATCH)) {
    cv.hidden = true;
    return;
  }
  const m = new Chart(cv, landImg, chartBounds);
  const both = game.ghost ? [game.boat, game.ghost] : [game.boat]; // a watched voyage is one track
  m.setLanes(game.ghost ? [{ rep: game.boat, colours: TRACK.kayak }, { rep: game.ghost, colours: GHOST }] : [{ rep: game.boat, colours: TRACK.kayak }]);
  // Framed on what was sailed (Ines): both tracks with a margin, at the map's own shape, so a short
  // voyage isn't a stub in the corner. The finish, when it's off the frame, is an arrow at the edge.
  const pts: [number, number][] = [];
  for (const r of both)
    for (let i = 0; i < r.lat.length; i++) if (r.lat[i] != null && r.lon[i] != null) pts.push([r.lat[i] as number, r.lon[i] as number]);
  const target = game.boat.course.target as [number, number];
  const COS40 = Math.cos((40 * Math.PI) / 180);
  let [la0, la1, lo0, lo1] = [Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))];
  const whole = lo1 - lo0 > 40;
  if (!whole && pts.length) {
    // At least 8 degrees of longitude, and the canvas's 16:10 shape.
    const cx = (lo0 + lo1) / 2;
    const cy = (la0 + la1) / 2;
    let wLon = Math.max(8, (lo1 - lo0) * 1.5);
    let hLat = Math.max((la1 - la0) * 1.5, (wLon * COS40 * 10) / 16);
    wLon = Math.max(wLon, (hLat * 16) / 10 / COS40);
    hLat = (wLon * COS40 * 10) / 16;
    [la0, la1, lo0, lo1] = [cy - hLat / 2, cy + hLat / 2, cx - wLon / 2, cx + wLon / 2];
    m.setView({ lonMin: lo0, lonMax: lo1, latMin: la0, latMax: la1 });
  }
  // Drawn after the card lays out, so the canvas has its size.
  requestAnimationFrame(() => {
    m.draw(1e9, performance.now());
    if (whole || !pts.length) return;
    const g = cv.getContext("2d")!;
    const dpr = cv.width / Math.max(1, cv.getBoundingClientRect().width);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = cv.width / dpr;
    const H = cv.height / dpr;
    const [ex, ey] = m.xy(...(lastFix(game.boat!) ?? pts[0]));
    // Where it ended, named (Ines): "Went silent", "Caught in fishing gear"...
    const end = page.card?.boat;
    if (end && end.outcome !== "arrived" && end.ending?.headline) {
      g.font = "600 11px system-ui, sans-serif";
      g.textAlign = ex > W * 0.6 ? "right" : "left";
      g.fillStyle = "rgba(255,200,150,.95)";
      // A challenge met reads "Still sailing", as the headline does (Ines: one story, not "Made it").
      const word = mission() && end.outcome === "goal" ? "Still sailing" : end.ending.headline;
      const [lx, ly] = [ex + (ex > W * 0.6 ? -10 : 10), ey < 24 ? ey + 18 : ey - 10];
      // A dark halo, so a track line under the label never runs through the words (Ines).
      g.strokeStyle = "rgba(8,18,32,.9)";
      g.lineWidth = 3;
      g.lineJoin = "round";
      g.strokeText(word, lx, ly);
      g.fillText(word, lx, ly);
    }
    const [fx, fy] = m.xy(target[0], target[1]);
    if (fx >= 0 && fx <= W && fy >= 0 && fy <= H) return;
    // The finish, off the frame: in the top-right corner, "4,728 km to the finish ▶", the arrow
    // pointing its way, clear of the end marker (Ines, Leo).
    const ang = Math.atan2(fy - ey, fx - ex);
    const ax = W - 12;
    const ay = 14;
    g.save();
    g.translate(ax, ay);
    g.rotate(ang);
    g.fillStyle = "rgba(255,255,255,.9)";
    g.beginPath();
    g.moveTo(6, 0);
    g.lineTo(-4, -5);
    g.lineTo(-4, 5);
    g.closePath();
    g.fill();
    g.restore();
    g.font = "600 11px system-ui, sans-serif";
    g.textAlign = "right";
    g.textBaseline = "middle";
    g.fillStyle = "rgba(235,242,250,.92)";
    const left = Math.round(game.status?.boat.km_to_finish ?? 0).toLocaleString("en-US");
    g.fillText(`${left} km to the finish`, ax - 10, ay);
    // The race's start line runs through the frame without its words on a small map: name it.
    const west = game.boat!.course.west_line as [number, number][];
    const seen: [number, number][] = [];
    for (let k = 0; k + 1 < west.length; k++)
      for (let f = 0; f <= 1; f += 0.05) {
        const [x, y] = m.xy(west[k][0] + (west[k + 1][0] - west[k][0]) * f, west[k][1] + (west[k + 1][1] - west[k][1]) * f);
        if (x > 70 && x < W - 4 && y > 34 && y < H - 8) seen.push([x, y]);
      }
    if (seen.length) {
      // Halfway along the part in view, the words to its left so they never run off the edge.
      const [x, y] = seen[Math.floor(seen.length / 2)];
      g.textAlign = "right";
      g.textBaseline = "middle";
      g.font = "600 10px system-ui, sans-serif";
      g.fillStyle = "rgba(255,255,255,.7)";
      g.fillText("start line", x - 6, y);
    }
  });
}

/** The last position a replay has, for the results map. */
function lastFix(r: Replay): [number, number] | null {
  for (let i = r.lat.length - 1; i >= 0; i--) if (r.lat[i] != null && r.lon[i] != null) return [r.lat[i] as number, r.lon[i] as number];
  return null;
}

/** True when this game's finish is the usual one, the race's line west of Lisbon (39.5N 13.5W). */
function showArrival(): void {
  const L = PLACES.lisbon;
  if (!arrival) aimAt(L.look);
  arrival = [L.lat, L.lon];
  page.arrival = true;
}

/** The finish scene: the view cuts to the coast the finish points at, the camera
 *  swings slowly round the boat, and a banner says so. The results follow after a
 *  few seconds, or at once on a click or key. */
async function arrivalScene(c: Card): Promise<void> {
  showArrival();
  page.scene = "arrival";
  const ahead = c.margin_days !== null && c.margin_days > 0;
  $("arrivehead").textContent = `You made it, after ${c.boat.days.toFixed(1)} days at sea${ahead ? `, ${c.margin_days!.toFixed(1)} days ahead of the ghost` : ""}!`;
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  controls.autoRotate = !still;
  controls.autoRotateSpeed = 0.5;
  const banner = $("arrive");
  banner.hidden = false;
  document.body.classList.add("arriving"); // the panels step aside for the view
  await new Promise<void>((done) => {
    const end = () => {
      clearTimeout(timer);
      removeEventListener("keydown", end);
      $("arrivego").removeEventListener("click", end);
      done();
    };
    const timer = setTimeout(end, 8000);
    addEventListener("keydown", end);
    $("arrivego").addEventListener("click", end);
  });
  banner.hidden = true;
  document.body.classList.remove("arriving");
  controls.autoRotate = false;
  page.scene = "";
}

function finishesOffLisbon(): boolean {
  const t = (game.boat?.course.target ?? [39.5, -13.5]) as [number, number];
  return kmTo(t, [39.5, -13.5]) < 100;
}

// ---------- start ----------
/** Fill the challenge picker once challenges.json has loaded (hidden without it). */
function showChallenges(): void {
  if (!challenges.length) return;
  const sel = $<HTMLSelectElement>("challenge");
  for (const c of challenges) {
    const o = document.createElement("option");
    o.value = c.id;
    o.textContent = `${c.n ? `${c.n}.` : "Bonus:"} ${c.title} (${startLabel(c)})`;
    sel.append(o);
  }
  $("chpick").hidden = !!shared;
  // "Sail this sea" on the Sea page asks for the weather that matches its sea (?challenge=).
  const asked = askedChallenge(location.search, challenges.map((c) => c.id), !!shared);
  if (asked) sel.value = asked;
  page.asked = asked ?? "";
  showChallenge();
}

/** The chosen challenge's story replaces the launch day. */
function showChallenge(): void {
  const c = chosenChallenge();
  $<HTMLSelectElement>("launch").disabled = !!c || !!shared;
  $("chstory").hidden = !c;
  // A storm challenge's briefing has its own honesty note, so the shorter one would say it twice.
  $("chnote").hidden = !c?.weather_note || !!c?.goal?.storm;
  $("chover").hidden = !c;
  if (!c) return;
  $("chstory").textContent = `${c.story} The drop is at noon UTC on ${startLabel(c)}.`;
  // A challenge with a goal: the goal and the stars, in a few short lines, then the honesty note.
  const brief = $("chbrief");
  brief.hidden = !c.goal;
  if (c.goal) {
    const b = briefing(c.goal, c.start);
    $("chstory").textContent = `${startLabel(c)}. ${b.lines.join(" ")}`;
    const ul = brief.querySelector("ul")!;
    ul.replaceChildren(
      ...b.stars.map((t) => {
        const li = document.createElement("li");
        li.textContent = t;
        return li;
      }),
    );
    brief.querySelector(".honest")!.textContent = c.goal.storm ? HONEST : "";
  }
  // Storm boost (#117) is ignored for now: storms sail on plain ERA5, so say so.
  $("chnote").textContent = c.weather_note;
}
async function begin(): Promise<void> {
  foresee = null;
  arrival = null;
  page.arrival = false;
  // An index into the six odds launches, or a day: the default is 23 Apr 2020, a good
  // day (Hs 0.9 m, 12 kt from the SW, Sam's pick); 1 Apr, the tail of a gale, is "Rough start".
  const lv = $<HTMLSelectElement>("launch").value;
  const launch: number | string = /^\d+$/.test(lv) ? Number(lv) : lv;
  const safe = $<HTMLInputElement>("safe").checked;
  const breakdowns = $<HTMLInputElement>("breakdowns").checked;
  mode = (document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value as Mode) ?? "hands_on";
  // Hands on starts on the ghost's autopilot (#327); "auto" is a hands-on
  // order, so base keeps its old first draft, straight at the finish.
  order = mode === "base" ? "finish" : "auto";
  if (!WATCH && !(await sandboxThere(sandboxBase))) {
    page.error = "no simulator files";
    $("startmsg").textContent = "The simulator files aren't published on this copy of the site yet, so there's nothing to sail. Try the live site.";
    // A race link went straight to the sea: bring the card back so the message shows.
    $("loading").hidden = true;
    $("start").hidden = false;
    return;
  }
  await challengesReady;
  const ch = SPECTATE ? undefined : chosenChallenge();
  if (shared && params.get("c") && !ch) {
    page.error = "no challenge files";
    $("startmsg").textContent = "That link is for a weather challenge whose weather isn't on this copy of the site. Try the live site.";
    return;
  }
  page.challenge = ch?.id ?? "";
  page.startPort = shared ? "" : $<HTMLSelectElement>("port").value;
  const hb = handBoat();
  if (!shared && !SPECTATE && hb && !$("prologuepick").hidden && $<HTMLInputElement>("prologue").checked) await runPrologue(hb);
  $("start").hidden = true;
  $("loading").hidden = false;
  setBusy(true, WATCH ? "Loading the voyage..." : RACE ? "Getting both boats ready..." : "Loading the simulator (about 30 MB the first time)...");
  if (!SPECTATE && !ONE_CLICK && !/%/.test($("loadtext").textContent ?? "")) $("loadtext").textContent = "Loading the simulator (about 30 MB the first time)...";
  try {
    if (shared) {
      const v = await game.load(shared, ch && bundleUrl(ch, challengesBase));
      useBoat(game.boatBase);
      page.status = v.status;
      mode = v.status.mode ?? "hands_on";
      const o = v.orders.at(-1);
      if (o) [order, power] = [o.heading, o.power];
      else order = mode === "base" ? "finish" : "auto";
      sailOrder = v.status.order.sails ?? null;
      engineOrder = v.status.order.engine ?? null;
    } else if (SPECTATE) {
      // A recorded voyage (its file is the game) or a race (the source knows its boats and launch).
      // No order goes: the autopilots sail.
      page.status = await game.start(0, false, false);
      useBoat(game.boatBase);
      mode = "hands_on";
      if (page.race) {
        // The lead cell is against boat B, by name (a Randolph boat is "our model", B2).
        const cell = $("c-lead");
        cell.title = `${page.race.names[0]} against ${page.race.names[1]}`;
        cell.querySelector(".l")!.textContent = "lead";
      }
    } else {
      const pick = chosenBoat();
      const mine = loadMyBoat();
      const boat = pick === MINE && mine ? mine.choices : pick || undefined;
      page.status = await game.start(launch, safe, breakdowns, mode, ch && { id: ch.id, bundle: bundleUrl(ch, challengesBase) }, boat, page.startPort);
      useBoat(game.boatBase);
      rememberBoat(pick, mine);
      if (mode !== (page.status.mode ?? "hands_on")) {
        mode = "hands_on";
        note("This copy of the simulator only has the hands-on helm, so that's what you've got.", "Day 0", TONE_COLOUR.warn);
      }
      // Hands on: the first order goes at once. From base, the boat sails the launch route until base sends one.
      if (mode === "hands_on") await game.order(order, power, sailOrder, engineOrder);
      else draft = true; // ready to send
      page.status = game.status;
    }
    startMs = utc(game.boat!.start);
    page.ready = true;
    sailedAt = performance.now();
    shownTo = shared ? lastHour(game.boat!) : 0;
    hour = shownTo;
    lastCallH = shared ? hour : -Infinity; // a shared game's quiet spell starts where it was left
    resetPois();
    present();
    newEvents();
    await refreshForecast();
    chart?.setLanes(game.ghost ? [{ rep: game.boat!, colours: TRACK.kayak }, { rep: game.ghost, colours: GHOST }] : [{ rep: game.boat!, colours: TRACK.kayak }]);
    chartDirty = true;
    document.body.classList.toggle("watching", WATCH);
    document.body.classList.toggle("racing", RACE);
    const d = `Day ${page.status!.day.toFixed(1)}`;
    if (shared) note(`A shared game, back where it was left on day ${page.status!.day.toFixed(1)}. The helm is yours.`, d, TONE_COLOUR.info);
    else if (mode === "base")
      note("You're at the base station. Pick a heading and a power and send it: it reaches the boat at its next check-in. Until then the boat follows the launch route.", d, TONE_COLOUR.info);
    // The game's hints are one coach line in the orders drawer, open for the first seconds (Leo's plan).
    if (page.status?.over) await finish();
    // Time runs from the start, at the speed a hop used to play at. A shared game opens
    // paused where it was left; ?clock=paused starts paused (for tests).
    forecastAt = page.status!.day * 24;
    document.body.classList.add("sailing");
    const coach = shared || SPECTATE ? null : mode === "base" ? "Pick a heading and power, then send it: it reaches the boat at its next check-in." : "The autopilot is steering, just like the ghost's. To get ahead, you'll have to make better calls than it does. The first one is coming.";
    $("loading").hidden = true;
    if (shared || params.get("clock") === "paused" || page.status?.over) setRate(0);
    // A watched voyage opens already playing in real time (John, T2); the speed bar is right there.
    else if (WATCH) setRate(REAL_TIME);
    // A race opens paused, as the race page does today (Maya, 13 Nov: not on John's list, so unchanged
    // until he rules); Real time is first on the bar (T1).
    else if (RACE) setRate(0);
    else {
      // The first hours at an hour a second, so the first thing a player sees is the morning of the drop.
      setRate(1);
      lastRate = DEFAULT_RATE; // a pause then carries on at the usual speed
      easeUpAt = hour + FIRST_HOURS;
    }
    // One thing to read at a time (Leo): the goal card first, then the drawer with its coach line
    // and the key hint; the sound ask a minute in.
    const opening = () => {
      hud.sailing(coach);
      $("keyhint").hidden = false;
      setTimeout(hideKeyHint, 60_000);
    };
    if (!shared && !SPECTATE && mode === "hands_on" && !chosenChallenge() && finishesOffLisbon() && !page.status?.over) {
      hud.sailing(null); // the bar steps away; the drawer waits for the card
      void goalCard(page.status!.boat.km_to_finish).then(opening);
    } else opening();
    askSoundLater();
  } catch (e) {
    $("loading").hidden = true;
    const err = String(e);
    if (/NO_PORTS/.test(err)) {
      page.error = "no ports in the simulator";
      setBusy(false);
      $("startmsg").textContent = "The simulator published on this site can't start from a port yet; it's being updated. Start from our usual drop for now.";
    } else if (/BAD_PORT/.test(err)) {
      page.error = "port not sailable here";
      setBusy(false);
      $("startmsg").textContent = `${err.replace(/^.*BAD_PORT\s*/, "").replace(/^./, (c) => c.toUpperCase())}. Pick another port, or start from our usual drop.`;
    } else if (/NO_CHALLENGES/.test(err)) {
      page.error = "no challenges in the simulator";
      setBusy(false);
      $("startmsg").textContent = "The simulator published on this site doesn't know the weather challenges yet; it's being updated. Pick a 2020 launch for now.";
    } else if (/NO_BOAT/.test(err)) {
      page.error = "no such boat in the simulator";
      setBusy(false);
      $("startmsg").textContent = "The simulator published on this site doesn't have that boat yet; it's being updated. Pick our kayak for now.";
    } else if (/NO_HELM/.test(err)) {
      page.error = "no helm in the simulator";
      setBusy(false);
      $("startmsg").textContent = "The simulator published on this site doesn't have the helm game yet; it's being updated. Try again later.";
    } else if (/BAD_CODE/.test(err)) {
      page.error = "bad share link";
      setBusy(false);
      $("startmsg").textContent = `That share link didn't open: ${err.replace(/^.*BAD_CODE\s*/, "")}. Start a new game instead.`;
      history.replaceState(null, "", location.pathname);
    } else if (/NO_RACE/.test(err)) {
      page.error = "no race in the simulator";
      setBusy(false);
      $("startmsg").textContent = "The simulator published on this site can't run a race on this screen yet; it's being updated. You can set sail yourself instead.";
    } else if (WATCH) {
      page.error = "no such voyage";
      setBusy(false);
      $("startmsg").textContent = `That voyage didn't open (${e instanceof Error ? e.message : String(e)}). You can set sail yourself instead.`;
    } else {
      fail(e);
      $("startmsg").textContent = `The simulator couldn't start: ${e instanceof Error ? e.message : String(e)}`;
    }
    $("start").hidden = false;
    return;
  }
  setBusy(false);
  showOrder();
}

const GHOST = { main: "#c8d4e6", beacon: "#e0e8f4", glow: "rgba(200,212,230,0.7)" };

for (const [id, h] of [["b-auto", "auto"], ["b-finish", "finish"], ["b-route", "route"]] as const) $(id).addEventListener("click", () => void setOrder(h));
$<HTMLInputElement>("power").addEventListener("input", (e) => {
  power = Number((e.target as HTMLInputElement).value) / 100;
  showOrder();
});
$<HTMLInputElement>("power").addEventListener("change", () => void setOrder(order, power));
$("s6").addEventListener("click", () => void sail("6h"));
$("sday").addEventListener("click", () => void sail("day"));
$("nl-end").addEventListener("click", () => void sail("end"));
// A tap on a locked control says why (Leo). Inert controls don't get the click; their drawer does.
$("orders").addEventListener("click", (ev) => {
  if (!linkCut || ev.target !== $("orders")) return;
  const hit = LOCKED_IDS.some((id) => {
    const el = document.getElementById(id);
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
  });
  if (hit) note("No link: she can't hear you.", `Day ${(page.status?.day ?? 0).toFixed(1)}`, TONE_COLOUR.warn);
});
$("sevent").addEventListener("click", () => void sail("event"));
$("go").addEventListener("click", () => void begin());
// F1 (Leo's first five minutes, Elena): the title's Set sail, helm.html?sail, goes straight to the sea
// on the defaults (our kayak, or my boat; the good-weather launch day; the usual drop), no start card.
// Any trouble starting brings the start card back with its message.
if (ONE_CLICK) {
  document.body.classList.add("oneclick");
  $("start").hidden = true;
  $("loadtext").textContent = "Getting the weather ready…";
  $("loading").hidden = false;
  void challengesReady.finally(() => void begin());
}
$("send").addEventListener("click", () => void sendOrder());
$("share").addEventListener("click", () => void shareLink());
// The boats you can sail: our kayak, and the stock boats Maya cleared for play.
const BOAT_BLURB: Partial<Record<string, string>> = {
  stock_cruiser31: "a 9.5 m sailing yacht with a keel and a small diesel engine for calms. The sails trim and reef themselves; you steer and say how hard the engine works.",
  stock_pearson31_2:
    "the Randolph team's own 9.4 m yacht, as we've modelled it from the builder's numbers: heavier and steadier than the cruiser, with a deep keel and a diesel. The sails trim and reef themselves; you steer and say how hard the engine works.",
};
for (const k of PLAYABLE_STOCK) {
  const label = document.createElement("label");
  const input = document.createElement("input");
  input.type = "radio";
  input.name = "boat";
  input.value = k;
  const b = document.createElement("b");
  b.textContent = STOCK[k].name.replace(/^\w/, (c) => c.toUpperCase());
  label.append(input, " ", b, `: ${BOAT_BLURB[k] ?? "a ready-made boat, sailed as it comes."}`);
  $("boats").append(label);
}
// "My boat" (saved in the Boatyard, or the boat sailed here last): it's ticked to start with. A Boatyard
// design gets its own row; the planned kayak or a stock boat ticks the row that's already there.
const MINE = "mine";
const startMine = shared ? null : loadMyBoat();
const isPlannedKayak = (b: MyBoat) => b.kind === "yard" && b.base === "kayak" && b.hash === "";
const rowFor = (b: MyBoat) => (isPlannedKayak(b) ? "" : b.kind === "stock" ? b.base : MINE);
const boatRow = (v: string) => document.querySelector<HTMLInputElement>(`input[name="boat"][value="${CSS.escape(v)}"]`);
if (startMine) {
  // A stock boat this page doesn't list gets its own row too.
  const v = boatRow(rowFor(startMine)) ? rowFor(startMine) : MINE;
  if (v === MINE) {
    const label = document.createElement("label");
    const input = Object.assign(document.createElement("input"), { type: "radio", name: "boat", value: MINE });
    // The name is the player's own text: textContent only.
    const b = Object.assign(document.createElement("b"), { textContent: startMine.name });
    label.append(input, " ", b, startMine.kind === "yard" ? ": your boat from the Boatyard." : ": your boat.");
    $("boats").querySelector("legend")!.after(label);
  }
  boatRow(v)!.checked = true;
}
/** The boat picked on the start card: "" for our kayak, "mine" for the saved Boatyard design, else a stock id. */
function chosenBoat(): string {
  return document.querySelector<HTMLInputElement>('input[name="boat"]:checked')?.value ?? "";
}
/** Start each boat at its autopilot's own power: 25% for the kayak and Boatyard designs, 70% engine for a yacht. */
function powerFor(pick: string): void {
  power = isStock(pick === MINE ? String(startMine?.choices.base ?? "") : pick) ? 0.7 : 0.25;
  $<HTMLInputElement>("power").value = String(Math.round(power * 100));
}
/** The boat a new game sails becomes "my boat" (unless it already is), so the other pages carry it on. */
function rememberBoat(pick: string, mine: MyBoat | null): void {
  if (pick === MINE || (mine && rowFor(mine) === pick)) return;
  if (isStock(pick)) saveMyBoat({ kind: "stock", base: pick, hash: "", name: STOCK[pick].name.replace(/^\w/, (c) => c.toUpperCase()), choices: { base: pick } });
  else saveMyBoat({ kind: "yard", base: "kayak", hash: "", name: "Our kayak", choices: {} });
}
powerFor(chosenBoat());
for (const r of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="boat"]'))) r.addEventListener("change", () => powerFor(r.value));
$("boats").addEventListener("change", () => showProloguePick());

// Base mode turns the boat's own battery guard on by default, as the simulator does.
for (const r of Array.from(document.querySelectorAll<HTMLInputElement>('input[name="mode"]')))
  r.addEventListener("change", () => ($<HTMLInputElement>("safe").checked = r.value === "base" && r.checked));
if (shared) {
  $("modes").hidden = true;
  $("boats").hidden = true; // the shared game says which boat
  for (const id of ["launch", "breakdowns", "safe"]) $<HTMLInputElement>(id).disabled = true;
  $("sharedmsg").hidden = false;
  $("sharedmsg").textContent = "Someone shared this game with you: it opens where they left it, with the same weather and luck.";
  $("go").textContent = "Carry on from where they left it";
}
// Play again: same boat, same day, same settings (you know what's coming). Another launch day:
// the same, with the start card open on the launch picker. Kept for one reload in this tab only.
const AGAIN_KEY = "boatsim.helm.again";
function again(sameDay: boolean): void {
  const val = (id: string) => $<HTMLInputElement | HTMLSelectElement>(id).value;
  const chk = (id: string) => $<HTMLInputElement>(id).checked;
  try {
    sessionStorage.setItem(
      AGAIN_KEY,
      JSON.stringify({ launch: sameDay ? val("launch") : null, mode, safe: chk("safe"), breakdowns: chk("breakdowns"), port: val("port"), challenge: val("challenge"), pickDay: !sameDay }),
    );
  } catch {
    /* private mode: a plain reload */
  }
  // Another day means the start card: drop the title's one-click ?sail.
  if (!sameDay && params.has("sail")) {
    const u = new URL(location.href);
    u.searchParams.delete("sail");
    location.replace(u.href);
  } else location.reload();
}
$("again").addEventListener("click", () => again(true));
$("r-day").addEventListener("click", () => again(false));
$("r-info").addEventListener("click", () => {
  const t = $("r-caveat");
  t.hidden = !t.hidden;
  $("r-info").setAttribute("aria-expanded", String(!t.hidden));
});
{
  let a: { launch: string | null; mode: Mode; safe: boolean; breakdowns: boolean; port: string; challenge: string; pickDay: boolean } | null = null;
  try {
    a = JSON.parse(sessionStorage.getItem(AGAIN_KEY) ?? "null");
    sessionStorage.removeItem(AGAIN_KEY);
  } catch {
    a = null;
  }
  if (a && !shared) {
    const sel = $<HTMLSelectElement>("launch");
    if (a.launch !== null && Array.from(sel.options).some((o) => o.value === a!.launch)) sel.value = a.launch;
    $<HTMLInputElement>("safe").checked = a.safe;
    $<HTMLInputElement>("breakdowns").checked = a.breakdowns;
    const m = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${CSS.escape(a.mode)}"]`);
    if (m) m.checked = true;
    // The port and challenge pickers fill from files: set them once they're there.
    const later = (id: string, v: string, tries = 40) => {
      const e = $<HTMLSelectElement>(id);
      if (Array.from(e.options).some((o) => o.value === v)) {
        e.value = v;
        e.dispatchEvent(new Event("change"));
      } else if (v && tries > 0) setTimeout(() => later(id, v, tries - 1), 250);
    };
    later("port", a.port);
    later("challenge", a.challenge);
    if (a.pickDay) requestAnimationFrame(() => sel.focus());
  }
}
$<HTMLSelectElement>("challenge").addEventListener("change", () => showChallenge());
for (const w of ["boat", "ghost"] as const)
  $(`w-${w}`).addEventListener("click", () => {
    watch = w;
    $("w-boat").setAttribute("aria-pressed", String(w === "boat"));
    $("w-ghost").setAttribute("aria-pressed", String(w === "ghost"));
    chartDirty = true;
  });
showOrder();
compass.draw();

const landImg = new Image();
/** The land mask, for a call card's map, once loaded. */
let chartLand: LandMask | null = null;
let chartBounds: LandBounds | null = null;
(async () => {
  const [bounds] = await Promise.all([
    fetch("./land.json").then((r) => r.json() as Promise<LandBounds>),
    new Promise<void>((ok, bad) => {
      landImg.onload = () => ok();
      landImg.onerror = () => bad(new Error("land.png"));
      landImg.src = "./land.png";
    }),
  ]);
  chart = new Chart($<HTMLCanvasElement>("chart"), landImg, bounds);
  chartLand = { img: landImg, bounds };
  chart.toFinish = true;
  chartBounds = bounds;
  chart.setWrecks(wreckMarks());
})().catch((e) => console.warn("chart:", e));

/**
 * Base mode: the chart's own boat is what base knows. The reports that reached it
 * (a track) and a faint dashed leg out to its estimate of where the boat is now.
 */
function knownLanes(): { rep: Replay; colours: { main: string; beacon: string; glow: string } }[] | null {
  const st = page.status;
  const r = game.boat;
  const reps = st?.base?.reports;
  if (!r || !st || !reps?.length) return null;
  const t0 = utc(r.start);
  const lane = (pts: { t: string; lat: number; lon: number }[]): Replay => ({
    ...r,
    h: pts.map((p) => (utc(p.t) - t0) / 3600e3),
    lat: pts.map((p) => p.lat),
    lon: pts.map((p) => p.lon),
    iridium_ok: undefined,
    beacon_ok: undefined,
    events: [],
  });
  const out = [{ rep: lane(reps), colours: TRACK.kayak }];
  const est = st.base?.estimate;
  if (est && est.age_h > 0.5) {
    const a = reps[reps.length - 1];
    out.push({
      rep: lane([a, { t: new Date(utc(a.t) + est.age_h * 3600e3).toISOString(), lat: est.lat, lon: est.lon }]),
      colours: { main: "rgba(255,170,100,0.45)", beacon: "rgba(255,170,100,0.45)", glow: "rgba(255,170,100,0.2)" },
    });
  }
  return out;
}

// ---------- cinematic mode and sound ----------
const cine = new Cinema({
  camera,
  controls,
  water: (x, z) => heightAt(live.advance(last), x, z, last),
  yaw: () => smoothYaw ?? 0,
  // The moment on screen: cinematic mode never moves the clock (John, 11 Nov).
  sunEl: () => {
    const r = game.boat;
    if (!r) return 0;
    const h = Math.min(hour, lastHour(r));
    const [la, lo] = positionAt(r, h);
    return sunPosition(utc(r.start) + (h + page.force.skyHours) * 3600e3, la, lo).el;
  },
  sunDir: () => atmos.sunDir,
  cloud: () => clouds.cover,
  toggleSound: () => sound.toggle(),
  fade: (sec) => sound.duck(sec),
  length: () => spec.length,
  height: () => (model ? heightOf(model.root, model.root.position.y + spec.cgBelowWaterline) : 0),
  speed: () => film.stw * KN,
  moment: () => filmMoment(),
  caption: () => {
    const name = spec === KAYAK ? (loadMyBoat()?.name ?? "My kayak") : spec.name.replace(/\s*\(.*\)\s*$/, "");
    return game.boat ? `${name} · Day ${Math.floor(hour / 24) + 1}` : name;
  },
});
const sound = new OceanSound();
(window as unknown as { __sound: OceanSound }).__sound = sound; // read-only, for the live sound checks (Nina)
filmButtons(cine, sound);
(page as unknown as { cine: Cinema }).cine = cine;
// For the cinema's Heel shot (Iris): heel now, deg (+ over to starboard), and the last
// knockdown's timing in the page clock (boats/ride.ts KnockdownTiming), or null.
Object.assign(page, {
  heel: (): number => ride?.heelDeg(motion.roll) ?? 0,
  knockdown: () => ride?.knockdown ?? null,
});
/** What the frame loop last saw, for the film: speed through the water (m/s) and where. */
const film = { stw: 0, lat: NaN, lon: NaN };

/** What's happening now, for picking the film's sequence (cinema.ts). */
function filmMoment(): Moment {
  const r = game.boat;
  // The clock stops while filming, so a knockdown in the last six hours still counts.
  const recentKnockdown = !!r && r.events.some((e) => e.kind === "capsize" && e.h <= hour + 1e-6 && hour - e.h < 6);
  const p = page.land.place ? PLACES[page.land.place] : undefined;
  let land: Moment["land"] = null;
  if (p && Number.isFinite(film.lat)) {
    const { mx, my } = metresPerDegree(film.lat);
    const x = (p.lon - film.lon) * mx;
    const z = -(p.lat - film.lat) * my;
    if (Math.hypot(x, z) < 40000) land = { bearing: (THREE.MathUtils.radToDeg(Math.atan2(x, -z)) + 360) % 360, name: p.name };
  }
  const sh = page.ships;
  return {
    storm,
    knockdownAgo: clock.getElapsedTime() - kick.t,
    recentKnockdown,
    land,
    ship: sh.nearest < 6000 ? { bearing: sh.bearing, km: sh.nearest / 1000 } : null,
  };
}

// ---------- frame ----------
const clock = new THREE.Clock();
const bowW = new THREE.Vector3();
let last = 0;
let smoothYaw: number | null = null;
let stripAt = -1;
let storm = 0;
let rigHeave = 0;
const ghostTag = $("ghosttag");
const proj = new THREE.Vector3();
// ---------- points of interest (wrecks, history, ocean facts) ----------
// Your boat's track only: a card pops up as the replayed hours reach it.
let pois: Poi[] = [];

/** Where the wrecks are, for the chart. */
function wreckMarks(): [number, number][] {
  return pois.filter((p) => p.kind === "wreck").map((p) => p.at[0]);
}

/** A wreck right below, seen through clear, calm water by day (pois.ts). */
function showWreck(lat: number, lon: number): void {
  const w = Number.isFinite(lat) ? wreckBelow(pois, lat, lon) : null;
  const calm = 1 - THREE.MathUtils.smoothstep(sea.waveHeight, 0.6, 2.5);
  const k = w ? w.clear * calm * THREE.MathUtils.smoothstep(atmos.sunLight, 0.05, 0.5) : 0;
  if (w) sea.setWreck(w.x, w.z, w.poi.size_m![0], w.poi.size_m![1], w.poi.depth_m!, k);
  else sea.setWreck(0, 0, 1, 1, 0, 0);
  page.wreck = k > 0.01 ? w!.poi.id : "";
}
const poiSeen = new Set<string>();
let poiH = 0;
const poiCards = new PoiCards(document, { compact: true });
loadPois(new URL(params.get("pois") ?? "./pois.json", location.href).href).then((p) => {
  pois = p;
  page.pois.loaded = p.length;
  chart?.setWrecks(wreckMarks());
  resetPois();
});
/** A new or shared game: what the boat already passed counts as seen. */
function resetPois(): void {
  poiSeen.clear();
  poiCards.hide(true);
  poiHeld = [];
  poiDock();
  if (page.ready && game.boat && hour > 0) passes(game.boat, 0, hour - 1e-6, pois, poiSeen);
  poiH = hour;
}
/** The first half minute of a voyage is for the boat and the sea: a history card reached
 *  then waits in a small tab at the right edge until you open it (Elena, 12 Nov: Cape Henry
 *  opened on top of the boat in the first seconds). Cards after that open as before. */
const POI_QUIET_MS = 30_000;
let sailedAt = -Infinity;
let poiHeld: { p: Parameters<PoiCards["add"]>[0]; when: string }[] = [];
function poiDock(): void {
  let tab = document.getElementById("poidock") as HTMLButtonElement | null;
  if (!poiHeld.length) {
    tab?.remove();
    return;
  }
  if (!tab) {
    tab = document.createElement("button");
    tab.id = "poidock";
    tab.title = "Open the history notes you've passed";
    Object.assign(tab.style, {
      position: "fixed", right: "0", top: "50%", transform: "translateY(-50%)", zIndex: "6", padding: "10px 8px",
      borderRadius: "10px 0 0 10px", borderRight: "none", writingMode: "vertical-rl", font: "600 12px system-ui, sans-serif",
    });
    tab.addEventListener("click", () => {
      const held = poiHeld;
      poiHeld = [];
      poiDock();
      for (const h of held) poiCards.add(h.p, h.when);
    });
    document.body.appendChild(tab);
  }
  tab.textContent = poiHeld.length === 1 ? "History nearby" : `History nearby (${poiHeld.length})`;
}
function poisReached(): void {
  if (!page.ready || !game.boat || !pois.length || hour < poiH) return;
  const ps = passes(game.boat, poiH, hour, pois, poiSeen);
  poiH = hour;
  const quiet = performance.now() - sailedAt < POI_QUIET_MS;
  for (const p of ps) {
    const when = `Day ${(p.h / 24).toFixed(1)}`;
    if (quiet) poiHeld.push({ p, when });
    else poiCards.add(p, when);
  }
  if (quiet && ps.length) poiDock();
  page.pois.shown.push(...ps.map((x) => x.poi.id));
}

/** Land near the boat: load it, keep it in place, and reach the view out to it (gently, over a few seconds). */
function updateLand(t: number, dt: number, lat: number, lon: number, sunEl: number, hs: number, wu: number, wv: number): void {
  if (!land) return;
  land.update(lat, lon, t, { haze: atmos.fog.color, light: atmos.ambient, sunEl, hs, storm, wu, wv });
  page.land = land.shown;
  const want = land.active ? LAND_HORIZON : HORIZON;
  if (want > sea.horizon) sea.setHorizon(want);
  reach += (want - reach) * Math.min(1, dt * 0.6);
  if (Math.abs(want - reach) < 50) reach = want;
  if (!land.active && reach === HORIZON) sea.setHorizon(HORIZON);
  page.reach = reach;
  if (reach !== atmos.horizon) atmos.setHorizon(reach);
  const far = Math.max(12000, reach * 3);
  if (far !== camera.far) {
    camera.far = far;
    camera.updateProjectionMatrix();
  }
  $("osm").hidden = !/OpenStreetMap|Overture/.test(land.credit);
  const credit = $("landcredit");
  const text = land.credit;
  if (credit.dataset.text !== text) {
    credit.dataset.text = text;
    credit.textContent = text ? `${text} · ` : "";
  }
}

// ---------- your order on the water, and the boat on a third (Leo's plan, items 1 and 4) ----------
/** A faint orange line ahead of the boat along your order, lying on the waves, so you see where
 * you're steering with the drawer shut. */
const DASHES = 6;
const orderGeo = new THREE.BufferGeometry();
orderGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array((DASHES * 4 + 3) * 3), 3));
{
  // Dashes that fade out along the way, then a small arrowhead: alpha in the vertex colours.
  const n = DASHES * 4 + 3;
  const col = new Float32Array(n * 4);
  const idx: number[] = [];
  for (let d = 0; d < DASHES; d++) {
    const a = 1 - (0.75 * d) / DASHES;
    for (let k = 0; k < 4; k++) col.set([1, 0.5, 0.15, a], (d * 4 + k) * 4);
    const o = d * 4;
    idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2);
  }
  for (let k = 0; k < 3; k++) col.set([1, 0.5, 0.15, 0.3], (DASHES * 4 + k) * 4);
  idx.push(DASHES * 4, DASHES * 4 + 1, DASHES * 4 + 2);
  orderGeo.setAttribute("color", new THREE.BufferAttribute(col, 4));
  orderGeo.setIndex(idx);
}
const orderLine = new THREE.Mesh(orderGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthWrite: false, side: THREE.DoubleSide, fog: false })); // a hint, not road paint (Ines, Rosa)
orderLine.frustumCulled = false;
orderLine.visible = false;
orderLine.renderOrder = 11; // over the sea, like the wake
scene.add(orderLine);
/** Your order on the water (Elena, 12 Nov): a short, faint dashed arrow 30 to 60 m ahead of the
 * bow that fades out, dimmer at night. Not a beam to the horizon. */
function showOrderLine(hdg: number, comps: Parameters<typeof heightAt>[0], t: number): void {
  const s = page.status;
  const on = page.ready && !SPECTATE && !!s && !s.over && !wheel.on && !cine.on && !arrival && !document.body.classList.contains("bare") && !document.body.classList.contains("goal");
  orderLine.visible = on; // not under the goal card: the opening frame is the boat and the sea (Ines)
  if (!on || !s) return;
  const to =
    typeof order === "number"
      ? order
      : order === "finish"
        ? bearing([s.boat.lat, s.boat.lon], (game.boat?.course.target ?? [39.5, -13.5]) as [number, number])
        : hdg;
  const a = THREE.MathUtils.degToRad(to);
  const dx = Math.sin(a);
  const dz = -Math.cos(a);
  const half = Math.max(0.06, spec.length * 0.008);
  const from = spec.length * 0.8;
  const len = THREE.MathUtils.clamp(spec.length * 5, 30, 60);
  const step = len / (DASHES + 0.5);
  const dash = step * 0.55;
  const pos = orderGeo.getAttribute("position") as THREE.BufferAttribute;
  const put = (i: number, d: number, side: number) => {
    const x = dx * d + dz * side;
    const z = dz * d - dx * side;
    pos.setXYZ(i, x, heightAt(comps, x, z, t) + 0.08, z);
  };
  for (let k = 0; k < DASHES; k++) {
    const d0 = from + k * step;
    put(k * 4, d0, -half);
    put(k * 4 + 1, d0, half);
    put(k * 4 + 2, d0 + dash, -half);
    put(k * 4 + 3, d0 + dash, half);
  }
  const tip = from + DASHES * step + step * 0.6;
  put(DASHES * 4, tip - step * 0.5, -half * 4);
  put(DASHES * 4 + 1, tip - step * 0.5, half * 4);
  put(DASHES * 4 + 2, tip, 0);
  pos.needsUpdate = true;
  (orderLine.material as THREE.MeshBasicMaterial).opacity = 0.06 + 0.4 * THREE.MathUtils.smoothstep(atmos.ambient, 0.2, 0.8);
}

/** The default view keeps the boat on the lower third, with room ahead of the bow and clear
 * of the strip: the lens slides, the orbit doesn't (so dragging still turns about the boat). */
const third = { x: 0, y: 0 };
const ahead = new THREE.Vector3();
const here0 = new THREE.Vector3();
/** Behind the Set sail card, never a stand-in (Elena): the drawn-in-code boat stays hidden, an empty
 *  sea, until her real model has loaded (useBoat and loadDetailedModels rebuild her then). At sea she
 *  always shows. */
function hideStandIn(): void {
  if (!model) return;
  const card = !page.ready && !$("start").hidden;
  const real = isStock(spec.key) ? hasDetailedStock(spec.key) : spec === KAYAK ? hasDetailedKayak() : true;
  const show = !card || real;
  if (model.root.visible === show) return;
  model.root.visible = show;
  if (wake) wake.points.visible = show;
  if (contact) contact.collar.visible = contact.spray.visible = show && !model.twinHull && spec !== RANDOLPH;
}
/** On a phone, the band of sea above the Set sail card: from the bar's foot to the card's top (px). */
function phoneBand(): { top: number; bottom: number } {
  const top = document.getElementById("topbar")?.getBoundingClientRect().bottom ?? 40;
  const card = document.getElementById("ss-card");
  const bottom = card && card.offsetParent ? card.getBoundingClientRect().top : window.innerHeight * 0.45;
  return { top, bottom };
}
function frameBoat(dt: number): void {
  hideStandIn();
  const want = page.ready && !wheel.on && !cine.on && !arrival && !page.card;
  // Before the game is ready too (the start card, the one-click loading view): the boat on a third,
  // the horizon lower, never dead centre (Ines).
  const waiting = !page.ready && !PRACTICE && !wheel.on && !cine.on;
  let tx = 0;
  let ty = 0;
  if (want && smoothYaw !== null) {
    here0.set(0, 0, 0).project(camera);
    ahead.set(Math.cos(smoothYaw) * 20, 0, -Math.sin(smoothYaw) * 20).project(camera);
    const side = ahead.x - here0.x; // + when the bow points right on screen
    // A boat that already fills much of the frame (zoomed in, or a big yacht) stays nearer the
    // middle, so the strip never covers its hull.
    // How much of the frame's height the boat takes (a hull stands about a third of its length tall, mast aside).
    const fill = (spec.length * 0.35) / (2 * camera.position.distanceTo(controls.target) * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
    const room = THREE.MathUtils.clamp((0.45 - fill) / 0.25, 0, 1);
    tx = Math.abs(side) > 0.02 && ahead.z < 1 ? Math.sign(side) * 0.14 * room : 0;
    // A call's card on the right third: the boat goes to the left third, the sea she's choosing about beyond her.
    if (!$("decide").hidden && $("decide").classList.contains("withmap")) tx = 0.17 * room;
    ty = -0.1 * room;
  } else if (waiting) {
    // The boat at about two-thirds across, her bow into the open water on the left (Ines: 64-67%).
    here0.set(0, 0, 0).project(camera);
    tx = THREE.MathUtils.clamp((here0.x + 1) / 2 + third.x - 0.66, -0.4, 0.4);
    ty = -0.1;
  } else if (page.card && !arrival && !wheel.on && !cine.on && window.innerWidth > 900) {
    // The results card sits on the left two-thirds: the boat's last moment on the right third (Leo, Elena).
    here0.set(0, 0, 0).project(camera);
    tx = THREE.MathUtils.clamp((here0.x + 1) / 2 + third.x - 0.82, -0.4, 0.4);
    ty = -0.04;
  }
  // Behind the Set sail card (Elena, Ines): her boat in the right two thirds beside the card, clear
  // of its glass; on a phone, where the card fills the width at the bottom, in the band under the bar.
  if (!page.ready && !$("start").hidden) {
    // Her waterline, where she is: the world's middle on the crossing, off Annapolis on a practice page.
    here0.set(controls.target.x, 0, controls.target.z).project(camera); // includes the lens's current slide, so this settles on the target
    const phone = window.innerWidth < 700;
    tx = THREE.MathUtils.clamp(third.x + (here0.x * 0.5 + 0.5 - (phone ? 0.5 : 0.68)), -0.4, 0.4);
    // A yacht's mast stands tall above her waterline: set her lower in the band so the masthead clears the bar.
    // On a phone the band is from the bar to the card's top (taller cards, e.g. practice's course line, leave less).
    const band = phoneBand();
    const at = !phone ? 0.5 : spec.length > 5 ? (band.bottom - 0.3 * (band.bottom - band.top)) / window.innerHeight : 0.2;
    ty = THREE.MathUtils.clamp(third.y + (0.5 - here0.y * 0.5 - at), -0.4, 0.4);
  }
  const k = Math.min(1, dt * 1.2);
  third.x += (tx - third.x) * k;
  third.y += (ty - third.y) * k;
  const W = window.innerWidth;
  const H = window.innerHeight;
  if (Math.abs(third.x) < 1e-3 && Math.abs(third.y) < 1e-3) {
    if (camera.view?.enabled) camera.clearViewOffset();
  } else camera.setViewOffset(W, H, third.x * W, third.y * H, W, H);
}

/** Turn the camera to look the given compass bearing past the boat, keeping its distance. */
function aimAt(bearing: number): void {
  const a = THREE.MathUtils.degToRad(bearing);
  const off = camera.position.clone().sub(controls.target);
  const flat = Math.hypot(off.x, off.z);
  off.x = -Math.sin(a) * flat;
  off.z = Math.cos(a) * flat;
  camera.position.copy(controls.target).add(off);
}

// Build the sailing view's shaders while the Set sail card is up (M1 start-up profile):
// the first sailing frames otherwise build about a dozen at once (the boat again for the
// calm-water reflection, which draws into its own picture), and the page waits for each.
// Built here, once the card shows and the detailed boats are in, the graphics driver does that work while
// the player reads the card. Once per page; nothing on screen changes.
let warmed = false;
function warmShaders(): void {
  warmed = true;
  const prev = renderer.getRenderTarget();
  try {
    renderer.compile(scene, camera);
    renderer.setRenderTarget(mirror.target);
    renderer.compile(scene, camera);
  } catch {
    /* only a head start: the first sailing frame builds whatever is missing */
  } finally {
    renderer.setRenderTarget(prev);
  }
}
renderer.setAnimationLoop(() => {
  if (!warmed && modelsIn && page.frames >= 3 && !page.ready && !$("start").hidden) warmShaders();
  const t = clock.getElapsedTime();
  // Only drawing is timed: not a hidden tab, and not while the simulator's results are being taken in (Kai).
  if (judging && !document.hidden && !page.busy) {
    // Unclamped frame time: the judge wants the real one.
    const v = judge.tick((t - last) * 1000);
    if (v !== "wait") {
      judging = false;
      qstat.median = Math.round(judge.median() * 10) / 10;
      qstat.typical = Math.round(judge.typical() * 10) / 10;
      qstat.frames = judge.frames;
      // Too slow for Medium: Low, once, while the goal card still covers the switch. Never up.
      if (v === "slow" && qstat.source === "auto" && qstat.level !== "low") {
        qstat.stepped = true;
        applyLevel("low");
      }
    }
  }
  const dt = Math.min(t - last, 0.1);
  last = t;
  // Play the hours just sailed: about 2.5 s a day, at most 6 s.
  if (page.ready && pending.length) applyPending();
  if (page.ready && game.boat) newEvents();
  if (axes.heading.held || axes.power.held) {
    if (page.ready && !page.status?.over && !busy) {
      axes.heading.tick(performance.now());
      axes.power.tick(performance.now());
    } else releaseKeys();
  }
  if (tickClock(dt)) {
    // the clock moved the picture on
  } else if (drainRate > 0 && hour < shownTo) {
    hour = Math.min(shownTo, hour + dt * (slowNow(t) ? Math.min(drainRate, 1) : drainRate));
    if (hour >= shownTo) drainRate = 0;
  } else if (hopPlay && hour < shownTo) {
    const span = Math.max(shownTo - hour, 1);
    const rate = Math.max(span / Math.min(6, 0.6 + (2.5 * span) / 24), 6); // hours per second
    hour = Math.min(shownTo, hour + dt * (slowNow(t) ? 1 : rate));
    if (hour >= shownTo) hopPlay = false;
  }
  // Paused with the picture at the end of the track: show what's left (#353). A stop's
  // status can sit just after the last track hour, so the hour test above never reaches it.
  if (page.ready && pending.length && clockIdle() && drainRate === 0 && !hopPlay && hour >= shownTo - 1e-6)
    applyPending(true);
  runDue();
  if (finishing && hour >= shownTo - 1e-6 && !inFlight) {
    finishing = false;
    applyPending(true);
    newEvents();
    void finish().catch(fail);
  }
  poisReached();
  const r = rep();
  const h = r ? Math.min(hour, lastHour(r)) : 0;
  // The sea: the deployed wind sea and swells for this hour and place when there
  // are any; else the replay's one combined sea. Before the start, the chosen
  // launch's first hour at the drop point, so the sea behind the start card is
  // the one you'll sail into (not a stock 0.8 m).
  const pre = !r && !PRACTICE ? launchTime() : null;
  const at: [Date, number, number] | null = r && r.h.length
    ? [new Date(utc(r.start) + h * 3600e3), ...positionAt(r, h)]
    : pre ? [pre, SPOT?.[0] ?? DROP[0], SPOT?.[1] ?? DROP[1]] : null;
  let sys: Systems | null = at ? seaFeed.at(at[0], at[1], at[2]) : null;
  if (page.force.hs >= 0) {
    // Forced for pictures: one wind sea of that height, running with the (forced) wind.
    const fw = r ? [valueAt(r, r.wind_u, h) ?? 0, valueAt(r, r.wind_v, h) ?? 0] : [0, -1];
    sys = { ws: forcedSea(page.force.hs, fw[0], fw[1]), s1: null, s2: null } as Systems;
  }
  let hs: number;
  let tp: number;
  if (sys && (sys.ws || sys.s1 || sys.s2)) {
    live.setSystems(sys.ws, sys.s1, sys.s2);
    hs = Math.max(Math.hypot(sys.ws?.hs ?? 0, sys.s1?.hs ?? 0, sys.s2?.hs ?? 0), 0.05);
    const big = [sys.ws, sys.s1, sys.s2].reduce((a, b) => ((b?.hs ?? 0) > (a?.hs ?? 0) ? b : a));
    tp = big?.tp ?? 6;
  } else {
    hs = r ? Math.max(valueAt(r, r.hs, h) ?? 0.4, 0.05) : 0.8;
    tp = r ? Math.max(valueAt(r, r.tp, h) ?? 3 + 2.5 * Math.sqrt(hs), 2) : 6;
    const from = r ? angleAt(r, r.wave_dir, h) ?? 270 : 270;
    live.setSeaState(hs, tp, from);
  }
  sea.setWindSea(sys?.ws ?? null);
  // Before the start the files hold no wind: the wind that would raise that wind
  // sea when fully developed (Pierson-Moskowitz, Hs = 0.0246 U^2; GUESS, it is
  // usually a little stronger), blowing the way the wind sea runs.
  const preWind = pre && sys?.ws ? Math.min(Math.sqrt(sys.ws.hs / 0.0246), 30) : 0;
  const preTo = sys?.ws ? THREE.MathUtils.degToRad(sys.ws.dirFrom + 180) : 0;
  // The boat sails through the water: the water flows past it (it stays at the
  // origin), at last frame's speed and heading, in real time whatever the warp.
  if (smoothYaw !== null && flowStw > 0) {
    const fx = flowStw * dt * Math.cos(smoothYaw);
    const fz = -flowStw * dt * Math.sin(smoothYaw);
    live.flow(fx, fz);
    sea.flow(fx, fz);
  }
  const comps = live.advance(t);
  let wu = r ? valueAt(r, r.wind_u, h) ?? 0 : preWind ? preWind * Math.sin(preTo) : practiceWind?.u ?? 3;
  let wv = r ? valueAt(r, r.wind_v, h) ?? 0 : preWind ? preWind * Math.cos(preTo) : practiceWind?.v ?? 0;
  if (page.force.wind >= 0) {
    const w = Math.hypot(wu, wv);
    [wu, wv] = w > 0.01 ? [(wu * page.force.wind) / w, (wv * page.force.wind) / w] : [0, -page.force.wind];
  }
  sea.setSea(hs, Math.hypot(wu, wv), new THREE.Vector2(wu, -wv));
  sea.update(comps, t);
  // At the wheel, the bow, lean and speed are the player's (src/helm/wheel.ts).
  wheelNow = wheel.on ? wheel.frame(dt) : null;
  if (wheelNow) wheelLast = { x: wheelNow.x, y: wheelNow.y };
  const hdg = wheelNow ? wheelNow.heading : r ? angleAt(r, r.heading, h) ?? 90 : 90;
  const yaw = THREE.MathUtils.degToRad(90 - hdg);
  if (smoothYaw === null) smoothYaw = yaw;
  const dyaw = Math.atan2(Math.sin(yaw - smoothYaw), Math.cos(yaw - smoothYaw));
  const step = dyaw * Math.min(1, dt * (wheelNow ? 12 : 2.5));
  smoothYaw += step;
  place.yaw = smoothYaw;
  motion.pose.yaw = smoothYaw;
  const off = camera.position.clone().sub(controls.target);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
  // A call coming: ease round (about 2 s) to look at the problem past the boat. Reduced motion: no turn.
  if (foresee?.look != null && hour >= foresee.from && !stillCamera && !wheel.on && !cine.on) {
    const cur = Math.atan2(-off.x, off.z);
    const want = THREE.MathUtils.degToRad(foresee.look);
    off.applyAxisAngle(new THREE.Vector3(0, 1, 0), -Math.atan2(Math.sin(want - cur), Math.cos(want - cur)) * Math.min(1, dt * 1.2));
  }
  camera.position.copy(controls.target).add(off);
  // A sailing yacht leans on its sails (the replay's heel); the waves rock it about that.
  motion.heel = wheelNow ? rollFromWheel(wheelNow.heelDeg) : r?.heel ? THREE.MathUtils.degToRad(valueAt(r, r.heel, h) ?? 0) : 0;
  motion.advance(comps, t);
  const stw = wheelNow ? wheelNow.speedMs : r ? Math.max(valueAt(r, r.stw, h) ?? 0, 0) : 0;
  flowStw = stw;
  film.stw = stw;
  if (model) {
    ride?.update((x, z) => sea.detailHeightAt(x, z), place, dt, t);
    model.root.position.set(0, motion.heave + (ride?.heave ?? 0) - (contact?.sink ?? 0) - spec.cgBelowWaterline, 0);
    model.root.rotation.set(motion.roll + (ride?.roll ?? 0), smoothYaw, motion.pitch + (ride?.pitch ?? 0), "YZX");
    deckLight.intensity = DECK_CD * NAV_NIGHT.value * (deckYacht ? 2 : Math.max(1, spec.length / KAYAK.length) ** 2);
    model.root.updateMatrixWorld();
    if (contact) {
      bowW.set(contact.bow[0], spec.cgBelowWaterline, contact.bow[1]);
      model.root.localToWorld(bowW);
      contact.update(comps, t, place, hs, { speed: stw, bowClearance: bowW.y - heightAt(comps, bowW.x, bowW.z, t), light: atmos.foamLight, wind: [wu, -wv] });
      deckLight.getWorldPosition(lampW);
      FOAM_LAMP_UNIFORMS.uFoamLamp.value.set(lampW.x, lampW.y, lampW.z, FOAM_AT_NIGHT * NAV_NIGHT.value);
      FOAM_LAMP_UNIFORMS.uFoamLampR.value = 1.5 * Math.max(1, spec.length / KAYAK.length);
    }
    const failedNow = r ? failuresAt(r, h) : new Map<string, string>();
    model.gear.update(
      {
        speed: stw / spec.cruiseSpeed,
        rudder: rudderFor(dt > 0 ? step / dt : 0),
        sun: r ? (valueAt(r, r.ghi, h) ?? 0) / 1000 : 0.5,
        comms: r ? commsAt(r, h) ?? "" : "",
        flow: apparentFlow(wu, wv, stw, 90 - THREE.MathUtils.radToDeg(smoothYaw)),
        failed: failedNow,
      },
      t,
    );
    // The strip's equipment cell (the same icons as Watch a voyage): the watched boat's parts at the shown hour.
    equipmentIcons(equipmentParts(spec.key, r ? commsAt(r, h) : null, failedNow), true, "", false);
    model.rig?.update(dt, {
      flow: apparentFlow(wu, wv, stw, 90 - THREE.MathUtils.radToDeg(smoothYaw)),
      plan: wheelNow ? wheelNow.plan : r ? planAt(r, h) : null,
      rudder: model.gear.shown.rudder,
    });
  }
  wake?.update(comps, t, place, stw);
  const dy = motion.heave - rigHeave;
  rigHeave = motion.heave;
  camera.position.y += dy;
  // A knockdown shakes the camera for a moment: undo last frame's shake, add this one's.
  camera.position.sub(shake);
  const sk = t - kick.t;
  if (sk >= 0 && sk < 0.9 && !stillCamera) shake.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(0.35 * (1 - sk / 0.9));
  else shake.set(0, 0, 0);
  camera.position.add(shake);
  controls.target.y += dy;
  const target = THREE.MathUtils.clamp((Math.hypot(wu, wv) * KN - 15) / 20, 0, 1);
  storm += (target - storm) * Math.min(1, dt * 1.5);
  // Before the first hour is logged the track is empty (positionAt would be NaN, and a NaN sun
  // turns the whole picture black, #334): stand at the boat's reported start instead.
  const st0 = page.status?.boat;
  // Practice off Annapolis: the boat is where the wheel has sailed her from the course's start.
  const prac = practiceAt && wheelNow ? toLatLon(practiceAt, wheelNow) : practiceHere;
  const [lat, lon] = arrival ?? (r && r.h.length ? positionAt(r, h) : st0 ? [st0.lat, st0.lon] : prac ? [prac.lat, prac.lon] : (SPOT ?? [36.65, -74.94]));
  if (practiceAt && wheelNow) buoys.update(wheelNow, t, wheel.wheel?.s.mark ?? 0, comps, wu, wv);
  if (practiceAt && wheelNow && ghostTrack && wheel.wheel) {
    const g = ghostAt(ghostTrack, wheel.wheel.s.t)!;
    const dx = g.x - wheelNow.x;
    const dz = -(g.y - wheelNow.y);
    const gy = heightAt(comps, dx, dz, t);
    const g0 = ghostAt(ghostTrack, wheel.wheel.s.t - 1)!;
    const gstw = Math.hypot(g.x - g0.x, g.y - g0.y); // m/s over the last second
    ghost.update(dx, dz, gy, THREE.MathUtils.degToRad(90 - g.heading), rollFromWheel(g.heel), apparentFlow(wu, wv, gstw, g.heading), dt, NAV_NIGHT.value);
    page.ghost = { shown: ghost.group.visible, m: Math.round(Math.hypot(dx, dz)) };
  } else {
    ghost.hide();
    page.ghost.shown = false;
  }
  const ms = (r ? utc(r.start) + h * 3600e3 : Date.UTC(2020, 3, 1, 14) + PRACTICE_SHIFT_H * 3600e3) + page.force.skyHours * 3600e3;
  const sp = sunPosition(ms, lat, lon);
  film.lat = lat;
  film.lon = lon;
  if (Number.isFinite(lat)) atmos.setCelestial(ms, lat, lon);
  if (Number.isFinite(lat)) sea.setBay(inChesapeake(lat, lon));
  atmos.sprayFar = sprayVisibility(Math.hypot(wu, wv));
  atmos.cloud = clouds.cover; // last frame's, which is close enough
  atmos.rain = clouds.rainShade;
  atmos.set(sp.el, sp.az, storm);
  showWreck(lat, lon);
  clouds.update(t, dt, camera, cloudFromSun(r ? valueAt(r, r.ghi, h) : null, sp.el), storm, fogChance(lat, lon, Math.hypot(wu, wv) * KN, ms / 86400e3), wu, -wv, atmos.sunDir, atmos.fog.color, atmos.ambient, r?.rain ? valueAt(r, r.rain, h) : null);
  clouds.setMoon(atmos.moonDir, atmos.moonlight);
  clouds.closeIn(atmos.fog);
  // The sea mirrors the cloud deck, so sea and sky meet without a line (Kai's Clouds.seaSky, sky PR).
  (clouds as { seaSky?: (out: THREE.Vector4) => void }).seaSky?.(seaUniforms.uSeaSky.value);
  (clouds as { seaBreak?: (out: THREE.Vector4) => void }).seaBreak?.(seaUniforms.uSeaBreak.value);
  const rate = r?.rain ? valueAt(r, r.rain, h) : null;
  // Gathered into showers: grey curtains on the horizon, harder rain when one passes over.
  bands.update(t, camera, rate != null ? rainFromRate(rate) : rainFromStorm(storm), wu, -wv, atmos.fog, atmos.ambient);
  rain.update(t, camera, bands.local, wu, -wv, atmos.ambient);
  setRainOnSea(rate != null ? rainFromRate(rate) : rainFromStorm(storm), bands.local, quality === "low"); // rings on the sea (rainRings.ts)
  page.bands = bands.shown;
  traffic?.update(lat, lon, ms / 1000, atmos.fog.far, sea.waveHeight);
  if (traffic) page.ships = traffic.shown;
  renderer.getDrawingBufferSize(sprayBuf);
  spray.update(t, camera, sprayBuf.y, sprayFor(Math.hypot(wu, wv)), wu, -wv, sea.waveHeight, atmos.ambient);
  page.spindrift = spray.amount;
  sea.setSun(atmos.glintDir, atmos.glintLight);
  wake?.setLight(atmos.foamLight);
  updateLand(t, dt, lat, lon, sp.el, hs, wu, wv);
  sound.rig = rigOf(spec.key);
  sound.length = spec.length;
  if (contact?.splash) sound.splash(contact.splash);
  const feel = smoothYaw != null ? apparentFlow(wu, wv, stw, 90 - THREE.MathUtils.radToDeg(smoothYaw)) : null;
  sound.update(dt, { wind: Math.hypot(wu, wv), hs, tp, rain: rain.amount, near: camera.position.distanceTo(controls.target), stw, apparent: feel ? Math.hypot(feel.x, feel.z) : undefined, luff: (wheelNow as { luff?: number } | null)?.luff });
  wheelCamera(dt, t);
  markPointer();
  if (!cine.update(dt)) controls.update();
  frameBoat(dt);
  const floor = heightAt(comps, camera.position.x, camera.position.z, t) + 0.35;
  if (camera.position.y < floor) camera.position.y = floor;
  // The other boat: a tag on the horizon in its direction, with the distance.
  const other = rep(watch === "boat" ? "ghost" : "boat");
  if (r && other && page.ready) {
    // Base mode: our boat is where base guesses it is, whichever end of the tag it's on.
    const est = hidden() ? page.status?.base?.estimate : undefined;
    const guess = (p: [number, number]): [number, number] => (est ? [est.lat, est.lon] : p);
    const me = watch === "boat" ? guess(positionAt(r, h)) : positionAt(r, h);
    const it = watch === "ghost" ? guess(positionAt(other, Math.min(h, lastHour(other)))) : positionAt(other, Math.min(h, lastHour(other)));
    const km = Math.hypot((it[0] - me[0]) * 111, (it[1] - me[1]) * 111 * Math.cos((me[0] * Math.PI) / 180));
    const b = bearing(me, it);
    const a = THREE.MathUtils.degToRad(b);
    proj.set(Math.sin(a) * 2500, 2, -Math.cos(a) * 2500).project(camera);
    // Only while the ghost's direction is on screen, and the whole tag stays inside it (a
    // tag half off the right edge read as a stray "2" under the map: Leo and Elena, F5).
    const vis = proj.z < 1 && Math.abs(proj.x) < 1 && Math.abs(proj.y) < 1;
    ghostTag.hidden = !vis;
    if (vis) {
      ghostTag.textContent = `${watch === "boat" ? "Ghost" : "You"} · ${km < 1 ? "alongside" : `${km.toFixed(0)} km`}`;
      const half = ghostTag.offsetWidth / 2 + 8;
      ghostTag.style.left = `${THREE.MathUtils.clamp(((proj.x + 1) / 2) * window.innerWidth, half, window.innerWidth - half)}px`;
      ghostTag.style.top = `${((1 - proj.y) / 2) * window.innerHeight}px`;
      if (km < 1) ghostTag.hidden = true; // the strip says "level"
    }
  } else ghostTag.hidden = true;
  showOrderLine(hdg, comps, t);
  page.third = [third.x, third.y];
  renderer.getDrawingBufferSize(bufSize);
  mirror.setSize(bufSize.x, bufSize.y);
  mirror.update(renderer, scene, camera, sea.waveHeight, motion.heave);
  sea.setMirror(mirror.target.texture, mirror.textureMatrix, mirror.strength, mirror.level);
  page.mirror = mirror.strength;
  atmos.render();
  if (chart && game.boat && !game.ghost) {
    // A watched voyage: the one boat's track so far.
    if (chartDirty) {
      chart.setLanes([{ rep: game.boat, colours: TRACK.kayak }], 0);
      chartDirty = false;
    }
    chart.draw(page.card ? 1e9 : hour, performance.now());
  } else if (chart && game.boat && game.ghost) {
    if (chartDirty) {
      const known = hidden() ? knownLanes() : null;
      chart.setLanes(
        known
          ? [...known, { rep: game.ghost, colours: GHOST }]
          : [
              { rep: game.boat, colours: TRACK.kayak, bright: trimRanges() },
              { rep: game.ghost, colours: GHOST },
            ],
        watch === "boat" ? 0 : known ? known.length : 1,
      );
      chartDirty = false;
    }
    chart.draw(page.card ? 1e9 : hour, performance.now());
  }
  if (!(r && page.ready)) $("clock").textContent = "";
  else drawWhen();
  // The strip's instruments read the picture too, a few times a second (not in base mode: base only knows its reports).
  if (r && page.ready && t - stripAt > 0.25) {
    stripAt = t;
    // Only what the track has logged: before its first hour the first status's numbers stay (Leo).
    const live: Parameters<typeof showStrip>[0] = {};
    if (valueAt(r, r.wind_u, h) != null && valueAt(r, r.wind_v, h) != null) {
      live.windKn = Math.hypot(wu, wv) * KN;
      live.windTo = (Math.atan2(wu, wv) * 180) / Math.PI;
    }
    if (valueAt(r, r.hs, h) != null) live.waves = hs;
    if (!hidden()) {
      live.heading = wheelNow ? wheelNow.heading : hdg;
      live.speedKn = stw * KN;
      // Before the first logged hour there's no reading yet: the status's own stays.
      const heel = r.heel ? valueAt(r, r.heel, h) : null;
      const soc = r.heel ? null : valueAt(r, r.soc, h);
      if (heel != null) live.heel = heel;
      if (soc != null) live.battery = soc * 100;
    }
    showStrip(live);
  }
  page.frames++;
  page.hour = hour;
  page.simHour = shownTo;
});

// ---------- Set sail (the one-game plan, step 1; Rosa) ----------
// One entry for every way to start: the ocean crossing, Annapolis practice, a weather
// challenge. Jonas's Set sail card calls window.__setsail.start(choices); the URL carries
// the same choices, so a link (the title, the Boatyard's "Test it", Play again) opens the
// card filled in, and ?go=1 sets sail at once.
if (!shared && !PRACTICE && SS.when !== "calm") $<HTMLSelectElement>("launch").value = LAUNCH[SS.when];
if (!shared && !PRACTICE && SS.boat && boatRow(SS.boat)) {
  boatRow(SS.boat)!.checked = true;
  powerFor(SS.boat);
}

/** The choices the start card shows now. */
function currentSetSail(): SetSail {
  if (PRACTICE) return { ...SS, where: "annapolis", breeze: practiceBreeze, course: lastTrial ?? SS.course };
  return oceanSetSail();
}
/** The crossing's choices from the card's controls (on a practice page too, for its "Across the Atlantic" pill). */
function oceanSetSail(): SetSail {
  const lv = $<HTMLSelectElement>("launch").value;
  return { ...SS, where: "ocean", boat: chosenBoat(), when: lv === LAUNCH.rough ? "rough" : "calm", challenge: $<HTMLSelectElement>("challenge").value, course: "" };
}

/** Set sail with these choices: the same page and screen for every mode; switching between the ocean and Annapolis reloads into the other. */
async function startVoyage(s: SetSail): Promise<void> {
  if (PRACTICE) $("start").hidden = true;
  if ((s.where === "annapolis") !== PRACTICE) {
    location.assign(`helm.html${withChoices(location.search, s, true)}`);
    return;
  }
  history.replaceState(null, "", `helm.html${withChoices(location.search, s)}`);
  if (PRACTICE) {
    practiceBreeze = s.breeze;
    practiceCard();
    await depthsReady;
    await practiceSpell(s.course || "triangle");
    return;
  }
  if (boatRow(s.boat)) {
    boatRow(s.boat)!.checked = true;
    powerFor(s.boat);
  }
  $<HTMLSelectElement>("launch").value = LAUNCH[s.when];
  await challengesReady;
  const sel = $<HTMLSelectElement>("challenge");
  sel.value = challenges.some((c) => c.id === s.challenge) ? s.challenge : "";
  showChallenge();
  await begin();
}
(window as unknown as { __setsail: unknown }).__setsail = { options: SET_SAIL, implied, current: currentSetSail, start: startVoyage };
// The Set sail card draws its pills over the controls above (Jonas; Elena's approved wireframe).
// The boat on the water is always the one you'll sail: the cruiser for Annapolis, else the picked boat (Elena).
let previewed = "";
const previewBoat = (where: SetSail["where"]) => {
  const pick = chosenBoat();
  const key = where === "annapolis" ? "stock_cruiser31" : pick === MINE ? String(startMine?.base ?? "kayak") : pick || "kayak";
  if (key === previewed) return; // only on a change, so a player's own zoom is left alone
  const first = !previewed;
  previewed = key;
  useBoat(key);
  // The page's own opening view, except a practice page: it opens on the cruiser, who needs the
  // same step back as when she's picked, or the camera sits under her sails (Rosa's frame 1).
  if (first && key !== "stock_cruiser31") return;
  // Far enough back to see all of her, mast and sails included, beside the card.
  const off = camera.position.clone().sub(controls.target);
  // On a phone she sits in the band under the bar: further back again, so her masthead clears it.
  // The 6.5 is for the crossing card's band at 390x844 (328 px); a shorter band steps back further.
  const band = phoneBand();
  const back = spec.length > 5 ? (window.innerWidth < 700 ? 6.5 * Math.max(1, 328 / Math.max(120, band.bottom - band.top)) : 4.5) : 2.8;
  camera.position.copy(controls.target).add(off.setLength(spec.length * back));
};
/** Your best time on a practice course in a wind, for the card ("Your best: 14:32"); null before a first finish. */
const bestFor = (course: string, breeze: string): string | null => {
  if (course !== "triangle" && course !== "light") return null;
  const t = readBest(bestKey(course, breeze as Breeze));
  return t == null ? null : trialClock(t);
};
if (!shared) mountSetSailCard({
    current: currentSetSail,
    start: startVoyage,
    challengesReady,
    preview: previewBoat,
    best: bestFor,
    // Who steers (M2, R2): with the autopilot, Set sail opens her voyage of that day on this screen (?watch=).
    // Only with ?who= in the address for now (Elena): the row goes on for everyone, and the menu's "Watch a
    // voyage" moves here, once the watched screen has everything the old one has (R5: the compass strip and
    // "Look up at the sky" (L4), the story notes, the points of interest, the cinematic).
    ...(params.has("who")
      ? { who: whoFromUrl(location.search), voyages: loadIndex(params.get("data") ?? "./voyages").catch(() => []), watch: (file: string) => location.assign(watchLink(location.search, file)) }
      : {}),
  });
// On a practice page the card's Annapolis choice is caught by the card itself (it calls start);
// the crossing must not begin() here, among the Bay's marks, so it reloads into a voyage page.
if (!shared && PRACTICE)
  $("go").addEventListener(
    "click",
    (e) => {
      e.stopImmediatePropagation();
      void startVoyage(oceanSetSail());
    },
    true,
  );
// ?go=1: the card (or a link) already chose; set sail at once.
if (!shared && !PRACTICE && !SPECTATE && params.get("go") === "1") void challengesReady.then(() => startVoyage({ ...currentSetSail(), challenge: SS.challenge || currentSetSail().challenge }));
// A watch or race link goes straight to the sea: there's nothing to pick. Any trouble opening the file
// brings the Set sail card back with why.
if (SPECTATE) {
  $("start").hidden = true;
  $("loadtext").textContent = WATCH ? "Loading the voyage…" : "Getting both boats ready…";
  if (WATCH) $("loading").querySelector(".muted")!.textContent = "";
  $("keyhint").textContent = "Space pause · 1–5 how fast time runs · ? all keys"; // no steering keys here
  $("loading").hidden = false;
  void begin();
}
