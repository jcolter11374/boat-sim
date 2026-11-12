// Take the helm: you steer our kayak across the Atlantic on a real 2020 launch,
// in hops of time, and the autopilot sails the same weather beside you as a
// ghost. The simulator runs in the browser (helm/worker.ts, Sam's
// boatsim.sandbox.helm); this page draws the boat, the chart, the forecast and
// the results card. Display only: the physics is all in the simulator.

import * as THREE from "three";
import { NAV_NIGHT } from "./boats/navlights";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Atmosphere, sunPosition } from "./atmosphere";
import { HORIZON, Sea } from "./water";
import { Mirror, reflectable } from "./mirror";
import { LAND_HORIZON, NearbyLand } from "./land/nearby";
import { BayDepths } from "./land/depth";
import { ANNAPOLIS_COURSE, BAY_WINDS, BREEZES, HARBOUR_WINDS, harbourExit, LIGHT_STONES_M, THOMAS_POINT, bestKey, readBest, runTime, saveBest, toLatLon, toTheLight, toXY, triangle, type Breeze, type Course, type CourseKind, type LatLon } from "./helm/course";
import { Buoys } from "./helm/buoys";
import { CHASE_FOV, ChaseCam } from "./helm/chaseCam";
import { PLACES } from "./land/place";
import { Clouds, cloudFromSun, fogChance } from "./clouds";
import { Spindrift } from "./spindrift";
import { RainBands } from "./rainbands";
import { Traffic } from "./traffic";
import { spindrift as sprayFor, sprayVisibility } from "./storm";
import { Rain, rainFromRate, rainFromStorm } from "./rain";
import { BUILDERS, loadDetailedModels, type BoatModel } from "./boats/model";
import { KAYAK, PLAYABLE_STOCK, RANDOLPH, STOCK, STOCK_HULL, isStock, type BoatSpec } from "./boats/specs";
import { hasDetailedStock, loadStockModel } from "./boats/stock";
import { apparentFlow, rudderFor } from "./boats/gear";
import { BoatMotion, KAYAK_V4, RANDOLPH_REVB, RANDOLPH_REVC, type HullParams } from "./motion";
import { loadMyBoat, myBoatYardLink, saveMyBoat, type MyBoat } from "./myboat";
import { Wake } from "./wake";
import { Contact } from "./contact";
import { heightAt, Sea as LiveSea } from "./waves";
import type { Placement } from "./standin";
import { Chart, TONE_COLOUR, TRACK, type LandBounds } from "./replay/chart";
import { angleAt, commsAt, describeEvent, failedPart, failuresAt, isNotable, lastHour, planAt, positionAt, toneOf, valueAt, type Replay, type ReplayEvent } from "./replay/data";
import { copyText } from "./helm/share";
import { HEADING, HeldAxis, POWER, keyAxis, latestOnly } from "./helm/keys";
import { rollFromWheel } from "./helm/wheel";
import { Ghost } from "./helm/ghost";
import { LIGHT_WIND_FROM, MEDAL_WORDS, ROBOT_SECS, clock as trialClock, ghostAt, medalFor, medalTime, readGhost, saveGhost, turnTrack, type Medal, type Track } from "./helm/trial";
import { COUNTS_AFTER_S, WheelSession, canTakeWheel, summary as wheelSummary, type WheelFrame, type WheelResult } from "./helm/wheelSession";
import { HelmGame, OUTCOME, airtimeText, stopText, type Card, type ForecastRow, type Heading, type Mode, type OrderResult, type Preview, type Status, type Stop } from "./helm/game";
import { Compass } from "./helm/compass";
import { askedChallenge } from "./sailLink";
import { drawForecast } from "./helm/forecast";
import { sandboxThere } from "./sandbox";
import { bundleUrl, loadChallenges, startLabel, type Challenge } from "./helm/challenges";
import { loadPorts, portHint, portName } from "./helm/ports";
import { localTime, shortLocal } from "./replay/localtime";
import { Hud, showStrip } from "./helm/hud";
import { Cinema, filmButtons } from "./cinema";
import { OceanSound, rigFor as rigOf } from "./sound";
import { loadPois, passes, PoiCards, wreckBelow, type Poi } from "./pois";
import { maybeJson, renderNext, standing, type Board, type Grid } from "./results";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const KN = 1.94384;
const utc = (iso: string) => Date.parse(/(Z|[+-]\d\d:\d\d)$/i.test(iso) ? iso : iso + "Z");
const quality = params.get("quality") === "low" ? "low" : "high";

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
camera.position.set(-6.5, 2.2, 3.5);
controls.target.set(0, 0.3, 0);
const atmos = new Atmosphere(renderer, scene, camera);
const sea = new Sea(quality);
scene.add(sea.mesh);
const clouds = new Clouds();
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
const ratio = quality === "high" ? Math.min(window.devicePixelRatio, 2) : atmos.software ? 0.5 : 1;
renderer.setPixelRatio(ratio);
atmos.setPixelRatio(ratio);
atmos.setBloom(quality === "high");
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
  contact = new Contact(model.form, spec, quality);
  // The foam line fits single hulls the size of ours or bigger; not the twin hulls or the little Randolph boat.
  contact.collar.visible = contact.spray.visible = !model.twinHull && spec !== RANDOLPH;
  wake = new Wake(quality, spec.cruiseSpeed, spec.beam, model.stern.x);
  scene.add(model.root, wake.points, contact.collar, contact.spray);
  placeDeckLight();
}

// Night (Leo's review, #334): the sky stays as dark as the night really is, but the boat's
// own light (its all-round or masthead lantern) falls on its deck and on the foam beside it,
// so you can still see your boat. Only your boat: a light per ship would cost every
// material a light. Off by day (NAV_NIGHT is 0), so daytime looks exactly as before.
const deckLight = new THREE.PointLight(0xfff0d8, 0, 6, 2);
deckLight.name = "deck_light";
/** Candela at full night, and the foam's floor of light: tuned on the kayak at 1 AM, moonless. */
const DECK_CD = 3.2;
const FOAM_AT_NIGHT = 0.3;
function placeDeckLight(): void {
  if (!model) return;
  deckLight.removeFromParent();
  const nav = model.root.getObjectByName("nav_lights");
  const lamp = nav?.children[0];
  if (nav && lamp) {
    deckLight.position.copy(lamp.position);
    nav.add(deckLight);
  } else {
    const box = new THREE.Box3().setFromObject(model.root);
    deckLight.position.set(0, box.max.y + 0.1, 0);
    model.root.add(deckLight);
  }
  deckLight.distance = 6 * Math.max(1, spec.length / KAYAK.length);
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
void loadDetailedModels().then((ok) => ok && buildBoat());
const live = new LiveSea(undefined, { n: quality === "high" ? 24 : 16, smoothing: 0.4 });
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
const game = new HelmGame(sandboxBase);
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
    $("porthint").textContent = p ? portHint(p, list) : "The usual start: our support boat drops the drone here, then heads home.";
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
  ready: false,
  busy: false,
  stops: [] as Stop[],
  card: null as Card | null,
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
  decisions: [] as { kind: string; day: number }[],
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
  land: { place: "", km: Infinity, buildings: 0, trees: 0, squares: 0 } as NearbyLand["shown"],
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
(window as unknown as { __helm: typeof page }).__helm = page;

game.onProgress = (t) => {
  $("busytext").textContent = t;
  $("loadtext").textContent = t;
};
// Load the simulator while the player reads the start card, so Set sail starts at once (#322).
void sandboxThere(sandboxBase).then((ok) => (ok ? game.warm() : undefined));

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
  $("c-orderv").textContent = linkCut ? "No link" : order === "auto" ? "Autopilot" : order === "finish" ? "To the finish" : order === "route" ? "The route" : `Steer ${String(Math.round(order)).padStart(3, "0")}°`;
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
  return `${when}: about ${kn.toFixed(1)} knots (${(kn * 1.852).toFixed(1)} km/h), battery ${soc > 0 ? "+" : soc < 0 ? "−" : "±"}${Math.abs(soc)}%, ${prog}${pace}.`;
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
  // The strip's date beside the day: local, short; UTC on hover.
  $("c-date").textContent = shortLocal(ms, whenHere[0], whenHere[1]);
  $("c-date").title = $("when").textContent ?? "";
}

function showStatus(): void {
  const s = shown ?? page.status;
  if (!s) return;
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
  $("lead").textContent = Math.abs(lead) < 1 ? "Level with the autopilot ghost" : lead > 0 ? `${about}${Math.round(lead)} km ahead of the ghost` : `${about}${Math.round(-lead)} km behind the ghost`;
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
  $("ghostline").textContent = `Ghost: battery ${Math.round(s.ghost.soc * 100)}%, ${Math.round(s.ghost.km_to_finish).toLocaleString()} km to go${s.ghost.outcome !== "at_sea" ? `, ${OUTCOME[s.ghost.outcome] ?? s.ghost.outcome}` : ""}`;
  showOrder();
}

// ---------- notes ----------
/** A toast at the top (Leo's plan, item 6): gone on its own, longer for a warning; the reason
 * the clock stopped stays until it runs again. All of them go into the big map's log. */
function note(text: string, when: string, colour: string): void {
  hud.toast(text, when, colour, { warn: colour === TONE_COLOUR.warn || colour === TONE_COLOUR.bad, sticky: /^Paused:/.test(text) });
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
function askSound(): void {
  if (sound.on || sound.muted || sound.remembered) return; // turned on last visit: it comes back at the first click
  const box = $("soundask");
  box.hidden = false;
  const close = () => (box.hidden = true);
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
let finishing = false;
const shake = new THREE.Vector3();
const stillCamera = matchMedia("(prefers-reduced-motion: reduce)").matches;

function moment(e: ReplayEvent): void {
  const now = clock.getElapsedTime();
  if (e.kind === "capsize") {
    kick = { t: now, dir: Math.random() < 0.5 ? -1 : 1 };
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
  return t < slowUntil || (finishing && shownTo - hour < 3);
}

/** The knockdown's roll (rad) at time t: thrown over, then righting itself with a wobble. */
function kickRoll(t: number): number {
  const k = t - kick.t;
  return k >= 0 && k < 5 ? kick.dir * 1.25 * Math.exp(-k * 1.2) * Math.cos(k * 2.6) : 0;
}

// ---------- running time ----------
async function sail(kind: "6h" | "day" | "event" | "end"): Promise<void> {
  if (busy || !page.ready || page.status?.over) return;
  setRate(0); // a skip pauses the clock: you see where it got to
  setBusy(true, "Sailing...");
  if (inFlight) await inFlight; // the clock's own run finishes first
  if (page.status?.over) return setBusy(false);
  const from = hour;
  try {
    const opts =
      kind === "6h"
        ? { hours: 6, breakdown: false }
        : kind === "day"
          ? { hours: 24, breakdown: false }
          : kind === "end"
            ? { hours: 24 * 200, breakdown: false } // the game ends by itself (finish, landfall or max days)
            : untilOptions();
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
    } else if (!(kind !== "event" && stopped === "time"))
      note(stopText(stopped, page.status), `Day ${page.status!.day.toFixed(1)}`, stopped === "ghost_passed" || stopped === "silence" ? TONE_COLOUR.warn : stopped === "passed_ghost" ? TONE_COLOUR.good : TONE_COLOUR.info);
    await refreshForecast();
    if (page.status?.over) finishing = true; // the results wait for the picture (#329)
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
/** Voyage hours per second to start at: what a hop used to play at. Real time would show nothing happening for hours. */
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
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#timebar .rate"))) b.setAttribute("aria-pressed", String(rate > 0 && Number(b.dataset.rate) === rate));
  $("timestate").textContent = rate === 0 ? "Paused: press ▶ or a speed to carry on" : rate === 1 ? "▶ 1 hour a second" : rate < 24 ? `▶▶ ${rate} hours a second` : rate === 24 ? "▶▶▶ 1 day a second" : `▶▶▶ ${rate / 24} days a second`;
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
    if (stopped !== "time") {
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
    if (stopped === "time") maybeDecide();
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

/** This frame's share of the clock: move the picture on, and keep the simulator ahead of it. */
function tickClock(dt: number): boolean {
  if (!(rate > 0) || busy || !page.ready || page.status?.over || cine.on) return false;
  if (easeUpAt !== null && hour >= easeUpAt) setRate(DEFAULT_RATE);
  // Ease off as the simulator's lead runs down, so a slow computer sees slower, smooth time rather than stop-start.
  const ahead = shownTo - hour;
  const r = clock.getElapsedTime() < slowUntil ? Math.min(rate, 1) : rate; // a moment (#329) plays at an hour a second
  hour = Math.min(shownTo, hour + dt * (ahead >= r / 2 ? r : r * Math.max(0.2, (2 * ahead) / r)));
  if (!inFlight && shownTo - hour < rate)
    inFlight = clockRun().finally(() => {
      inFlight = null;
    });
  return true;
}

for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#timebar .rate"))) b.addEventListener("click", () => setRate(Number(b.dataset.rate)));
$("t-pause").addEventListener("click", () => setRate(rate ? 0 : lastRate));
// Keys, so it feels like steering rather than filling in a form (Leo's review): Space
// pauses or carries on, 1-3 pick a speed, Left/Right turn 5 degrees, Up/Down change power.
const SPEED_KEYS: Record<string, number> = { Digit1: 1, Digit2: 6, Digit3: 24, Digit4: 96, Numpad1: 1, Numpad2: 6, Numpad3: 24, Numpad4: 96 };
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
  let counts: { hours: number } | null = null;
  const st = page.status;
  if (r.sailedSecs >= COUNTS_AFTER_S && st?.sailboat && st.trim !== undefined && mode === "hands_on") {
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
const PRACTICE = params.has("practice");
/** ?hour=21 sets the practice clock (Annapolis local time, April): for dusk and night looks. Default 10 am. */
const PRACTICE_SHIFT_H = Number.isFinite(Number(params.get("hour"))) && params.get("hour") !== null ? Number(params.get("hour")) - 10 : 0;
let practiceWind: { u: number; v: number } | null = null;
let practiceN = 0;
/** Where the practice spell began (the boat is there plus the wheel's x, y), or null. */
let practiceAt: LatLon | null = null;
/** The last place the boat was, so the view stays put between runs. */
let practiceHere: LatLon | null = null;
let practiceCourse: Course | null = null;
let practiceBreeze: Breeze = "good";
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
  buoys.set(c.kind === "triangle" ? c.marks.slice(0, 2).map((m) => toXY(o, m)).concat([{ x: 0, y: 0 }]) : []);
  const ok = await wheel.start({
    boatKey: "stock_cruiser31",
    heading: c.heading,
    speedMs: 0,
    windU: practiceWind.u,
    windV: practiceWind.v,
    plan: practiceBreeze === "fresh" ? "reef1" : "full",
    course: { marks: c.marks.map((m) => ({ ...toXY(o, m), name: m.name })), radiusM: c.radiusM },
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
    banner(c.kind === "triangle" ? `The triangle · ${br.kn} knots from the ${point(from)}` : `To Thomas Point Light · ${br.kn} knots from the ${point(from)} · keep off its shoal`);
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
  let text = wheelSummary(r, null).replace(/ (Sail at least a minute|Your voyage waited|For the next).*$/, "");
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
  if (card.classList.contains("trial")) $("practice-courses").hidden = true;
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
  // The first run has no ghost to race yet (Leo): "Try again"; after that, "Race your best".
  $("practice-ghost").textContent = before == null ? "Try again" : "Race your best";
  box.hidden = false;
  $("practice-end").classList.add("trial");
  $("practice-end").querySelector("h1")!.textContent = `${kind === "triangle" ? "The triangle" : "Thomas Point Light"} · ${BREEZES[practiceBreeze].kn} knots`;
}
/** The course card: pick a course and a breeze. */
function practiceCard(): void {
  if (!$("practice-end").classList.contains("trial")) $("practice-end").querySelector("h1")!.textContent = "Practice sailing";
  const annapolis = !!depths?.known;
  $("practice-courses").hidden = !annapolis;
  $("practice-again").hidden = annapolis;
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#practice-breeze button"))) b.setAttribute("aria-pressed", String(b.dataset.b === practiceBreeze));
  for (const b of Array.from(document.querySelectorAll<HTMLElement>("#practice-courses [data-best]"))) {
    const t = readBest(bestKey(b.dataset.best as CourseKind, practiceBreeze));
    b.textContent = t == null ? "" : `your best ${runTime(t)}`;
  }
}
if (PRACTICE) {
  document.body.classList.add("practice");
  $("start").hidden = true;
  useBoat("stock_cruiser31");
  $("practice-again").addEventListener("click", () => void practiceSpell("drill"));
  $("practice-ghost").addEventListener("click", () => void (lastTrial && practiceSpell(lastTrial)));
  $("practice-other").addEventListener("click", () => {
    $("practice-result").hidden = true;
    $("practice-end").classList.remove("trial");
    practiceCard();
  });
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#practice-courses [data-course]"))) b.addEventListener("click", () => void practiceSpell(b.dataset.course as CourseKind | "drill"));
  for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>("#practice-breeze button")))
    b.addEventListener("click", () => {
      practiceBreeze = b.dataset.b as Breeze;
      practiceCard();
    });
  void depthsReady.then((d) => {
    page.practiceBay = d.known;
    if (d.known) {
      // Open on the course card, the boat already off Annapolis with the town behind.
      practiceHere = ANNAPOLIS_COURSE;
      $("practice-sum").textContent = "Sail a 31 ft cruiser yourself off Annapolis, on the Chesapeake Bay. Pick a breeze and a course.";
      practiceCard();
      $("practice-end").hidden = false;
      aimAt(290); // toward the town and the Naval Academy
    } else void practiceSpell("drill");
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
function wheelCamera(dt: number, t: number): void {
  if (cine.on) return; // the cinematic owns the lens
  const ours = !!wheelNow && chase.on;
  // Ease the lens in and out (45 is the page's own).
  const fov = ours ? CHASE_FOV : 45;
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
  const s = chase.update(dt, wheelNow.heading, wheel.wheel.twa(), spec.length, rigTop(), frame, stillCamera);
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
function markPointer(): void {
  const el = $("markptr");
  const w = wheel.wheel;
  if (!wheelNow || !w || $("wheel-goal").hidden) {
    el.hidden = true;
    return;
  }
  const m = w.markXY();
  camera.updateMatrixWorld();
  markV.set(m.x - wheelNow.x, 3, -(m.y - wheelNow.y)).project(camera);
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
  const d = w.distToMark();
  // Over the buoy it's a quiet tag that fades once the buoy is plain to see (Elena, 12 Nov);
  // at the edge it stays a bold orange arrow, as that's the only way to find the mark.
  // Far off the buoy is a speck: keep the mark's orange so it reads as the mark (Leo); quiet once the buoy shows.
  el.toggleAttribute("data-far", inView && d > MARK_TAG_FAR_M);
  el.style.opacity = inView ? String(THREE.MathUtils.clamp((d - MARK_TAG_GONE_M) / (MARK_TAG_FADE_M - MARK_TAG_GONE_M), 0, 1)) : "1";
  el.textContent = d >= 1000 ? `${(d / 1000).toFixed(1)} km` : `${Math.round(d / 10) * 10} m`;
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
  return page.ready && !page.status?.over && mode === "hands_on" && canTakeWheel(spec.key) && !cine.on;
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
  } else if (ax) {
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
  if (soc > 0.2) o.soc_below = Math.max(0.1, soc - 0.3); // a big drop, or the reserve
  if (wind < 15) o.wind_above = 17; // a gale coming (17 m/s is 33 knots); not again while it blows
  return o;
}

// ---------- decisions (#328) ----------
// The clock stops for choices, not only for things that already happened: a gale in the
// forecast, a night that could run the battery flat, the Gulf Stream. Each is asked once
// per spell (a gale is not asked again for 2 days, a night for a day, the Stream until you
// leave it). Hands on only: from base, orders go by satellite and the forecast is the same.
type Choice = { label: string; title: string; act: () => Promise<void> | void };
const asked = { gale: -Infinity, night: -Infinity, stream: false };
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

/** The decision due now, if any. */
function decisionDue(st: Status, fc: ForecastRow[] | null): { kind: string; text: string; choices: Choice[] } | null {
  if (mode !== "hands_on" || st.over || shared || st.no_link) return null;
  const h = st.day * 24;
  const w = st.weather;
  const motors = !st.sailboat && st.power_w > 0;
  const carryOn: Choice = { label: "Carry on as I am", title: "Keep the order you have", act: () => undefined };
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
      const toFinish = bearing([st.boat.lat, st.boat.lon], (game.boat?.course.target ?? [39.5, -13.5]) as [number, number]);
      const south = Math.round(((toFinish + 50) % 360) / 5) * 5;
      const call = (chose: string, act: () => Promise<void> | void) => () => {
        spell = { kind, h, chose, km: st.boat.km_to_finish };
        return act();
      };
      const choices: Choice[] = [
        { label: "Hold course: fastest, but a knockdown is likelier", title: "Sail on through it", act: call("hold", () => undefined) },
        { label: `Dodge south-east (${south}°): safer, but a longer way round`, title: "Steer away from the worst of it; aim at the finish again once it has passed", act: call("dodge", () => setOrder(south)) },
      ];
      if (motors && power > 0.1)
        choices.push({ label: "Slow down and ride it out (10% power): less pounding, saves battery, loses time", title: "The motors ease off; turn them back up after the blow", act: call("slow", () => setOrder(order === "auto" ? "route" : order, 0.1)) });
      return {
        kind,
        text: `${kind === "gale" ? "A gale is" : "Big waves are"} forecast here ${inWords(bad.ah)}: wind up to ${kmh(peakW)} and waves up to ${peakH.toFixed(1)} m. A small boat can be knocked flat in that. What will you do?`,
        choices,
      };
    }
  }
  // A night that could run the battery flat.
  if (fc && motors && st.boat.soc < 0.35 && power > 0.15 && order !== "auto" && h - asked.night >= 24) {
    if (ahead.some((r) => r.ah > 0 && r.ah <= 12 && r.ghi < 5)) {
      asked.night = h;
      return {
        kind: "night",
        text: `The battery is at ${Math.round(st.boat.soc * 100)}% and night is coming, with no sun to charge it. At your ${Math.round(power * 100)}% power the motors could run it flat before morning, and a flat boat can't call home.`,
        choices: [
          { label: "Ease off to 10%: slower, but lasts till sunrise", title: "Turn the power back up in the morning", act: () => setOrder(order, 0.1) },
          { ...carryOn, label: "Keep the power up: faster, but may run flat overnight" },
        ],
      };
    }
  }
  // The Gulf Stream: a river of warm water in the sea, running north-east at up to 4 knots.
  // Riding it already: a word, not a stop. Fighting it: ask (Leo).
  const cur = w ? Math.hypot(w.current_u, w.current_v) : 0;
  if (w && cur < 0.5) asked.stream = false;
  if (w && cur >= 1 && !asked.stream) {
    asked.stream = true;
    const setTo = (Math.atan2(w.current_u, w.current_v) * 180) / Math.PI;
    const off = Math.abs(((st.boat.heading - setTo + 540) % 360) - 180);
    if (off < 90 || order === "route") {
      const text = `You're riding the Gulf Stream: ${kmh(cur)} of current carrying you ${towards(w.current_u, w.current_v)}, for free.`;
      whenAt(h, () => note(text, `Day ${st.day.toFixed(1)}`, TONE_COLOUR.good));
      return null;
    }
    return {
      kind: "stream",
      text: `You're in the Gulf Stream, and steering against it: ${kmh(cur)} of current is carrying the boat ${towards(w.current_u, w.current_v)}. Ridden well it's a free ride towards Europe; fought, it pushes you sideways.`,
      choices: [
        { label: "Follow the planned route (it rides the Stream)", title: "The autopilot's planned route allows for the current", act: () => setOrder("route") },
        { ...carryOn, label: "Carry on as I am: keep fighting it" },
      ],
    };
  }
  return null;
}

let decisionSeq = 0;

/** Stop the clock and ask, when a decision is due. */
function maybeDecide(): boolean {
  const st = game.status;
  if (!st || rate === 0) return false;
  const d = decisionDue(st, lastForecast);
  if (!d) return false;
  setRate(0, true);
  page.decisions.push({ kind: d.kind, day: st.day });
  // Asked once the picture gets there, so the question and the view agree. Carrying on
  // before then skips it; a later question replaces it.
  const seq = ++decisionSeq;
  whenAt(st.day * 24, () => {
    if (seq === decisionSeq && rate === 0 && !game.status?.over) showDecision(d);
  });
  return true;
}

function showDecision(d: { text: string; choices: Choice[] }): void {
  $("decidetext").textContent = d.text;
  const box = $("decidebtns");
  box.replaceChildren();
  for (const c of d.choices) {
    const b = document.createElement("button");
    b.textContent = c.label;
    b.title = c.title;
    b.addEventListener("click", async () => {
      $("decide").hidden = true;
      await c.act();
      setRate(lastRate);
    });
    box.append(b);
  }
  $("decide").hidden = false;
  $("fcbox").classList.add("lit");
  hud.forecast(true, true);
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

async function finish(): Promise<void> {
  const c = await game.result();
  chartDirty = true;
  // Over the line off Lisbon: first the arrival itself, then the results (the finish scene, #329).
  if (c.boat.outcome === "arrived" && finishesOffLisbon() && !shared) await arrivalScene(c);
  page.card = c;
  const me = c.boat;
  const gh = c.ghost;
  const head =
    c.verdict === "won"
      ? "You beat the autopilot!"
      : c.verdict === "lost"
        ? "The autopilot won this one."
        : c.verdict === "draw"
          ? "A draw: within a day of each other, which is down to the weather's luck."
          : "Neither boat finished.";
  $("r-head").textContent = head;
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
    h.textContent = e.headline;
    const t = document.createElement("span");
    t.className = "words";
    const when = e.day != null && x.outcome !== "arrived" ? `day ${e.day.toFixed(1)}` : "";
    // Running aground names only the spot ("38.62N 27.91W"): say what happened there.
    const words = /^\d+(\.\d+)?[NS]\s/.test(e.words) ? `came ashore at ${e.words}` : e.words;
    t.textContent = [words, e.where, when].filter(Boolean).join(", ");
    row.append(w, h, t);
    ends.append(row);
  }
  const bits: string[] = [];
  if (c.margin_days !== null) bits.push(c.margin_days > 0 ? `You finished ${c.margin_days.toFixed(1)} days ahead.` : `The ghost finished ${(-c.margin_days).toFixed(1)} days ahead.`);
  if (c.breakdowns_differ) bits.push("Note: different things broke on the two boats, so luck played a part.");
  const air = me.airtime;
  if (air) bits.push(`Satellite bill on the ${air.plan} plan, for ${air.months} month${air.months === 1 ? "" : "s"} with the $${air.usd.activation.toFixed(2)} activation; the backup beacon pinged ${air.beacon_pings} times on its own yearly fee.`);
  const ch = challenges.find((x) => x.id === page.challenge);
  bits.push(`${c.orders.length} orders given. ${ch ? `Challenge: ${ch.title}, launched` : "Launch"} ${c.launch.slice(0, 10)}; things ${c.breakdowns_on ? "could" : "couldn't"} break.`);
  // Over the line off Lisbon: the scene moves on to the coast it points at (the line itself is far out at sea).
  if (me.outcome === "arrived" && finishesOffLisbon()) {
    showArrival();
    bits.push("Behind this card: the arrival, off Cascais near Lisbon, with Cabo da Roca and the Sintra hills to the north-west. The finish line itself is about 330 km out to sea, too far to see land from.");
  }
  // #335: the browser sails on a lighter weather file than the full runs behind the voyage replays.
  bits.unshift("Sailed in your browser on lighter weather data, so on a long voyage it can differ by days from the full-data voyage replays.");
  $("r-notes").textContent = bits.join(" ");
  $("result").hidden = false;
  sound.settle(); // a soft knock, and the sea drops to half under the card
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
  const mine = loadMyBoat();
  const s = standing(build, board, grid);
  renderNext(box, build, s, mine ? `./${myBoatYardLink(mine)}` : undefined);
  page.standing = s.kind;
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
  $("chnote").hidden = !c?.weather_note;
  $("chover").hidden = !c;
  if (!c) return;
  $("chstory").textContent = `${c.story} The drop is at noon UTC on ${startLabel(c)}.`;
  // Storm boost (#117) is ignored for now: storms sail on plain ERA5, so say so.
  $("chnote").textContent = c.weather_note;
}
async function begin(): Promise<void> {
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
  if (!(await sandboxThere(sandboxBase))) {
    page.error = "no simulator files";
    $("startmsg").textContent = "The simulator files aren't published on this copy of the site yet, so there's nothing to sail. Try the live site.";
    return;
  }
  await challengesReady;
  const ch = chosenChallenge();
  if (shared && params.get("c") && !ch) {
    page.error = "no challenge files";
    $("startmsg").textContent = "That link is for a weather challenge whose weather isn't on this copy of the site. Try the live site.";
    return;
  }
  page.challenge = ch?.id ?? "";
  page.startPort = shared ? "" : $<HTMLSelectElement>("port").value;
  const hb = handBoat();
  if (!shared && hb && !$("prologuepick").hidden && $<HTMLInputElement>("prologue").checked) await runPrologue(hb);
  $("start").hidden = true;
  $("loading").hidden = false;
  setBusy(true, "Loading the simulator (about 30 MB the first time)...");
  if (!/%/.test($("loadtext").textContent ?? "")) $("loadtext").textContent = "Loading the simulator (about 30 MB the first time)...";
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
    resetPois();
    present();
    newEvents();
    await refreshForecast();
    chart?.setLanes([
      { rep: game.boat!, colours: TRACK.kayak },
      { rep: game.ghost!, colours: GHOST },
    ]);
    chartDirty = true;
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
    hud.sailing(shared ? null : mode === "base" ? "Pick a heading and power, then send it: it reaches the boat at its next check-in." : "Steer here, or with ← →. O opens and closes this.");
    $("loading").hidden = true;
    if (shared || params.get("clock") === "paused" || page.status?.over) setRate(0);
    else {
      // The first hours at an hour a second, so the first thing a player sees is the morning of the drop.
      setRate(1);
      lastRate = DEFAULT_RATE; // a pause then carries on at the usual speed
      easeUpAt = hour + FIRST_HOURS;
    }
    $("keyhint").hidden = false;
    setTimeout(hideKeyHint, 60_000);
    askSound();
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
const boatRow = (v: string) => document.querySelector<HTMLInputElement>(`input[name="boat"][value="${v}"]`);
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
$("again").addEventListener("click", () => location.reload());
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
    return sunPosition(utc(r.start) + h * 3600e3, la, lo).el;
  },
  sunDir: () => atmos.sunDir,
  cloud: () => clouds.cover,
  toggleSound: () => sound.toggle(),
  fade: (sec) => sound.duck(sec),
});
const sound = new OceanSound();
filmButtons(cine, sound);
(page as unknown as { cine: Cinema }).cine = cine;

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
const orderLine = new THREE.Mesh(orderGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.5, depthWrite: false, side: THREE.DoubleSide, fog: false }));
orderLine.frustumCulled = false;
orderLine.visible = false;
orderLine.renderOrder = 11; // over the sea, like the wake
scene.add(orderLine);
/** Your order on the water (Elena, 12 Nov): a short, faint dashed arrow 30 to 60 m ahead of the
 * bow that fades out, dimmer at night. Not a beam to the horizon. */
function showOrderLine(hdg: number, comps: Parameters<typeof heightAt>[0], t: number): void {
  const s = page.status;
  const on = page.ready && !!s && !s.over && !wheel.on && !cine.on && !arrival && !document.body.classList.contains("bare");
  orderLine.visible = on;
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
  const half = Math.max(0.09, spec.length * 0.012);
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
function frameBoat(dt: number): void {
  const want = page.ready && !wheel.on && !cine.on && !arrival && !page.card;
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
    ty = -0.1 * room;
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

renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
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
  const hs = r ? Math.max(valueAt(r, r.hs, h) ?? 0.4, 0.05) : 0.8;
  const tp = r ? Math.max(valueAt(r, r.tp, h) ?? 3 + 2.5 * Math.sqrt(hs), 2) : 6;
  const from = r ? angleAt(r, r.wave_dir, h) ?? 270 : 270;
  live.setSeaState(hs, tp, from);
  const comps = live.advance(t);
  const wu = r ? valueAt(r, r.wind_u, h) ?? 0 : practiceWind?.u ?? 3;
  const wv = r ? valueAt(r, r.wind_v, h) ?? 0 : practiceWind?.v ?? 0;
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
  camera.position.copy(controls.target).add(off);
  // A sailing yacht leans on its sails (the replay's heel); the waves rock it about that.
  motion.heel = wheelNow ? rollFromWheel(wheelNow.heelDeg) : r?.heel ? THREE.MathUtils.degToRad(valueAt(r, r.heel, h) ?? 0) : 0;
  motion.advance(comps, t);
  const stw = wheelNow ? wheelNow.speedMs : r ? Math.max(valueAt(r, r.stw, h) ?? 0, 0) : 0;
  if (model) {
    model.root.position.set(0, motion.heave - spec.cgBelowWaterline, 0);
    model.root.rotation.set(motion.roll + kickRoll(t), smoothYaw, motion.pitch, "YZX");
    deckLight.intensity = DECK_CD * NAV_NIGHT.value * Math.max(1, spec.length / KAYAK.length) ** 2;
    model.root.updateMatrixWorld();
    if (contact) {
      bowW.set(contact.bow[0], spec.cgBelowWaterline, contact.bow[1]);
      model.root.localToWorld(bowW);
      contact.update(comps, t, place, hs, { speed: stw, bowClearance: bowW.y - heightAt(comps, bowW.x, bowW.z, t), light: Math.max(atmos.ambient, FOAM_AT_NIGHT * NAV_NIGHT.value) });
    }
    model.gear.update(
      {
        speed: stw / spec.cruiseSpeed,
        rudder: rudderFor(dt > 0 ? step / dt : 0),
        sun: r ? (valueAt(r, r.ghi, h) ?? 0) / 1000 : 0.5,
        comms: r ? commsAt(r, h) ?? "" : "",
        flow: apparentFlow(wu, wv, stw, 90 - THREE.MathUtils.radToDeg(smoothYaw)),
        failed: r ? failuresAt(r, h) : new Map(),
      },
      t,
    );
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
  const ms = r ? utc(r.start) + h * 3600e3 : Date.UTC(2020, 3, 1, 14) + PRACTICE_SHIFT_H * 3600e3;
  const sp = sunPosition(ms, lat, lon);
  if (Number.isFinite(lat)) atmos.setCelestial(ms, lat, lon);
  atmos.sprayFar = sprayVisibility(Math.hypot(wu, wv));
  atmos.cloud = clouds.cover; // last frame's, which is close enough
  atmos.set(sp.el, sp.az, storm);
  showWreck(lat, lon);
  clouds.update(t, dt, camera, cloudFromSun(r ? valueAt(r, r.ghi, h) : null, sp.el), storm, fogChance(lat, lon, Math.hypot(wu, wv) * KN, ms / 86400e3), wu, -wv, atmos.sunDir, atmos.fog.color, atmos.ambient);
  clouds.closeIn(atmos.fog);
  const rate = r?.rain ? valueAt(r, r.rain, h) : null;
  // Gathered into showers: grey curtains on the horizon, harder rain when one passes over.
  bands.update(t, camera, rate != null ? rainFromRate(rate) : rainFromStorm(storm), wu, -wv, atmos.fog, atmos.ambient);
  rain.update(t, camera, bands.local, wu, -wv, atmos.ambient);
  page.bands = bands.shown;
  traffic?.update(lat, lon, ms / 1000, atmos.fog.far, sea.waveHeight);
  if (traffic) page.ships = traffic.shown;
  renderer.getDrawingBufferSize(sprayBuf);
  spray.update(t, camera, sprayBuf.y, sprayFor(Math.hypot(wu, wv)), wu, -wv, sea.waveHeight, atmos.ambient);
  page.spindrift = spray.amount;
  sea.setSun(atmos.glintDir, atmos.glintLight);
  wake?.setLight(atmos.ambient);
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
    const vis = proj.z < 1 && Math.abs(proj.x) < 1.1 && Math.abs(proj.y) < 1.1;
    ghostTag.hidden = !vis;
    if (vis) {
      ghostTag.style.left = `${((proj.x + 1) / 2) * window.innerWidth}px`;
      ghostTag.style.top = `${((1 - proj.y) / 2) * window.innerHeight}px`;
      ghostTag.textContent = `${watch === "boat" ? "Ghost" : "You"} · ${km < 1 ? "alongside" : `${km.toFixed(0)} km`}`;
      if (km < 1) ghostTag.hidden = true; // the strip says "level"
    }
  } else ghostTag.hidden = true;
  showOrderLine(hdg, comps, t);
  page.third = [third.x, third.y];
  renderer.getDrawingBufferSize(bufSize);
  mirror.setSize(bufSize.x, bufSize.y);
  mirror.update(renderer, scene, camera, sea.waveHeight);
  sea.setMirror(mirror.target.texture, mirror.textureMatrix, mirror.strength);
  page.mirror = mirror.strength;
  atmos.render();
  if (chart && game.boat && game.ghost) {
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
