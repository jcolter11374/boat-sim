// Race view: two designs on the same launch, side by side (roadmap item 2).
// The simulator runs in a Web Worker (src/race/worker.ts) on Theo's
// boatsim.sandbox.race; this page draws the map, the two boats' panels, the
// results card and the season's paired verdict. All data goes in with
// textContent, never innerHTML.

type Choices = Record<string, string>;
interface Weather { wind_u: number; wind_v: number; hs: number }
interface Boat {
  name: string; build: string; t: string; lat: number; lon: number; stw: number; soc: number;
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

/** A Boatyard share link's choices (the part after #), checked word by word. */
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
  return baseSel === "kayak" ? {} : { base: baseSel };
}

function setBusy(on: boolean): void {
  page.busy = on;
  const over = page.status?.over ?? false;
  $<HTMLButtonElement>("go").disabled = on;
  for (const id of ["day", "week", "until", "end"]) $<HTMLButtonElement>(id).disabled = on || !page.ready || over;
  $<HTMLButtonElement>("seasonbtn").disabled = on || !page.ready;
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
  box.append(el("div", "muted", `Build ${b.build}`));
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

function drawAll(): void {
  drawMap();
  drawBoat(0);
  drawBoat(1);
  drawCard();
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
    page.status = v.status;
    page.tracks = v.track;
    page.ready = true;
    msg("Both boats are in the water. Sail on, or race the whole season.");
    drawAll();
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}

const STOP_WORDS: Record<string, string> = {
  time: "Time's up for this hop.",
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
    page.status = v.status;
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
  page.card = v.card;
  page.status = v.status;
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
    drawSeason();
    msg("Season done.");
  } catch (e) {
    return fail(e);
  }
  setBusy(false);
}

$("go").addEventListener("click", () => void startRace());
$("day").addEventListener("click", () => void sail(24));
$("week").addEventListener("click", () => void sail(24 * 7));
$("until").addEventListener("click", () => void sail(null));
$("end").addEventListener("click", () => void end());
$("seasonbtn").addEventListener("click", () => void season());
window.addEventListener("resize", drawMap);
drawAll();
export {};
