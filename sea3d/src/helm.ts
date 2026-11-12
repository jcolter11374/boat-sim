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
import { angleAt, commsAt, describeEvent, failuresAt, isNotable, lastHour, planAt, positionAt, toneOf, valueAt, type Replay, type ReplayEvent } from "./replay/data";
import { copyText } from "./helm/share";
import { HelmGame, OUTCOME, airtimeText, stopText, type Card, type ForecastRow, type Heading, type Mode, type OrderResult, type Preview, type Status, type Stop } from "./helm/game";
import { Compass } from "./helm/compass";
import { askedChallenge } from "./sailLink";
import { drawForecast } from "./helm/forecast";
import { sandboxThere } from "./sandbox";
import { bundleUrl, loadChallenges, startLabel, type Challenge } from "./helm/challenges";
import { loadPorts, portHint, portName } from "./helm/ports";
import { localTime } from "./replay/localtime";
import { Cinema, filmButtons } from "./cinema";
import { OceanSound } from "./sound";
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
  hint();
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
  ships: { ships: 0, inSight: 0, nearest: Infinity, bearing: 0, kinds: { container: 0, tanker: 0, fishing: 0 } } as Traffic["shown"],
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

async function setOrder(h: Heading, p = power): Promise<void> {
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
    if (!r.accepted) {
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
  $("ordertext").textContent =
    order === "auto"
      ? "Autopilot steering, like the ghost"
      : order === "finish"
        ? "Straight at the finish"
        : order === "route" ? "Following the autopilot's route" : `Steering ${String(Math.round(order)).padStart(3, "0")}°`;
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
  return bits.join(" · ");
}

function showStatus(): void {
  const s = shown ?? page.status;
  if (!s) return;
  const b = s.boat;
  const finish = (game.boat?.course.target ?? [39.5, -13.5]) as [number, number];
  const est = hidden() ? s.base?.estimate : undefined;
  const last = s.base?.last_report;
  // Where the page believes the boat is: the truth, or base's estimate.
  const here: [number, number] = est ? [est.lat, est.lon] : [b.lat, b.lon];
  const fb = bearing(here, finish);
  $("day").textContent = `Day ${s.day.toFixed(1)}`;
  $("when").textContent = new Date(utc(b.t)).toUTCString().slice(5, 22) + " UTC";
  $("local").textContent = localTime(utc(b.t), here[0], here[1]);
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
function note(text: string, when: string, colour: string): void {
  const el = document.createElement("div");
  el.className = "note glass";
  el.style.borderLeftColor = colour;
  el.innerHTML = `<div class="when"></div><div class="txt"></div>`;
  (el.querySelector(".when") as HTMLElement).textContent = when;
  (el.querySelector(".txt") as HTMLElement).textContent = text;
  const box = $("notes");
  box.prepend(el);
  while (box.children.length > 5) box.lastElementChild?.remove();
  setTimeout(() => el.classList.add("old"), 12000);
}

function newEvents(): void {
  for (const who of ["boat", "ghost"] as const) {
    const r = rep(who);
    if (!r) continue;
    // Only what the picture has got to: the simulator runs ahead of it.
    const evs = r.events.filter((e) => isNotable(e) && e.h <= hour + 1e-6);
    for (const e of evs.slice(shownEvents[who])) {
      const label = who === "boat" ? "You" : "Ghost";
      const text = describeEvent(e, who === "boat" ? "your boat" : "the ghost");
      // The log can name one failure twice (the part, then what it means): one note is enough.
      const key = `${who} ${text}`;
      if (lastNote[key] !== undefined && e.h - lastNote[key] < 6) continue;
      lastNote[key] = e.h;
      note(text, `${label} · Day ${(e.h / 24).toFixed(1)}`, TONE_COLOUR[toneOf(e)]);
      if (who === "boat" && hour - e.h < 3) moment(e);
    }
    shownEvents[who] = evs.length;
  }
}
const lastNote: Record<string, number> = {};

// ---------- "Sound on?" (#334) ----------
// No autoplay, ever; but sound sells the sea, and it's easy to miss the button. So once you
// set sail, ask once. "No thanks" is remembered (the sound module stores it as muted), and the
// question goes away by itself after 20 seconds.
function askSound(): void {
  if (sound.on || sound.muted) return;
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
    sound.alarm();
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
async function sail(kind: "6h" | "day" | "event"): Promise<void> {
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
      note(e ? `Stopped: ${describeEvent(e, "your boat")}` : stopText(stopped, page.status), `Day ${page.status!.day.toFixed(1)}`, TONE_COLOUR.warn);
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
/** The stop conditions armed when the clock started (so "a big battery drop" is measured from then). */
let armed: Record<string, number | boolean> | null = null;
let inFlight: Promise<void> | null = null;
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
  drainRate = drain && rate > 0 ? rate : 0;
  if (r > 0) {
    $("decide").hidden = true;
    $("fcbox").classList.remove("lit");
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
        whenAt(game.status!.day * 24, () => note(`Paused: ${e ? describeEvent(e, "your boat") : stopText(stopped, game.status)}`, d, TONE_COLOUR.warn));
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
function hideKeyHint(): void {
  const k = $("keyhint");
  if (k.hidden || k.classList.contains("gone")) return;
  k.classList.add("gone");
  setTimeout(() => (k.hidden = true), 1000);
}
addEventListener("keydown", (e) => {
  const t = e.target as HTMLElement | null;
  if (!page.ready || page.status?.over || busy || e.ctrlKey || e.metaKey || e.altKey || t?.closest?.("input, select, textarea, summary")) return;
  if (e.code === "Space") {
    if (t?.closest?.("button")) return; // Space presses the focused button instead
    setRate(rate ? 0 : lastRate);
  } else if (SPEED_KEYS[e.code]) setRate(SPEED_KEYS[e.code]);
  else if (e.code === "ArrowLeft" || e.code === "ArrowRight") {
    const now = typeof order === "number" ? order : headingNow();
    void setOrder((Math.round(now / 5) * 5 + (e.code === "ArrowLeft" ? -5 : 5) + 360) % 360);
  } else if (e.code === "ArrowUp" || e.code === "ArrowDown") {
    if (order === "auto") return; // the autopilot sets its own power (#327)
    const p = Math.min(1, Math.max(0, Math.round(power * 20) / 20 + (e.code === "ArrowUp" ? 0.05 : -0.05)));
    $<HTMLInputElement>("power").value = String(Math.round(p * 100));
    void setOrder(order, p);
  } else return;
  e.preventDefault();
  hideKeyHint();
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
  if (mode !== "hands_on" || st.over || shared) return null;
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
  $("r-notes").textContent = bits.join(" ");
  $("result").hidden = false;
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
  const launch = Number($<HTMLSelectElement>("launch").value);
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
    else if (spec === RANDOLPH)
      note(`You have the helm of ${loadMyBoat()?.name ?? "your boat"}. Its wing sail trims itself: pick a heading; time is running (change its speed at the top). Power only matters if you fitted motors in the Boatyard.`, d, TONE_COLOUR.info);
    else if (spec !== KAYAK) note(`You have the helm of the ${spec.name}. The sails look after themselves: pick a heading, and how hard the engine works when the wind dies. Time is running: change its speed at the top.`, d, TONE_COLOUR.info);
    else note("You're under way, at 6 hours a second. Steer with the dial or the arrow keys, and set the power; change the speed or pause at the top.", d, TONE_COLOUR.info);
    // #327: say why an untouched game stays level with the ghost.
    if (!shared && mode === "hands_on" && order === "auto")
      note("For now the autopilot is steering, exactly as it steers the ghost, so change nothing and the two boats stay level. Pick a heading on the dial, or Aim at the finish, to take over.", d, TONE_COLOUR.info);
    if (page.status?.over) await finish();
    // Time runs from the start, at the speed a hop used to play at. A shared game opens
    // paused where it was left; ?clock=paused starts paused (for tests).
    forecastAt = page.status!.day * 24;
    document.body.classList.add("sailing");
    $("loading").hidden = true;
    setRate(shared || params.get("clock") === "paused" || page.status?.over ? 0 : DEFAULT_RATE);
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
$("sevent").addEventListener("click", () => void sail("event"));
$("go").addEventListener("click", () => void begin());
$("send").addEventListener("click", () => void sendOrder());
$("share").addEventListener("click", () => void shareLink());
// The boats you can sail: our kayak, and the stock boats Maya cleared for play.
const BOAT_BLURB: Partial<Record<string, string>> = {
  stock_cruiser31: "a 9.5 m sailing yacht with a keel and a small diesel engine for calms. The sails trim and reef themselves; you steer and say how hard the engine works.",
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
});
const sound = new OceanSound();
filmButtons(cine, sound);
(page as unknown as { cine: Cinema }).cine = cine;

// ---------- frame ----------
const clock = new THREE.Clock();
const bowW = new THREE.Vector3();
let last = 0;
let smoothYaw: number | null = null;
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
const poiCards = new PoiCards();
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
  if (page.ready && game.boat && hour > 0) passes(game.boat, 0, hour - 1e-6, pois, poiSeen);
  poiH = hour;
}
function poisReached(): void {
  if (!page.ready || !game.boat || !pois.length || hour < poiH) return;
  const ps = passes(game.boat, poiH, hour, pois, poiSeen);
  poiH = hour;
  for (const p of ps) poiCards.add(p, `Day ${(p.h / 24).toFixed(1)}`);
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
  const credit = $("landcredit");
  const text = land.credit;
  if (credit.dataset.text !== text) {
    credit.dataset.text = text;
    credit.textContent = text ? `${text} · ` : "";
  }
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
  const wu = r ? valueAt(r, r.wind_u, h) ?? 0 : 3;
  const wv = r ? valueAt(r, r.wind_v, h) ?? 0 : 0;
  sea.setSea(hs, Math.hypot(wu, wv), new THREE.Vector2(wu, -wv));
  sea.update(comps, t);
  const hdg = r ? angleAt(r, r.heading, h) ?? 90 : 90;
  const yaw = THREE.MathUtils.degToRad(90 - hdg);
  if (smoothYaw === null) smoothYaw = yaw;
  const dyaw = Math.atan2(Math.sin(yaw - smoothYaw), Math.cos(yaw - smoothYaw));
  const step = dyaw * Math.min(1, dt * 2.5);
  smoothYaw += step;
  place.yaw = smoothYaw;
  motion.pose.yaw = smoothYaw;
  const off = camera.position.clone().sub(controls.target);
  off.applyAxisAngle(new THREE.Vector3(0, 1, 0), step);
  camera.position.copy(controls.target).add(off);
  // A sailing yacht leans on its sails (the replay's heel); the waves rock it about that.
  motion.heel = r?.heel ? THREE.MathUtils.degToRad(valueAt(r, r.heel, h) ?? 0) : 0;
  motion.advance(comps, t);
  const stw = r ? Math.max(valueAt(r, r.stw, h) ?? 0, 0) : 0;
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
      plan: r ? planAt(r, h) : null,
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
  const [lat, lon] = arrival ?? (r && r.h.length ? positionAt(r, h) : st0 ? [st0.lat, st0.lon] : (SPOT ?? [36.65, -74.94]));
  const ms = r ? utc(r.start) + h * 3600e3 : Date.UTC(2020, 3, 1, 14);
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
  sound.update(dt, { wind: Math.hypot(wu, wv), hs, tp, rain: rain.amount, near: camera.position.distanceTo(controls.target) });
  if (!cine.update(dt)) controls.update();
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
    }
  } else ghostTag.hidden = true;
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
              { rep: game.boat, colours: TRACK.kayak },
              { rep: game.ghost, colours: GHOST },
            ],
        watch === "boat" ? 0 : known ? known.length : 1,
      );
      chartDirty = false;
    }
    chart.draw(page.card ? 1e9 : hour, performance.now());
  }
  $("clock").textContent = r && page.ready ? `Day ${(h / 24).toFixed(1)}` : "";
  page.frames++;
  page.hour = hour;
  page.simHour = shownTo;
});
