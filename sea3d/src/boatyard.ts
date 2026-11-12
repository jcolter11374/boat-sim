// The Boatyard: build your own version of our kayak from the real parts
// catalog, watch the boat change, see the cost, weight and power add up, share
// the design as a link or a file, and launch it.
//
// The catalog (public/parts-catalog.json) is the single source of prices,
// weights and power figures; the yard only adds them up and draws them.
// Launching goes through a Launcher (yard/launch.ts), so the same page works
// with Theo's precomputed grid now and the simulator in the browser later.

import * as THREE from "three";
import { livePicks, partFigure, shownOptions } from "./yard/nomoney";
import { tidyCatalog } from "./yard/words";
import { tierOf, type BoardTiers } from "./yard/tier";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Atmosphere } from "./atmosphere";
import { BUILDERS, loadDetailedModels, type BoatModel } from "./boats/model";
import type { Quality } from "./boats/parts";
import { KAYAK } from "./boats/specs";
import { RANDOLPH_REVB, RANDOLPH_REVC } from "./motion";
import { Contact } from "./contact";
import { BoatMotion, KAYAK_V4 } from "./motion";
import { shadowsOn } from "./ultra";
import { Sea } from "./water";
import { SEA_STATES, components, heightAt, hsOf } from "./waves";
import {
  CRUISE_W,
  decodeDesign,
  designYaml,
  encodeDesign,
  hintsFor,
  nightHours,
  optionOf,
  plannedDesign,
  sailOnly,
  simChoices,
  summarise,
  withSim,
  type SimSlots,
  type Catalog,
  type CatalogOption,
  type CatalogSlot,
  type Design,
} from "./yard/design";
import { BASE_LONG, baseFromHash, randolphCatalog, type BaseKey } from "./yard/bases";
import { Outfit, VIEW_FOR, type View } from "./yard/dress";
import { RandolphDress } from "./yard/dressRandolph";
import { loadMyBoat, myBoatYardLink, onMyBoatChange, saveMyBoat, type MyBoat } from "./myboat";
import { chanceFor, type Chance } from "./yard/chance";
import { OddsModel } from "./yard/estimate";
import { AsBuiltLauncher, GridLauncher, SandboxLauncher, type Launcher, type LaunchOdds, type LaunchReplay, type LaunchResult } from "./yard/launch";

const clock = new THREE.Clock();
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------- 3D: the kayak on a calm sea ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(window.innerWidth, window.innerHeight);
$("app").appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, window.innerWidth / window.innerHeight, 0.05, 12000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 1.8;
controls.maxDistance = 25;
controls.maxPolarAngle = Math.PI * 0.6; // can look under the waterline at the keel
controls.autoRotate = true;
controls.autoRotateSpeed = 0.4;
renderer.domElement.addEventListener("pointerdown", () => (controls.autoRotate = false));
const atmos = new Atmosphere(renderer, scene, camera);
atmos.set(28, 215, 0, true);
// ?quality=low for software graphics (tests); High otherwise.
const quality: Quality = new URLSearchParams(location.search).get("quality") === "low" ? "low" : "high";
renderer.setPixelRatio(quality === "high" ? Math.min(window.devicePixelRatio, 2) : atmos.software ? 0.6 : 1);
atmos.setBloom(quality === "high");
atmos.setPixelRatio(renderer.getPixelRatio());
const sea = new Sea(quality);
scene.add(sea.mesh);
const comps = components(SEA_STATES.calm);
sea.setSea(SEA_STATES.calm.hs);
const place = { x: 0, z: 0, yaw: -0.5 };
let motion = new BoatMotion(KAYAK_V4, place);
/** Which boat the design starts from (share links: #base=revc&...). */
let base: BaseKey = baseFromHash(location.hash);
let rdress: RandolphDress | null = null;
/** Our model is smaller: the camera comes in closer round the Randolph boat. */
const zoom = () => (base === "kayak" ? 1 : 0.5);
let model: BoatModel | null = null;
let contact: Contact | null = null;
let sinkM = 0;
let outfit: Outfit | null = null;
let view: View = "afloat";
let lift = 0; // m the boat is raised in the "lifted out" view
let shapeKayak = true;
const LIFT = 1.35;
function build(): void {
  outfit?.dispose();
  outfit = null;
  rdress?.dispose();
  rdress = null;
  if (model) {
    scene.remove(model.root);
    model.dispose();
  }
  if (contact) {
    scene.remove(contact.collar, contact.spray);
    contact.dispose();
  }
  if (base !== "kayak") {
    // Our model of the Randolph boat (their Rev B and Rev C share a hull shape in our model).
    model = BUILDERS.randolph(quality);
    shadowsOn(model.root);
    scene.add(model.root);
    motion = new BoatMotion(base === "revc" ? RANDOLPH_REVC : RANDOLPH_REVB, place);
    rdress = new RandolphDress(model);
    if (cat) redraw();
    return;
  }
  motion = new BoatMotion(KAYAK_V4, place);
  model = BUILDERS.kayak(quality);
  shadowsOn(model.root);
  contact = new Contact(model.form, KAYAK, quality);
  scene.add(model.root, contact.collar, contact.spray);
  outfit = new Outfit(model);
  outfit.onShapeLoaded = () => cat && redraw();
  outfit.setView(view);
  if (cat) redraw();
}
// Port quarter, a little above the deck: the panels, the dome and the keel all show.
camera.position.set(-4.6, 1.9, 6.6);
controls.target.set(0.1, -0.15, 0);
// Centre the boat in the open space between the two panels.
function frameView(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const left = w > 900 ? 404 : 0;
  const right = w > 900 ? 324 : 0;
  camera.setViewOffset(w, h, (right - left) / 2, 0, w, h);
}
frameView();

// ---------- the catalog and the design ----------
let cat: Catalog | null = null;
let design: Design;
/** The parts catalog per boat (the kayak's from parts-catalog.json; the Randolph boats' from bases.ts). */
const catalogs = new Map<BaseKey, Catalog>();
const grid = new GridLauncher(() => cat);
const asBuilt: Record<"revc" | "revb", AsBuiltLauncher> = {
  revc: new AsBuiltLauncher("Randolph Rev C", BASE_LONG.revc, (d) => isAsBuilt(d), grid, null),
  revb: new AsBuiltLauncher("Randolph Rev B", BASE_LONG.revb, (d) => isAsBuilt(d), grid, "revb"),
};
const isAsBuilt = (d: Design) => !!cat && encodeDesign(cat, d) === "";
const sandbox = new SandboxLauncher(grid, undefined, () => (cat ? plannedDesign(cat) : null));
const sandboxReady = sandbox.available();
let launching = false;
let chanceTurn = 0; // the latest "chance of finishing" lookup (a part changed since: drop the older)
let planned: LaunchResult | null = null;
const plannedRuns = new Map<string, LaunchResult>(); // per back end

/** Slots by theme, in the order a builder thinks about them. Unknown slots go at the end. */
const GROUPS: [string, string[]][] = [
  ["Driving", ["thr", "drive", "rudder"]],
  ["Power", ["sol", "rsol", "bat", "rbat", "mppt"]],
  ["Brains and radio", ["brain", "sat", "beacon", "tracker"]],
  ["Being seen by ships", ["ais", "radar", "light"]],
  ["Hull and keel", ["lead", "keel", "paint"]],
  ["Before launch", ["spares"]],
];

const status = {
  ready: false,
  error: "",
  design: {} as Design,
  summary: {} as Record<string, unknown>,
  dressed: {} as Record<string, unknown>,
  share: "",
  /** The odds "Your build" shows (#315). */
  chance: null as Chance | null,
  /** The player's saved boat ("my boat"), as this page last drew it. */
  mine: null as MyBoat | null,
  yaml: "",
  launch: null as unknown,
  launchError: "",
  planned: null as unknown,
  backend: "",
  frames: 0,
  view: "afloat" as View,
  lift: 0,
  setView: (v: View) => setView(v),
  /** Where the named parts are, for tests: world bounding boxes. */
  debug: () => {
    const out: Record<string, unknown> = {};
    model?.root.updateMatrixWorld(true);
    for (const n of ["hull", "bulb", "keel", "yard_bat", "thruster_port"]) {
      const o = model?.root.getObjectByName(n);
      if (!o) continue;
      const bx = new THREE.Box3().setFromObject(o);
      const mm = (o as THREE.Mesh).material as THREE.Material | undefined;
      if (mm && "opacity" in mm) out[n + "_mat"] = [mm.type, mm.opacity, mm.transparent];
      out[n] = { min: bx.min.toArray().map((v) => +v.toFixed(2)), max: bx.max.toArray().map((v) => +v.toFixed(2)), visible: o.visible };
    }
    return out;
  },
  /** Choose an option in a slot (tests). */
  pick: (slot: string, id: string) => choose(slot, id),
  /** The boat the design starts from, and switching it (tests). */
  base: base as BaseKey,
  setBase: (b: BaseKey) => setBase(b),
};
(window as unknown as { __yard: typeof status }).__yard = status;

function optionButton(slot: CatalogSlot, o: CatalogOption): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "opt";
  b.dataset.slot = slot.id;
  b.dataset.opt = o.id;
  const top = document.createElement("div");
  top.className = "top";
  const name = document.createElement("span");
  name.textContent = o.n;
  // Tags in a player's words (Leo, audit item 10): the planned part, quietly. No prices
  // (John: no money in the game); estimates show as "~" before the part's figure.
  if (o.def) name.append(badge("plan", base === "kayak" ? "Planned" : "As built", base === "kayak" ? "The part on our kayak" : "The part on their boat"));
  // What this part would do to the odds, filled in by drawChance (Leo: see which swap is worth trying).
  const delta = document.createElement("span");
  delta.className = "delta";
  name.append(delta);
  const fig = document.createElement("span");
  fig.className = "price figure";
  fig.textContent = partFigure(slot, o);
  if (o.est && fig.textContent) fig.title = "Our estimate: nobody has measured this yet.";
  top.append(name, fig);
  const d = document.createElement("div");
  d.className = "d";
  d.textContent = o.d;
  // The longer story stays one hover away (Milo: the Rev C5 wing was a 9-line history).
  if (o.more) d.append(" ", Object.assign(document.createElement("span"), { className: "info", textContent: "i", title: o.more }));
  b.append(top, d);
  b.addEventListener("click", () => choose(slot.id, o.id));
  return b;
}
function badge(kind: string, text: string, title = ""): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `badge ${kind}`;
  s.textContent = text;
  if (title) s.title = title;
  return s;
}

function drawSlots(): void {
  if (!cat) return;
  const box = $("slots");
  box.replaceChildren();
  const used = new Set<string>();
  const groups = GROUPS.map(([title, ids]) => [title, ids.filter((id) => cat!.slots.some((s) => s.id === id))] as [string, string[]]);
  const rest = cat.slots.map((s) => s.id).filter((id) => !GROUPS.some(([, ids]) => ids.includes(id)));
  if (rest.length) groups.push(["Other", rest]);
  for (const [title, ids] of groups) {
    const g = document.createElement("div");
    g.className = "slot";
    const h = document.createElement("h3");
    h.textContent = title;
    g.append(h);
    if (title === "Driving") g.append(cruiseControl());
    for (const id of ids) {
      const slot = cat.slots.find((s) => s.id === id)!;
      used.add(id);
      const name = document.createElement("div");
      name.className = "muted";
      name.style.margin = "6px 2px 4px";
      name.textContent = slot.name;
      g.append(name);
      const shown = shownOptions(slot);
      if (!shown.length) {
        name.remove();
        continue;
      }
      for (const o of shown) g.append(optionButton(slot, o));
      const hints = document.createElement("ul");
      hints.className = "hints";
      hints.id = `hints-${slot.id}`;
      g.append(hints);
    }
    box.append(g);
  }
}

function cruiseControl(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.id = "cruise-wrap";
  const label = document.createElement("div");
  label.className = "muted";
  label.style.margin = "2px 2px 4px";
  label.id = "cruise-label";
  const input = document.createElement("input");
  input.type = "range";
  input.id = "cruise";
  input.min = "0";
  input.max = String(CRUISE_W.length - 1);
  input.step = "1";
  input.addEventListener("input", () => {
    design.cruiseW = CRUISE_W[Number(input.value)];
    redraw();
  });
  const note = document.createElement("div");
  note.className = "muted";
  note.textContent = "More power is faster but empties the battery sooner at night. The planned setting is 25 W.";
  wrap.append(label, input, note);
  return wrap;
}

function choose(slot: string, id: string): void {
  if (!cat || !cat.slots.some((s) => s.id === slot && s.opts.some((o) => o.id === id))) return;
  const changed = design.picks[slot] !== id;
  design.picks[slot] = id;
  redraw();
  if (changed) {
    // Show the swap: the view that shows that part best, and a flash on it.
    // (Taking the AIS out shows best on deck: its aerial goes.)
    if (base !== "kayak") setView(slot === "rudder" || slot === "keel" || (slot === "drive" && id !== "wing") ? "lifted" : "afloat");
    else setView(id === "none" && slot === "ais" ? "afloat" : (VIEW_FOR[slot] ?? "afloat"));
    outfit?.pulse(slot, clock.getElapsedTime());
  }
}

// Camera framings for each view (boat frame is world here: the boat sits at the origin).
const FRAMES: Record<View, { pos: [number, number, number]; target: [number, number, number] }> = {
  afloat: { pos: [-4.6, 1.9, 6.6], target: [0.1, -0.15, 0] },
  inside: { pos: [-1.9, 3.0, 3.0], target: [0.15, 0.25, 0] },
  lifted: { pos: [-4.3, 1.0, 6.0], target: [0.15, 0.55, 0] },
};
// The Randolph boat is half the length but its wing stands 1.3 m up: closer in, aimed higher.
const R_FRAMES: Record<View, { pos: [number, number, number]; target: [number, number, number] }> = {
  afloat: { pos: [-3.0, 1.3, 4.2], target: [0.0, 0.35, 0] },
  inside: { pos: [-3.0, 1.3, 4.2], target: [0.0, 0.35, 0] },
  lifted: { pos: [-3.0, 1.0, 4.2], target: [0.0, 0.55, 0] },
};
/** A view's camera spot for the boat on show. */
const frameOf = (v: View) => (base === "kayak" ? FRAMES : R_FRAMES)[v];
const frameTarget = (v: View) => new THREE.Vector3(...frameOf(v).target);
const framePos = (v: View) => new THREE.Vector3(...frameOf(v).pos);
camera.position.copy(framePos("afloat"));
controls.target.copy(frameTarget("afloat"));
let fly: { p0: THREE.Vector3; p1: THREE.Vector3; t0: THREE.Vector3; t1: THREE.Vector3; k: number } | null = null;
function setView(v: View): void {
  if (v !== view) {
    fly = { p0: camera.position.clone(), p1: framePos(v), t0: controls.target.clone(), t1: frameTarget(v), k: 0 };
    controls.autoRotate = false;
  }
  view = v;
  outfit?.setView(v);
  status.view = v;
  document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
}
document.querySelectorAll<HTMLButtonElement>("#views button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view as View)));

function redraw(): void {
  if (!cat) return;
  const s = summarise(cat, design);
  const plan = plannedDesign(cat);
  // Buttons and hints (each slot: what your choice changes against the planned build).
  document.querySelectorAll<HTMLButtonElement>(".opt").forEach((b) =>
    b.setAttribute("aria-pressed", String(design.picks[b.dataset.slot!] === b.dataset.opt)),
  );
  for (const slot of cat.slots) {
    const ul = document.getElementById(`hints-${slot.id}`);
    if (!ul) continue;
    const hints = hintsFor(optionOf(cat, slot.id, plan), optionOf(cat, slot.id, design)!, cat.mmPerKg);
    ul.replaceChildren(...hints.map((h) => Object.assign(document.createElement("li"), { textContent: h })));
  }
  const cr = $<HTMLInputElement>("cruise");
  const sail = sailOnly(design);
  if (cr) {
    cr.value = String(CRUISE_W.indexOf(design.cruiseW));
    cr.disabled = sail;
  }
  // Their boat as built has no motor at all: no cruise setting to show.
  const cw = document.getElementById("cruise-wrap");
  if (cw) cw.hidden = sail && base !== "kayak";
  const cl = document.getElementById("cruise-label");
  if (cl)
    cl.textContent = sail
      ? base === "kayak"
        ? "Cruising power: no motors with the wing sail only"
        : "Cruising power: no motor, the wing sails it"
      : `Cruising power: ${design.cruiseW} W while motoring`;
  // With the wing sail only, the motor choices don't apply: grey them.
  document.querySelectorAll<HTMLButtonElement>('.opt[data-slot="thr"]').forEach((b) => {
    b.classList.toggle("na", sail);
    b.title = sail ? "Doesn't apply: the wing sail only build has no motors" : "";
  });
  // Totals.
  $("s-kg").textContent = `${s.massKg.toFixed(1)} kg`;
  $("s-sol").textContent = `${s.solarW} W`;
  $("s-bat").textContent = `${s.batteryWh.toLocaleString("en-US")} Wh`;
  $("s-night").textContent = `about ${Math.round(nightHours(s))} h`;
  $("s-est").textContent = s.estimates.length ? `~ Includes our estimates for: ${s.estimates.join(", ")}.` : "";
  void drawChance();
  // The model.
  if (outfit && base === "kayak") {
    const lead = optionOf(cat, "lead", design);
    const d = outfit.apply(design.picks, s, 50 + (lead?.kg ?? 0));
    sinkM = d.sinkMm / 1000;
    shapeKayak = d.shape === "kayak";
    status.dressed = { ...d };
  } else if (rdress) {
    const d = rdress.apply(design.picks);
    // Heavier sits lower: their waterplane is small, so a couple of kilos shows.
    sinkM = ((s.massKg - (cat.plannedKg ?? s.massKg)) * (cat.mmPerKg ?? 0)) / 1000;
    shapeKayak = false;
    status.dressed = { ...d, sinkMm: Math.round(sinkM * 1000) };
  }
  // Link and file.
  const parts = encodeDesign(cat, design);
  const hash = base === "kayak" ? parts : `#base=${base}${parts ? "&" + parts.slice(1) : ""}`;
  history.replaceState(null, "", location.pathname + location.search + hash);
  status.design = JSON.parse(JSON.stringify(design));
  status.summary = { ...s };
  status.share = hash;
  $("result").replaceChildren();
  drawMine();
}

// ---------- chance of finishing (#315 item 12) ----------
/** "Your build": the grid's odds when this design is a tested build, else "not tested yet". */
async function drawChance(): Promise<void> {
  if (!cat) return;
  const turn = ++chanceTurn;
  const [n, src, model] = await Promise.all([grid.nearest(design), grid.source(), oddsModel()]);
  if (turn !== chanceTurn) return; // the player has changed a part since
  const c = chanceFor(n, src ?? null);
  const e = model?.odds(design) ?? null;
  const v = $("s-odds");
  const was = shownBase === base ? shownOdds : null; // no flash when switching boats
  shownOdds = e?.p ?? null;
  shownBase = base;
  // Tested: the grid's own figure. Untested: the quick estimate, said so (estimate.ts).
  // The comparison as two odds side by side, not "points" (Leo): "Our kayak: 78%."
  const vsWhat = base === "kayak" ? "our kayak" : `${SHORT[base]} as built`;
  const vs =
    e?.p != null && !(e.tested && e.p === e.planned)
      ? Math.abs(Math.round((e.p - e.planned) * 100)) < NOISE_PTS
        ? ` About the same as ${vsWhat}.`
        : ` ${vsWhat[0].toUpperCase()}${vsWhat.slice(1)}: ${Math.round(e.planned * 100)}%.`
      : "";
  if (c.tested || !e || e.p === null) {
    v.textContent = c.value;
    const note = $("s-odds-note");
    note.textContent =
      e && e.p === null && e.missing ? `No estimate yet: "${e.missing}" hasn't been tested. Press "Test it" to find out.` : `${c.note}${vs}`;
    // One sentence from one source on both pages (Milo M4): which launches, behind the "i".
    if (c.about) note.append(" ", Object.assign(document.createElement("span"), { className: "info", textContent: "i", tabIndex: 0, title: c.about, role: "note", ariaLabel: c.about }));
  } else {
    v.textContent = `about ${Math.round(e.p * 100)}%`;
    $("s-odds-note").textContent = `Quick estimate from builds we've tested.${vs} Press "Test it" to sail it for real.`;
  }
  v.classList.toggle("untested", !c.tested && (!e || e.p === null));
  v.classList.toggle("estimate", !c.tested && !!e && e.p !== null);
  // Green only for the leaderboard's Best group; Long shot in amber; anything else plain (Milo).
  v.dataset.tier = c.tested && n?.exact ? tierOf(boardTiers, n.build.id) : "";
  // A short flash when the figure moves: green up, red down (Leo).
  v.classList.remove("up", "down");
  if (was !== null && shownOdds !== null && Math.round(was * 100) !== Math.round(shownOdds * 100)) {
    void v.offsetWidth; // restart the animation
    v.classList.add(shownOdds > was ? "up" : "down");
  }
  status.chance = { ...c, estimate: e?.p ?? null } as Chance;
  drawDeltas(model);
  $("legend").hidden = !model;
}
let shownOdds: number | null = null;
/** The leaderboard's groups by build id, once loaded (the odds colour follows them). */
let boardTiers: BoardTiers | null = null;
fetch("./leaderboard/board.json")
  .then((r) => (r.ok ? r.json() : null))
  .then((b) => {
    boardTiers = b?.summary?.rows ? new Map(b.summary.rows.map((r: { design: string; tier: number }) => [r.design, r.tier])) : null;
    if (boardTiers) redraw();
  })
  .catch(() => null);
let shownBase = "";
// Under 3 points is inside the grid's own noise (100 launches a build), so it reads
// "about the same" rather than suggesting, say, that dropping the AIS helps (Ravi's rule on #323).
const NOISE_PTS = 3;
const modelFor = new Map<BaseKey, OddsModel>();
/** The quick-estimate model for the boat on show (null without the grid). */
async function oddsModel(): Promise<OddsModel | null> {
  const builds = await grid.all();
  if (!cat || !builds.length) return null;
  let m = modelFor.get(base);
  if (!m) modelFor.set(base, (m = new OddsModel(cat, builds)));
  return m;
}
/** Each part's effect on the odds if you picked it now: "+6", "−24", "no data yet". */
function drawDeltas(model: OddsModel | null): void {
  const here = model?.odds(design)?.p ?? null;
  document.querySelectorAll<HTMLButtonElement>(".opt").forEach((b) => {
    const span = b.querySelector<HTMLSpanElement>(".delta");
    if (!span) return;
    const slot = b.dataset.slot!;
    const opt = b.dataset.opt!;
    let text = "";
    let cls = "delta";
    if (model && here !== null && design.picks[slot] !== opt && !b.classList.contains("na")) {
      const p = model.odds({ ...design, picks: { ...design.picks, [slot]: opt } })?.p ?? null;
      if (p === null) [text, cls] = ["no data yet", "delta none"];
      else {
        const n = Math.round((p - here) * 100);
        [text, cls] = Math.abs(n) < NOISE_PTS ? ["about the same", "delta same"] : [`${n > 0 ? "+" : "−"}${Math.abs(n)}`, n > 0 ? "delta up" : "delta down"];
      }
    }
    span.textContent = text;
    span.className = cls;
    span.title = text && text !== "no data yet" ? "Change in the odds if you pick this part (quick estimate)" : "";
  });
}
// What "Test it" does, on the button (#315 item 13): the simulator in this browser
// sails six spring 2020 launches (and our kayak's, to compare), a few minutes on a
// slow computer; without it, the page shows the precomputed voyages at once.
void sandboxReady.then((inBrowser) => {
  $("launch").textContent = inBrowser ? "Test it: sail 6 launches (a few minutes)" : "Test it: see its simulated voyages";
  $("launch").title = inBrowser
    ? "The autopilot sails your design from 6 real spring 2020 start dates, in this browser, and sails the boat you started from on the same dates to compare"
    : "Shows the voyages our servers sailed for the closest tested build";
});

// ---------- my boat (remembered in this browser, carried to the other pages) ----------
const SHORT: Record<BaseKey, string> = { kayak: "kayak", revc: "Rev C5", revb: "Rev B" };
let nameTyped = false; // the player has typed a name: keep it while they change parts
const defaultName = () => `My ${SHORT[base]}`;
function drawMine(): void {
  const mine = loadMyBoat();
  status.mine = mine;
  const here = !!mine && mine.kind === "yard" && mine.hash === status.share;
  const input = $<HTMLInputElement>("mb-name");
  if (!nameTyped) input.value = here ? mine.name : defaultName();
  $("mb-save").textContent = here ? (input.value.trim() === mine.name ? "Saved" : "Rename my boat") : mine ? "Make this my boat" : "Save as my boat";
  // The name is the player's own text: textContent only, never innerHTML.
  const line = $("mb-line");
  line.replaceChildren();
  if (!mine) line.textContent = "Save it to take it to the other pages: the helm, the race and the voyage.";
  else if (here) line.textContent = "This design is your boat. It's remembered in this browser.";
  else if (mine.kind === "yard") {
    const a = Object.assign(document.createElement("a"), { href: myBoatYardLink(mine), textContent: mine.name });
    line.append("Your boat now: ", a, ". Saving this design replaces it.");
  } else line.append(`Your boat now: ${mine.name} (a stock boat). Saving this design replaces it.`);
}
function saveMine(): void {
  if (!cat) return;
  const name = $<HTMLInputElement>("mb-name").value.trim().slice(0, 40) || defaultName();
  saveMyBoat({ kind: "yard", base, hash: status.share, name, choices: simChoices(design, plannedDesign(cat)) });
  nameTyped = false;
  toast(`Saved "${name}" as your boat, in this browser.`);
}
$("mb-save").addEventListener("click", saveMine);
$<HTMLInputElement>("mb-name").addEventListener("input", () => {
  nameTyped = true;
  drawMine();
});
$<HTMLInputElement>("mb-name").addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveMine();
});
onMyBoatChange(() => cat && drawMine());
// "Your boat now" links here with a new hash: open that design without a reload.
window.addEventListener("hashchange", () => {
  const b = baseFromHash(location.hash);
  if (!catalogs.has(b)) return;
  if (b !== base) {
    base = b;
    if (view === "inside" && b !== "kayak") view = "afloat";
    build();
    fly = { p0: camera.position.clone(), p1: framePos(view), t0: controls.target.clone(), t1: frameTarget(view), k: 0 };
  }
  useBase(location.hash);
  setView(view);
});

// ---------- the boat to start from ----------
const INTRO: Record<BaseKey, string> = {
  kayak: "Build your own version of our kayak. Swap a part and watch the boat and its odds of finishing change.",
  revc: "Our model of the Randolph team's Rev C5: a 1.5 m self-righting boat with a rigid wing sail and two rudders. Swap a part and watch its odds change.",
  revb: "Our model of the Randolph team's earlier Rev B: the same wing sail, one rudder and an 8.2 kg keel.",
};
/** Behind the intro's "i" (Leo): where the parts come from. No prices (John: no money in the game). */
const INTRO_NOTE: Record<BaseKey, string> = {
  kayak: "The parts are real ones you can buy. A ~ before a number means it's our estimate: nobody has weighed or measured it yet.",
  revc: "Built from their published build plan (11 Nov 2026), not their own simulator. ~ marks our estimates.",
  revb: "Built from their published build plan (11 Nov 2026), not their own simulator. ~ marks our estimates.",
};
/** Switch the page to a boat's catalog and the design in the hash (or its as-built design). */
function useBase(hash: string): void {
  const c = catalogs.get(base);
  if (!c) return;
  cat = c;
  design = decodeDesign(c, hash);
  design.picks = livePicks(c.slots, design.picks); // hidden parts sail like the planned one
  status.base = base;
  const intro = $("intro");
  intro.textContent = `${INTRO[base]} `;
  const i = Object.assign(document.createElement("span"), { className: "info", textContent: "i", tabIndex: 0, title: INTRO_NOTE[base] });
  i.setAttribute("role", "note");
  i.setAttribute("aria-label", INTRO_NOTE[base]);
  intro.append(i);
  const credit = $("credit");
  credit.replaceChildren();
  if (c.credit) {
    credit.append(`${c.credit.text} `, Object.assign(document.createElement("a"), { href: c.credit.url, target: "_blank", rel: "noopener", textContent: "Their repository" }));
  }
  $("reset").textContent = base === "kayak" ? "Start again from our kayak" : `Start again from ${SHORT[base]}`;
  // The Randolph boat has no "see inside" yet (our model has no cut-away).
  const inside = document.querySelector<HTMLButtonElement>('#views button[data-view="inside"]');
  if (inside) inside.hidden = base !== "kayak";
  document.querySelectorAll<HTMLButtonElement>("#bases button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.base === base)));
  drawSlots();
  redraw();
}
function setBase(b: BaseKey): void {
  if (b === base || !catalogs.has(b)) return;
  base = b;
  if (view === "inside" && b !== "kayak") view = "afloat";
  build();
  useBase("");
  fly = { p0: camera.position.clone(), p1: framePos(view), t0: controls.target.clone(), t1: frameTarget(view), k: 0 };
  setView(view);
}
document.querySelectorAll<HTMLButtonElement>("#bases button").forEach((b) => b.addEventListener("click", () => setBase(b.dataset.base as BaseKey)));

// ---------- buttons ----------
function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}
$("share").addEventListener("click", async () => {
  const url = location.href;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied: anyone who opens it sees this design.");
  } catch {
    toast(url);
  }
});
$("yaml").addEventListener("click", () => {
  if (!cat) return;
  const text = designYaml(cat, design);
  status.yaml = text;
  const a = document.createElement("a");
  a.download = "boatyard-design.yaml";
  a.href = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  document.body.append(a);
  a.click();
  a.remove();
});
$("reset").addEventListener("click", () => {
  if (!cat) return;
  design = plannedDesign(cat);
  redraw();
});
$("launch").addEventListener("click", async () => {
  if (!cat || launching) return;
  const box = $("result");
  const btn = $<HTMLButtonElement>("launch");
  // A clock beside the status, so a long run in the browser never looks frozen.
  const t0 = Date.now();
  let line = "";
  const draw = () => {
    const s = Math.round((Date.now() - t0) / 1000);
    const clock = s >= 3 ? ` (${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} so far)` : "";
    box.replaceChildren(Object.assign(document.createElement("div"), { className: "muted", textContent: line + clock }));
  };
  const say = (text: string) => {
    line = text;
    draw();
  };
  const tick = setInterval(draw, 1000);
  say("Testing...");
  launching = true;
  btn.disabled = true;
  let r: LaunchResult | null = null;
  try {
    // The real simulator in the browser when the page has its files; else the precomputed grid.
    // The Randolph boats sail the same way (Theo's #187); if neither has their builds yet,
    // their voyages as built, said plainly.
    const useSandbox = await sandboxReady;
    let launcher: Launcher = useSandbox ? sandbox : grid;
    // Plain words: the autopilot sails the design, once per real 2020 start date.
    const onProgress = (text: string, done: number, total: number) =>
      say(done ? `The autopilot is sailing your design from ${total} real 2020 start dates: ${done} done so far.` : `${text} This takes a minute or two.`);
    r = await launcher.launch(design, summarise(cat, design), onProgress);
    if (!r && base !== "kayak") {
      launcher = asBuilt[base];
      r = await launcher.launch(design, summarise(cat, design), onProgress);
    }
    status.backend = launcher.name;
    // The planned (or as-built) build on the same launches, to compare with (once per back end and boat).
    if (r && launcher !== asBuilt.revc && launcher !== asBuilt.revb && encodeDesign(cat, design) !== "") {
      const plan = plannedDesign(cat);
      const key = `${launcher.name}|${base}`;
      let p = plannedRuns.get(key);
      if (!p) {
        p = (await launcher.launch(plan, summarise(cat, plan), (text, done, total) => {
          const who = base === "kayak" ? "the planned build" : "the boat as built";
          say(`Now the autopilot sails ${who} from the same dates, to compare${done ? `: ${done} of ${total} done` : ""}.`);
        })) ?? undefined;
        if (p) plannedRuns.set(key, p);
      }
      planned = p ?? null;
    } else planned = null;
  } catch (e) {
    say(`The test failed: ${e instanceof Error ? e.message : e}`);
    status.launchError = String(e);
    return;
  } finally {
    clearInterval(tick);
    launching = false;
    btn.disabled = false;
  }
  status.launch = r;
  status.planned = planned;
  showResult(box, r, planned);
});

/** One launch's ending in a few words. */
const ending = (rp: LaunchReplay | undefined) =>
  !rp ? "-" : rp.outcome === "arrived" ? `finished in ${Math.round(rp.days)} d` : rp.outcome.replace(/_/g, " ");
const dayOf = (start: string) =>
  new Date(start + (/Z|[+-]\d\d:?\d\d$/.test(start) ? "" : "Z")).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const replayLink = (rp: LaunchReplay, text: string) =>
  Object.assign(document.createElement("a"), {
    // Absolute, so the voyage page can fetch it (blob: URLs only work in this browser session).
    href: `./voyage.html?replay=${encodeURIComponent(new URL(rp.url, location.href).href)}`,
    target: "_blank",
    textContent: text,
  });
const oddsText = (o: LaunchOdds) => `${Math.round(o.odds * 100)}%`;
const rangeText = (o: LaunchOdds) =>
  `likely ${Math.round(o.low95 * 100)}–${Math.round(o.high95 * 100)}%` + (o.median_days ? `, typically ${Math.round(o.median_days)} days` : "");

/** Planned build and yours side by side: the odds, then the same launches row by row (Maya). */
function showCompare(box: HTMLElement, r: LaunchResult, p: LaunchResult): void {
  const grid = document.createElement("div");
  grid.className = "vs";
  for (const [who, res] of [[base === "kayak" ? "Planned build" : "As built", p], ["Your build", r]] as const) {
    const col = document.createElement("div");
    col.append(
      Object.assign(document.createElement("div"), { className: "muted", textContent: who }),
      Object.assign(document.createElement("div"), { className: "odds", textContent: res.odds ? oddsText(res.odds) : "?" }),
      Object.assign(document.createElement("div"), { className: "muted", textContent: res.odds ? rangeText(res.odds) : "no odds for this build yet" }),
    );
    grid.append(col);
  }
  box.append(grid);
  const starts = [...new Set([...p.replays, ...r.replays].map((x) => x.start))].sort();
  if (!starts.length) return;
  box.append(
    Object.assign(document.createElement("p"), {
      className: "muted",
      textContent: `The same ${starts.length} launches, both builds. ${starts.length < 10 ? `${starts.length} voyages is a small sample; the odds line is the better guide.` : ""}`,
    }),
  );
  const t = document.createElement("table");
  t.className = "pairs";
  const head = t.insertRow();
  const years = [...new Set(starts.map((x) => x.slice(0, 4)))];
  for (const h of [`Launch${years.length === 1 ? ` (${years[0]})` : ""}`, base === "kayak" ? "Planned" : "As built", "Yours"]) head.append(Object.assign(document.createElement("th"), { textContent: h }));
  for (const st of starts) {
    const a = p.replays.find((x) => x.start === st);
    const b = r.replays.find((x) => x.start === st);
    const row = t.insertRow();
    row.insertCell().textContent = years.length === 1 ? dayOf(st).replace(/ \d{4}$/, "") : dayOf(st);
    for (const rp of [a, b]) {
      const c = row.insertCell();
      if (rp) c.append(replayLink(rp, ending(rp)));
      else c.textContent = "-";
      if (rp?.outcome === "arrived") c.className = "ok";
    }
    // Better, worse or the same, in a word.
    const score = (x?: LaunchReplay) => (x?.outcome === "arrived" ? 1000 - x.days : -1);
    if (a && b && score(a) !== score(b)) row.className = score(b) > score(a) ? "better" : "worse";
  }
  box.append(t);
}

/** Said wherever a number comes from the simulator in this browser (#335). */
const BROWSER_WEATHER_NOTE = "Sailed in your browser on lighter weather data, so on a long voyage it can differ by days from the full-data voyage replays and leaderboard.";
const SIMPLIFIED_BACKEND = "simulator in the browser";

function showResult(box: HTMLElement, r: LaunchResult | null, p: LaunchResult | null = null): void {
  box.replaceChildren();
  if (!r) {
    box.append(
      Object.assign(document.createElement("p"), {
        className: "muted",
        textContent:
          "Launch results aren't published yet: Theo is running every combination through the simulator. Until then, share the link or download the design file.",
      }),
    );
    return;
  }
  if (p) showCompare(box, r, p);
  else if (r.odds) {
    const o = r.odds;
    const big = Object.assign(document.createElement("div"), { className: "odds", textContent: `${Math.round(o.odds * 100)}% finish` });
    const range = Object.assign(document.createElement("div"), {
      className: "muted",
      textContent: `${o.finished} of ${o.voyages} simulated voyages (likely range ${Math.round(o.low95 * 100)}–${Math.round(o.high95 * 100)}%)` +
        (o.median_days ? `, typically ${Math.round(o.median_days)} days` : ""),
    });
    box.append(big, range);
  }
  box.append(Object.assign(document.createElement("p"), { className: "muted", textContent: r.note }));
  if (r.credits) {
    const p = Object.assign(document.createElement("p"), { className: "muted credits", textContent: `${r.credits.text} ` });
    const a = Object.assign(document.createElement("a"), { href: r.credits.url, target: "_blank", rel: "noopener", textContent: "Sources" });
    p.append(a);
    box.append(p);
  }
  if (r.replays.length && !p) {
    const ul = document.createElement("ul");
    for (const rp of r.replays) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      // Absolute, so the voyage page can fetch it (blob: URLs only work in this browser session).
      a.href = `./voyage.html?replay=${encodeURIComponent(new URL(rp.url, location.href).href)}`;
      a.target = "_blank";
      const when = new Date(rp.start + (/Z|[+-]\d\d:?\d\d$/.test(rp.start) ? "" : "Z"));
      a.textContent = `Watch the ${when.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" })} launch`;
      const how = Object.assign(document.createElement("span"), {
        className: "muted",
        textContent: rp.outcome === "arrived" ? ` (finished, ${Math.round(rp.days)} days)` : ` (${rp.outcome.replace(/_/g, " ")})`,
      });
      li.append(a, how);
      ul.append(li);
    }
    box.append(ul);
    // #335, beside the day counts it explains: the browser sails on a lighter weather
    // file than the full runs behind the voyage replays and the leaderboard.
    if (status.backend === SIMPLIFIED_BACKEND) box.append(Object.assign(document.createElement("p"), { className: "muted", textContent: BROWSER_WEATHER_NOTE }));
  }
  if (r.fingerprints?.length) {
    // Ravi's gate: these must match reference.json exactly (python -m boatsim.sandbox compare ... --exact).
    const b = Object.assign(document.createElement("button"), { textContent: "Download results (JSON)" });
    b.title = "Each launch's result in the simulator's reference format, for checking the browser against the real thing";
    b.addEventListener("click", () => {
      const a = document.createElement("a");
      a.download = "boatyard-results.json";
      a.href = URL.createObjectURL(new Blob([JSON.stringify(r.fingerprints, null, 1)], { type: "application/json" }));
      document.body.append(a);
      a.click();
      a.remove();
    });
    box.append(b);
  }
}

// Names on the parts inside, in the "see inside" view.
function drawLabels(): void {
  const a = outfit?.insideBlend ?? 0;
  labelBox.style.opacity = String(a);
  if (a < 0.02 || !outfit) {
    if (labelBox.childElementCount) labelBox.replaceChildren();
    return;
  }
  const shown = outfit.labels.filter((l) => {
    let v = true;
    l.obj.traverseAncestors((p) => (v &&= p.visible));
    return v && l.obj.visible;
  });
  while (labelBox.childElementCount < shown.length) labelBox.append(document.createElement("div"));
  while (labelBox.childElementCount > shown.length) labelBox.lastElementChild!.remove();
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  // Place each name over its part, nudged up past any name already placed there.
  const placed: [number, number, number, number][] = [];
  const spots = shown.map((l) => {
    l.obj.getWorldPosition(labelP).project(camera);
    return { l, x: ((labelP.x + 1) / 2) * w, y: ((1 - labelP.y) / 2) * h };
  });
  spots.sort((a, b) => b.y - a.y);
  spots.forEach(({ l, x, y }, i) => {
    const el = labelBox.children[i] as HTMLElement;
    if (el.textContent !== l.text) el.textContent = l.text;
    const half = 3.4 * l.text.length + 8;
    let top = y - 30;
    for (let k = 0; k < 12; k++) {
      const hit = placed.find(([x0, x1, y0, y1]) => x - half < x1 && x + half > x0 && top < y1 && top + 20 > y0);
      if (!hit) break;
      top = hit[2] - 22;
    }
    placed.push([x - half, x + half, top, top + 20]);
    el.style.transform = `translate(${x}px, ${top}px) translate(-50%, 0)`;
  });
}

// ---------- start ----------
build();
loadDetailedModels().then((ok) => {
  if (ok) build();
});
Promise.all([
  fetch("./parts-catalog.json").then((r) => {
    if (!r.ok) throw new Error(`parts-catalog.json: ${r.status}`);
    return r.json() as Promise<Catalog>;
  }),
  // The simulator's notes per option (what it models); optional.
  fetch("./sim-slots.json")
    .then((r) => (r.ok ? (r.json() as Promise<SimSlots>) : null))
    .catch(() => null),
])
  .then(([catalog, sim]) => {
    const c = withSim(catalog, sim);
    catalogs.set("kayak", tidyCatalog(c));
    for (const k of ["revc", "revb"] as const) {
      const rc = randolphCatalog(k, sim, c);
      if (rc) catalogs.set(k, tidyCatalog(rc));
    }
    // Only offer the boats the slot table has.
    document.querySelectorAll<HTMLButtonElement>("#bases button").forEach((b) => (b.hidden = !catalogs.has(b.dataset.base as BaseKey)));
    if (!catalogs.has(base)) base = "kayak";
    useBase(location.hash);
    status.ready = true;
  })
  .catch((e) => {
    status.error = String(e);
    const box = $("error");
    box.style.display = "block";
    box.textContent = `Couldn't load the parts catalog: ${e}`;
  });
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  frameView();
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  atmos.setSize(window.innerWidth, window.innerHeight);
});

const bowW = new THREE.Vector3();
const labelP = new THREE.Vector3();
const labelBox = $("labels");
let lastT = 0;
renderer.setAnimationLoop(() => {
  const t = clock.getElapsedTime();
  const dt = Math.min(t - lastT, 0.3);
  lastT = t;
  // Lifted out: the boat rises clear of the water (and the camera's aim with it), and hangs still.
  // (See inside lifts it a little too, so the parts below the waterline show.)
  const wantLift = (view === "lifted" ? LIFT : view === "inside" ? 0.45 : 0) * zoom();
  lift += Math.sign(wantLift - lift) * Math.min(Math.abs(wantLift - lift), dt * 2.2);
  status.lift = lift;
  if (fly) {
    // Glide the camera to the view's framing; the user can orbit from there.
    fly.k = Math.min(1, fly.k + dt / 1.2);
    const e = fly.k * fly.k * (3 - 2 * fly.k);
    camera.position.lerpVectors(fly.p0, fly.p1, e);
    controls.target.lerpVectors(fly.t0, fly.t1, e);
    if (fly.k >= 1) fly = null;
  }
  const still = 1 - lift / (LIFT * zoom());
  sea.update(comps, t);
  motion.advance(comps, t);
  if (model) {
    model.root.position.set(0, motion.heave * still - model.spec.cgBelowWaterline - sinkM + lift, 0);
    model.root.rotation.set(motion.roll * still, place.yaw, motion.pitch * still, "YZX");
    model.animate(t);
    outfit?.update(t, dt);
    if (contact && base === "kayak") {
      // The foam line only fits our kayak's own hull, sitting in the water.
      contact.collar.visible = contact.spray.visible = shapeKayak && lift < 0.05;
      model.root.updateMatrixWorld();
      bowW.set(contact.bow[0], KAYAK.cgBelowWaterline, contact.bow[1]);
      model.root.localToWorld(bowW);
      contact.update(comps, t, place, hsOf(comps), { speed: 0, bowClearance: bowW.y - heightAt(comps, bowW.x, bowW.z, t), light: atmos.ambient });
    }
  }
  controls.update();
  sea.setSun(atmos.glintDir, atmos.glintLight);
  atmos.render();
  drawLabels();
  status.frames++;
});
