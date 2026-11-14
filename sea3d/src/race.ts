// Race view: two designs on the same launch, side by side (roadmap item 2).
// The simulator runs in a Web Worker (src/race/worker.ts) on Theo's
// boatsim.sandbox.race; this page draws the map, the two boats' panels, the
// results card and the season's paired verdict. All data goes in with
// textContent, never innerHTML.

import { sandboxThere } from "./sandbox";
import { loadMyBoat } from "./myboat";
import { BoatView, boatFor, type ViewState } from "./race/view3d";
import { loadDetailedModels } from "./boats/model";

type Choices = Record<string, string>;
interface Weather { wind_u: number; wind_v: number; hs: number; tp?: number; wave_dir?: number; ghi?: number; rain?: number }
interface Boat {
  name: string; build: string; t: string; lat: number; lon: number; heading?: number; stw: number; soc: number;
  km_to_finish: number; outcome: string; breakdowns: string[]; weather?: Weather;
}
interface Status { launch: string; day: number; over: boolean; boats: [Boat, Boat]; lead_km: number; leader: number | null; drops: [number, number][] }
interface Row { lat: number; lon: number }
interface CardBoat { name: string; outcome: string; days: number; battery_low: number; breakdowns: string[] }
interface Card { boats: [CardBoat, CardBoat]; verdict: string; winner: number | null; margin_days: number | null; words: string; breakdowns_differ: boolean }
interface LaunchResult { start: string; outcome: string; days?: number }
interface Season {
  names: [string, string]; launches: { launch: string; a: { outcome: string; days?: number }; b: { outcome: string; days?: number } }[];
  finished: [number, number]; pair: { n: number; a_only: number; b_only: number; gap: number; lo: number; hi: number; p: number; clear: boolean };
  words: string; enough_launches: boolean;
}

const params = new URLSearchParams(location.search);
const sandboxBase = new URL(params.get("sandbox") ?? "./sandbox/", location.href).href;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const COLOURS = ["#ff8a2a", "#5fb4ff"];
const FINISH = { lat: 39.5, lon: -13.5 };

// ---------------------------------------------------------------- worker
class RaceWorker {
  private w: Worker;
  private next = 1;
  private waiting = new Map<number, { ok: (v: unknown) => void; bad: (e: Error) => void }>();
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private base: string, onProgress: (t: string) => void) {
    this.w = new Worker(new URL("./race/worker.ts", import.meta.url), { type: "module" });
    this.w.onmessage = (ev: MessageEvent) => {
      const m = ev.data;
      if (m.type === "progress") return onProgress(m.text);
      const p = this.waiting.get(m.id);
      if (!p) return;
      this.waiting.delete(m.id);
      if (m.ok) p.ok(m.value);
      else p.bad(new Error(m.error));
    };
    this.w.onerror = (e) => {
      for (const p of this.waiting.values()) p.bad(new Error(e.message || "the simulator stopped"));
      this.waiting.clear();
    };
  }
  ask<T>(msg: Record<string, unknown>): Promise<T> {
    const p = this.queue.then(
      () =>
        new Promise<T>((ok, bad) => {
          const id = this.next++;
          this.waiting.set(id, { ok: ok as (v: unknown) => void, bad });
          this.w.postMessage({ ...msg, id, base: this.base });
        }),
    );
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------- state
const page = {
  ready: false,
  busy: false,
  error: null as string | null,
  status: null as Status | null,
  tracks: [[], []] as [Row[], Row[]],
  stops: [] as string[],
  card: null as Card | null,
  season: null as Season | null,
  /** The two 3D views (for the smoke test): frames drawn and what each shows. */
  views: [] as BoatView["shown"][],
};
declare global {
  interface Window { __race?: typeof page }
}
window.__race = page;

let worker: RaceWorker | null = null;
const msg = (t: string, cls = "muted") => {
  const m = $("msg");
  m.className = cls;
  m.textContent = t;
};

// "My boat" (saved in the Boatyard or sailed at the helm) is boat A to start with.
const MINE = "mine";
const mine = loadMyBoat();
if (mine) {
  const sel = $<HTMLSelectElement>("baseA");
  sel.prepend(new Option(`My boat: ${mine.name}`, MINE)); // an option's text is plain text, never markup
  sel.value = MINE;
}

/** The player's name for boat A when it's "my boat" (null otherwise): shown instead of the simulator's
 *  generic name ("Our kayak") everywhere the page names the boats. Plain text only. */
let nameA: string | null = null;
/** The Randolph boat by the name the Boatyard and Set sail use (Elena): the simulator says "Rev C". */
const revC5 = (t: string) => t.replace(/\bRev C\b(?!\d)/g, "Rev C5");
function ownNames<T extends { boats: { name: string }[]; words?: string; verdict?: string }>(x: T): T {
  for (const b of x.boats) b.name = revC5(b.name);
  if (typeof x.words === "string") x.words = revC5(x.words);
  if (typeof x.verdict === "string") x.verdict = revC5(x.verdict);
  if (nameA && x.boats[0]) x.boats[0].name = nameA;
  return x;
}

/** A Boatyard share link's choices (the part after #), checked word by word; else the boat picked. */
function choicesFrom(baseSel: string, share: string): Choices | null {
  const hash = share.includes("#") ? share.slice(share.indexOf("#") + 1) : share.trim();
  if (hash) {
    const out: Choices = {};
    let bad = false;
    new URLSearchParams(hash).forEach((v, k) => {
      if (!/^[\w.-]{1,40}$/.test(k) || !/^[\w.-]{1,60}$/.test(v)) bad = true;
      else out[k] = v;
    });
    if (bad) return null;
    return out;
  }
  if (baseSel === MINE && mine) return Object.fromEntries(Object.entries(mine.choices).map(([k, v]) => [k, String(v)]));
  return baseSel === "kayak" ? {} : { base: baseSel };
}

function setBusy(on: boolean): void {
  page.busy = on;
  const over = page.status?.over ?? false;
  $<HTMLButtonElement>("go").disabled = on;
  for (const id of ["day", "week", "until", "end"]) $<HTMLButtonElement>(id).disabled = on || !page.ready || over;
  $<HTMLButtonElement>("seasonbtn").disabled = on || !page.ready;
  for (const b of barButtons()) b.disabled = on || !page.ready || over;
  drawMap(); // the empty chart's hint goes while the simulator loads
}

// ---------------------------------------------------------------- drawing
function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const OUTCOME: Record<string, string> = {
  at_sea: "sailing", arrived: "finished", lost: "lost", aground: "ran aground", timeout: "out of time",
  disqualified: "disqualified", left_data_box: "sailed off the weather map",
};
const words = (o: string) => OUTCOME[o] ?? o.replace(/_/g, " ");

function drawBoat(i: 0 | 1): void {
  const box = $(i === 0 ? "boatA" : "boatB");
  box.replaceChildren();
  const b = page.status?.boats[i];
  if (!b) {
    box.append(el("h3", undefined, i === 0 ? "Boat A" : "Boat B"), el("div", "muted", "Not started"));
    return;
  }
  box.append(el("h3", undefined, b.name));
  const row = (k: string, v: string, cls = "") => {
    const r = el("div", "row");
    r.append(el("span", undefined, k), el("span", cls, v));
    box.append(r);
  };
  row("Now", words(b.outcome), b.outcome === "arrived" ? "good" : b.outcome === "at_sea" ? "" : "bad");
  row("To the finish", `${Math.round(b.km_to_finish).toLocaleString()} km`);
  row("Speed", `${(b.stw * 1.944).toFixed(1)} kn`);
  row("Battery", `${Math.round(b.soc * 100)}%`, b.soc < 0.3 ? "warn" : "");
  if (b.weather) {
    row("Wind", `${(Math.hypot(b.weather.wind_u, b.weather.wind_v) * 1.944).toFixed(0)} kn`);
    row("Waves", `${b.weather.hs.toFixed(1)} m`);
  }
  row("Breakdowns", b.breakdowns.length ? b.breakdowns.map((x) => x.replace(/_/g, " ")).join(", ") : "none", b.breakdowns.length ? "warn" : "");
}

function drawMap(): void {
  const c = $<HTMLCanvasElement>("map");
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth, H = c.clientHeight;
  c.width = W * dpr;
  c.height = H * dpr;
  const g = c.getContext("2d")!;
  g.scale(dpr, dpr);
  g.fillStyle = "#0f2238";
  g.fillRect(0, 0, W, H);
  // The box the boats sail in: Chesapeake Bay to Portugal.
  const lon0 = -78, lon1 = -8, lat0 = 30, lat1 = 50;
  const kx = Math.cos((40 * Math.PI) / 180);
  const s = Math.min(W / ((lon1 - lon0) * kx), H / (lat1 - lat0));
  const ox = (W - (lon1 - lon0) * kx * s) / 2, oy = (H - (lat1 - lat0) * s) / 2;
  const P = (lat: number, lon: number): [number, number] => [ox + (lon - lon0) * kx * s, oy + (lat1 - lat) * s];
  g.strokeStyle = "rgba(160,200,255,.08)";
  g.lineWidth = 1;
  g.fillStyle = "rgba(159,179,200,.55)";
  g.font = "10px system-ui, sans-serif";
  for (let lon = -70; lon <= -10; lon += 10) {
    const [x] = P(0, lon);
    g.beginPath(); g.moveTo(x, oy); g.lineTo(x, H - oy); g.stroke();
    g.fillText(`${-lon}°W`, x + 2, H - oy - 3);
  }
  for (let lat = 35; lat <= 45; lat += 5) {
    const [, y] = P(lat, 0);
    g.beginPath(); g.moveTo(ox, y); g.lineTo(W - ox, y); g.stroke();
    g.fillText(`${lat}°N`, ox + 2, y - 2);
  }
  // Finish: the 25 km circle on the race's line west of Lisbon.
  const [fx, fy] = P(FINISH.lat, FINISH.lon);
  g.strokeStyle = "#3ddc97";
  g.beginPath(); g.arc(fx, fy, 6, 0, Math.PI * 2); g.stroke();
  g.fillStyle = "#3ddc97";
  g.fillText("finish", fx - 12, fy - 9);
  for (const i of [0, 1] as const) {
    const t = page.tracks[i];
    const d = page.status?.drops[i];
    const pts: Row[] = d ? [{ lat: d[0], lon: d[1] }, ...t] : t;
    const b = page.status?.boats[i];
    if (b) pts.push({ lat: b.lat, lon: b.lon });
    if (!pts.length) continue;
    g.strokeStyle = COLOURS[i];
    g.lineWidth = 2;
    g.beginPath();
    pts.forEach((r, k) => (k ? g.lineTo(...P(r.lat, r.lon)) : g.moveTo(...P(r.lat, r.lon))));
    g.stroke();
    const [x, y] = P(pts[pts.length - 1].lat, pts[pts.length - 1].lon);
    g.fillStyle = COLOURS[i];
    g.beginPath(); g.arc(x, y, 4.5, 0, Math.PI * 2); g.fill();
  }
  // Nothing sailed yet: say what starts it.
  if (!page.status && !page.busy) {
    g.fillStyle = "rgba(230,238,248,.85)";
    g.font = "600 15px system-ui, sans-serif";
    g.textAlign = "center";
    g.fillText("Pick two boats, then press Start the race.", W / 2, H / 2 - 6);
    g.font = "12px system-ui, sans-serif";
    g.fillStyle = "rgba(159,179,200,.85)";
    g.fillText("Both tracks are drawn here as the boats sail.", W / 2, H / 2 + 14);
    g.textAlign = "start";
  }
  const st = page.status;
  const lead = $("lead");
  if (!st) lead.textContent = "";
  else {
    const who = st.leader === null ? "Neck and neck." : `${st.boats[st.leader].name} is ${Math.abs(st.lead_km).toFixed(0)} km closer to the finish.`;
    const when = new Date(`${st.launch}Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
    lead.textContent = `Day ${st.day.toFixed(1)} since the ${when} launch. ${who}`;
  }
}

function drawCard(): void {
  const box = $("card");
  const c = page.card;
  box.hidden = !c;
  box.replaceChildren();
  if (!c) return;
  box.append(el("h2", undefined, "Result"), el("div", undefined, c.words));
  for (const [i, b] of c.boats.entries()) {
    const line = el("div", "muted", `${b.name}: ${words(b.outcome)} on day ${b.days.toFixed(1)}; lowest battery ${Math.round(b.battery_low * 100)}%`);
    line.style.color = COLOURS[i];
    box.append(line);
  }
  if (c.breakdowns_differ) box.append(el("div", "muted", "The same dice fell for both, but one build broke where the other held: a weaker part fails on a roll the stronger survives."));
}

function drawSeason(progress?: { done: number; of: number; rows: { a: LaunchResult; b: LaunchResult }[] }): void {
  const box = $("season");
  const s = page.season;
  box.hidden = !s && !progress;
  box.replaceChildren(el("h2", undefined, "The season: every launch, same dice"));
  const rows = s ? s.launches.map((r) => ({ launch: r.launch, a: r.a, b: r.b })) : (progress?.rows ?? []).map((r) => ({ launch: r.a.start, a: r.a, b: r.b }));
  const names = s?.names ?? [page.status?.boats[0].name ?? "A", page.status?.boats[1].name ?? "B"];
  const t = el("table");
  const head = el("tr");
  head.append(el("th", undefined, "Launch"), el("th", undefined, names[0]), el("th", undefined, names[1]));
  t.append(head);
  const cell = (o: { outcome: string; days?: number }) => el("td", o.outcome === "arrived" ? "good" : "", o.outcome === "arrived" && o.days != null ? `finished, day ${o.days.toFixed(0)}` : words(o.outcome));
  for (const r of rows) {
    const tr = el("tr");
    tr.append(el("td", undefined, r.launch.slice(0, 10)), cell(r.a), cell(r.b));
    t.append(tr);
  }
  box.append(t);
  if (progress && !s) box.append(el("div", "muted", `Racing launch ${progress.done + 1} of ${progress.of}...`));
  if (s) {
    box.append(el("p", undefined, `Finished: ${names[0]} ${s.finished[0]} of ${s.launches.length}, ${names[1]} ${s.finished[1]} of ${s.launches.length}.`));
    box.append(el("p", s.pair.clear ? "" : "muted", s.words));
    if (!s.enough_launches)
      box.append(el("p", "muted", `A season here is ${s.launches.length} launches; the leaderboard waits for at least 60 before it calls a winner, so read this as a hint, not a ranking.`));
  }
}

// ---------------------------------------------------------------- 3D views
// Each boat on its own patch of sea, in its own weather, side by side.
// ?quality=low|high forces it; otherwise each view picks (High on a graphics card, Low on software graphics).
const askedQuality = params.get("quality");
const quality = askedQuality === "low" || askedQuality === "high" ? askedQuality : "auto";
let views: [BoatView, BoatView] | null = null;
let viewsOn = true; // false while the views are scrolled out of sight
function draw3d(): void {
  const st = page.status;
  $("views").hidden = !st;
  if (!st) return;
  if (!views) {
    views = [new BoatView($("viewA"), quality), new BoatView($("viewB"), quality)];
    page.views = views.map((v) => v.shown);
    void loadDetailedModels().then((ok) => ok && views?.forEach((v) => v.build()));
    new IntersectionObserver((e) => (viewsOn = e.some((x) => x.isIntersecting))).observe($("views"));
    window.addEventListener("resize", () => views?.forEach((v) => v.resize()));
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      if (viewsOn) for (const v of views!) v.frame(now / 1000, dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  for (const i of [0, 1] as const) {
    const b = st.boats[i];
    const s: ViewState = { t: b.t, lat: b.lat, lon: b.lon, heading: b.heading ?? 90, stw: b.stw, outcome: b.outcome, weather: b.weather };
    views[i].set(s);
    const tag = $(i === 0 ? "tagA" : "tagB");
    const name = el("b", undefined, b.name);
    name.style.color = COLOURS[i];
    const wind = b.weather ? `, wind ${(Math.hypot(b.weather.wind_u, b.weather.wind_v) * 1.944).toFixed(0)} kn, waves ${b.weather.hs.toFixed(1)} m` : "";
    tag.replaceChildren(name, document.createTextNode(` · ${words(b.outcome)}${wind}`));
  }
}
/** A new race: put each design's own boat in its view. */
function boatsInViews(a: Choices, b: Choices, mineA = false): void {
  draw3d();
  if (!views) return;
  for (const [i, c] of [a, b].entries()) {
    const { spec, hull } = boatFor(c);
    views[i].setBoat(spec, hull, i === 0 && mineA); // boat A is the player's own when they race "My boat"
  }
}

function drawAll(): void {
  drawMap();
  draw3d();
  drawBoat(0);
  drawBoat(1);
  drawCard();
  if (page.status && play.rate === null && !play.ahead) play.clock = tOf(page.status);
  drawBar();
}

// ---------------------------------------------------------------- actions
function fail(e: unknown): void {
  const s = String(e instanceof Error ? e.message : e);
  page.error = s;
  msg(/NO_RACE/.test(s) ? "The simulator published on this site is older than the race view; it arrives with the next sandbox-data update." : /sandbox\/|404|Failed to fetch/.test(s) ? "The simulator files aren't published on this site yet, so races can't run here." : `Something went wrong: ${s}`, "bad");
  setBusy(false);
}

async function startRace(): Promise<void> {
  const a = choicesFrom($<HTMLSelectElement>("baseA").value, $<HTMLInputElement>("shareA").value);
  const b = choicesFrom($<HTMLSelectElement>("baseB").value, $<HTMLInputElement>("shareB").value);
  if (!a || !b) return msg("That share link doesn't look like one from the Boatyard.", "bad");
  nameA = $<HTMLSelectElement>("baseA").value === MINE && mine && !$<HTMLInputElement>("shareA").value.trim() ? mine.name : null;
  if (!(await sandboxThere(sandboxBase))) {
    page.error = "no simulator files";
    return msg("The simulator files aren't published on this site yet, so races can't run here.", "bad");
  }
  worker ??= new RaceWorker(sandboxBase, (t) => msg(t));
  page.ready = false;
  page.error = null;
  page.card = null;
  page.season = null;
  page.stops = [];
  $("season").hidden = true;
  setBusy(true);
  try {
    const v = await worker.ask<{ status: Status; track: [Row[], Row[]] }>({
      type: "new",
      a,
      b,
      launch: Number($<HTMLSelectElement>("launch").value),
      breakdowns: $<HTMLInputElement>("breakdowns").checked,
      drop: $<HTMLSelectElement>("drop").value,
    });
    page.status = ownNames(v.status);
    page.tracks = v.track;
    page.ready = true;
    msg("Both boats are in the water. Sail on, or race the whole season.");
    drawAll();
    boatsInViews(a, b, nameA !== null);
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}

const STOP_WORDS: Record<string, string> = {
  time: "", // a fixed hop ended on time: nothing to say (Elena)
  lead_change: "The lead just changed hands.",
  breakdown: "Something broke on one of the boats.",
  finished: "One boat's voyage just ended.",
  over: "Both voyages have ended.",
};

async function sail(hours: number | null): Promise<void> {
  if (!worker || !page.ready) return;
  setBusy(true);
  try {
    const v = await worker.ask<{ stopped: string; status: Status; track: [Row[], Row[]] }>({ type: "run", ...(hours === null ? {} : { hours }) });
    page.status = ownNames(v.status);
    page.tracks = v.track;
    page.stops.push(v.stopped);
    msg(STOP_WORDS[v.stopped] ?? v.stopped);
    if (v.status.over) await toEnd();
    drawAll();
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}

async function toEnd(): Promise<void> {
  const v = await worker!.ask<{ card: Card; status: Status; track: [Row[], Row[]] }>({ type: "result" });
  page.card = ownNames(v.card);
  page.status = ownNames(v.status);
  page.tracks = v.track;
}

async function end(): Promise<void> {
  if (!worker || !page.ready) return;
  setBusy(true);
  try {
    await toEnd();
    msg("Both voyages sailed to the end.");
    drawAll();
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}

async function season(): Promise<void> {
  if (!worker || !page.ready) return;
  setBusy(true);
  const n = $<HTMLSelectElement>("launch").options.length;
  const rows: { a: LaunchResult; b: LaunchResult }[] = [];
  try {
    for (let i = 0; i < n; i++) {
      drawSeason({ done: i, of: n, rows });
      msg(`Racing the season: launch ${i + 1} of ${n} (both boats, to the end)...`);
      rows.push(await worker.ask<{ a: LaunchResult; b: LaunchResult }>({ type: "season_launch", i }));
    }
    page.season = await worker.ask<Season>({ type: "season_verdict" });
    page.season.names = page.season.names.map(revC5) as [string, string];
    page.season.words = revC5(page.season.words);
    if (nameA) page.season.names[0] = nameA;
    drawSeason();
    msg("Season done.");
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}


// ---------------------------------------------------------------- speed bar
// Let both boats sail on at a steady pace (T1: Real time first, as on the helm's bar).
// The clock runs at the picked rate; the simulator sails one hop ahead (one second's
// worth, at least an hour) and each hop shows when the clock reaches it.
const barButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>("#timebar button"));
const play = {
  /** Hours of the voyage per second; null while paused. */
  rate: null as number | null,
  /** The clock shown (ms, on the same footing as Date.parse of the simulator's times). */
  clock: 0,
  /** The next hop, sailed but not shown yet. */
  ahead: null as { stopped: string; status: Status; track: [Row[], Row[]] } | null,
  fetching: false,
  /** Bumped by every new race, so a hop from the last one is dropped. */
  gen: 0,
};
(page as unknown as { play: typeof play }).play = play;
const tOf = (st: Status) => Math.max(...st.boats.map((b) => Date.parse(b.t)));

function drawBar(): void {
  for (const b of barButtons()) {
    const r = b.dataset.rate;
    const on = r === undefined ? play.rate === null : (r === "rt" ? 1 / 3600 : Number(r)) === play.rate;
    b.setAttribute("aria-pressed", String(on));
  }
  const st = page.status;
  if (!st) return void ($("rclock").textContent = "");
  const s = Math.max(0, Math.round((play.clock - Date.parse(st.launch)) / 1000));
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  $("rclock").textContent = `Day ${Math.floor(s / 86400)}, ${hh}:${mm}:${ss} since the launch`;
}

/** Show a sailed hop: the boats, the map and, when both voyages have ended, the results. */
async function showHop(v: { stopped: string; status: Status; track: [Row[], Row[]] }): Promise<void> {
  page.status = ownNames(v.status);
  page.tracks = v.track;
  if (v.stopped !== "time") {
    page.stops.push(v.stopped);
    msg(STOP_WORDS[v.stopped] ?? v.stopped);
  }
  if (v.status.over) {
    play.rate = null;
    await toEnd();
    msg(STOP_WORDS.over);
    setBusy(false);
  }
  drawAll();
}

/** Stop the clock, and show anything already sailed so the page and the simulator agree. */
async function pause(): Promise<void> {
  if (play.rate !== null) msg("Paused.");
  play.rate = null;
  if (play.ahead) {
    const v = play.ahead;
    play.ahead = null;
    await showHop(v);
  }
  if (page.status) play.clock = tOf(page.status);
  drawBar();
}

function setRate(rate: number | null): void {
  if (rate === null) return void pause();
  if (!worker || !page.ready || page.busy || page.status?.over) return;
  play.rate = rate;
  drawBar();
}

let lastTick = performance.now();
function tick(now: number): void {
  const dt = Math.min((now - lastTick) / 1000, 0.25);
  lastTick = now;
  const st = page.status;
  if (play.rate !== null && st && page.ready && !page.busy && !st.over && worker) {
    const limit = play.ahead ? tOf(play.ahead.status) : tOf(st);
    play.clock = Math.min(play.clock + play.rate * 3600e3 * dt, limit);
    if (play.ahead && play.clock >= limit) {
      const v = play.ahead;
      play.ahead = null;
      void showHop(v).catch(fail);
    } else if (!play.ahead && !play.fetching && play.clock >= tOf(st) - 1) {
      play.fetching = true;
      const gen = play.gen;
      worker
        .ask<{ stopped: string; status: Status; track: [Row[], Row[]] }>({ type: "run", hours: Math.max(1, play.rate) })
        .then((v) => {
          play.fetching = false;
          if (gen !== play.gen) return;
          if (play.rate === null) return showHop(v); // paused meanwhile: show it now
          play.ahead = v;
        })
        .catch((e) => {
          play.fetching = false;
          play.rate = null;
          fail(e);
        });
    }
    drawBar();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
for (const b of barButtons())
  b.addEventListener("click", () => {
    const r = b.dataset.rate;
    setRate(r === undefined ? null : r === "rt" ? 1 / 3600 : Number(r));
  });

$("go").addEventListener("click", () =>
  void pause().then(() => {
    play.gen++;
    play.ahead = null;
    return startRace();
  }),
);
$("day").addEventListener("click", () => void pause().then(() => sail(24)));
$("week").addEventListener("click", () => void pause().then(() => sail(24 * 7)));
$("until").addEventListener("click", () => void pause().then(() => sail(null)));
$("end").addEventListener("click", () => void pause().then(end));
$("seasonbtn").addEventListener("click", () => void pause().then(season));
// The share-link boxes are for experts: a link opens each one (#317).
for (const b of Array.from(document.querySelectorAll<HTMLButtonElement>(".pastelink")))
  b.addEventListener("click", () => {
    const box = $(b.dataset.for!);
    box.hidden = !box.hidden;
    b.textContent = box.hidden ? "Paste a design link instead" : "Hide the design link";
    if (box.hidden) box.querySelector("input")!.value = "";
    else box.querySelector("input")!.focus();
  });
window.addEventListener("resize", drawMap);
drawAll();
export {};
