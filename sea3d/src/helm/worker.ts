// Take the helm: one game in this Web Worker. Pyodide (CPython in WebAssembly,
// with numpy and pyyaml) runs Sam's boatsim.sandbox.helm.Game on the 2020
// weather, as the Boatyard's workers run its voyages (docs/sandbox.md).
//
// Messages in:  {id, type: "new", base, launch, day?, safe, breakdowns, mode, challenge?, bundle?, choices?, start_port?}
//                 mode: "hands_on" or "base"; challenge: an id from challenges.json, whose
//                 weather is `bundle` (a URL; left out for the 2020 bundle); start_port:
//                 a port id from ports.json, started from instead of the usual drop
//               {id, type: "load", code, bundle?}         a shared game (Game.save's code)
//               {id, type: "save"}
//               {id, type: "order", heading, power, sails?, engine?, trim?}  heading: degrees, "finish" or "route"; power 0..1; trim 0..1 (a wheel spell)
//               {id, type: "run", hours?, soc_below?, wind_above?, breakdown?}
//               {id, type: "forecast"} | {id, type: "result"}
// Messages out: {id, ok: true, value} | {id, ok: false, error} | {type: "progress", text}
// Replies that move time carry both boats' voyages so far as replays (hourly rows).

import { FIRST_WEATHER, HELM_PACKAGES } from "./prefetch";

// Pass the folder too: Firefox can't work it out from a module imported in a worker
// ("Could not extract indexURL path from pyodide module location", #294).
const PYODIDE_DIR = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/"; // the same as helm/prefetch.ts (tests/prefetch.test.ts)
const PYODIDE = `${PYODIDE_DIR}pyodide.mjs`;

interface Py {
  loadPackage(p: string[]): Promise<void>;
  runPython(code: string): unknown;
  globals: { set(k: string, v: unknown): void };
  FS: { mkdirTree(p: string): void; writeFile(p: string, d: Uint8Array): void };
}

let ready: Promise<Py> | null = null;

// The 2020 weather split by month (boatsim.sandbox split, in the site build): the
// page loads the small static file, then only the months a voyage sails through.
// The values are the whole file's, bit for bit (tests/test_sandbox_split.py). A
// site without the split files (an older ?sandbox= folder) loads the whole file.
interface WeatherParts {
  static: string;
  parts: { key: string; file: string; bytes: number }[];
}
let weatherParts: WeatherParts | null = null;
let weatherBase = "";
const partAdded = new Map<string, Promise<void>>(); // each month: fetched and added once
/** Months whose download was started before Python was up (start()): their bytes, once. */
const partEarly = new Map<string, Promise<Uint8Array>>();

/** Fetch one month of the 2020 weather and add it to the simulator's weather. */
function addPart(py: Py, key: string): Promise<void> {
  let p = partAdded.get(key);
  if (!p) {
    const part = weatherParts?.parts.find((x) => x.key === key);
    if (!part) return Promise.reject(new Error(`no weather for ${key}`));
    // A month fetched beside Python's start is used once; if that fetch failed, fetch it again here.
    const early = partEarly.get(key);
    partEarly.delete(key);
    const url = `${weatherBase}${part.file}`;
    p = (early ? early.catch(() => fetchBytes(url)) : fetchBytes(url)).then((bytes) => {
      py.FS.writeFile("/sandbox/part.npz", bytes);
      py.globals.set("part_key", key);
      py.runPython(`ENVS[""].add_part(part_key, "part.npz")`);
    });
    p.catch(() => partAdded.delete(key)); // a failed fetch can be tried again
    partAdded.set(key, p);
  }
  return p;
}

/** Fetch the months the next 30 days could read, behind the game's back, so the
 *  clock doesn't wait at a month's end even at 4 days a second. */
function fetchAhead(py: Py): void {
  if (!weatherParts) return;
  try {
    const keys = JSON.parse(py.runPython(`json.dumps(ahead())`) as string) as string[];
    for (const k of keys) addPart(py, k).catch(() => undefined); // asked for again when it's needed
  } catch {
    // an older simulator: the months come when a call asks for them
  }
}
const say = (text: string) => postMessage({ type: "progress", text });

async function fetchBytes(url: string, progress?: (n: number, total: number) => void): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  const total = Number(r.headers.get("content-length")) || 0;
  // Content-Length is the compressed size when the server compresses; then count to the end without a percent.
  if (!progress || !r.body || !total || r.headers.get("content-encoding")) return new Uint8Array(await r.arrayBuffer());
  const reader = r.body.getReader();
  const out = new Uint8Array(total);
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > total) return concatRest(out.subarray(0, n), value, reader); // longer than it said
    out.set(value, n);
    n += value.length;
    progress(n, total);
  }
  return n === total ? out : out.subarray(0, n);
}

async function concatRest(head: Uint8Array, next: Uint8Array, reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const parts = [head, next];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
}

function start(base: string): Promise<Py> {
  ready ??= (async () => {
    say("Loading the simulator... 5%");
    const mod = (await import(/* @vite-ignore */ PYODIDE)) as { loadPyodide: (o: { indexURL: string }) => Promise<Py> };
    // "Loading the simulator... N%" (Nina's review, item 8): the bytes of our two files,
    // which are most of the download; Python's own files are counted as one step.
    const got = [0, 0], size = [0, 0];
    let shown = -1;
    const tick = (i: number) => (n: number, total: number) => {
      got[i] = n;
      size[i] = total;
      const known = size[0] && size[1];
      const pct = known ? Math.floor((80 * (got[0] + got[1])) / (size[0] + size[1])) : 0;
      if (known && pct !== shown) say(`Loading the simulator... ${(shown = pct)}%`);
    };
    weatherBase = base;
    weatherParts = await fetch(`${base}forcing_2020_parts.json`)
      .then((r) => (r.ok ? (r.json() as Promise<WeatherParts>) : null))
      .catch(() => null);
    const weather = weatherParts ? weatherParts.static : "forcing_2020.npz";
    // The months the usual launch reads first download beside Python's start, as the whole season
    // used to, not after it: on a slow link that is 5 MB in step with Python's 8 instead of behind it.
    for (const part of weatherParts?.parts ?? []) {
      if (!FIRST_WEATHER.includes(part.key) || partEarly.has(part.key)) continue;
      const early = fetchBytes(`${base}${part.file}`);
      early.catch(() => undefined); // read again in addPart, which fetches it afresh
      partEarly.set(part.key, early);
    }
    const [py, zip, bundle] = await Promise.all([mod.loadPyodide({ indexURL: PYODIDE_DIR }), fetchBytes(`${base}boatsim.zip`, tick(0)), fetchBytes(`${base}${weather}`, tick(1))]);
    say("Loading the simulator... 85%");
    await py.loadPackage(HELM_PACKAGES);
    py.FS.mkdirTree("/sandbox");
    py.FS.writeFile("/sandbox/boatsim.zip", zip);
    py.FS.writeFile("/sandbox/forcing.npz", bundle);
    say("Loading the simulator... 90%: the 2020 weather");
    py.runPython(`
import os, sys, warnings, zipfile, json
warnings.simplefilter("ignore")
zipfile.ZipFile("/sandbox/boatsim.zip").extractall("/sandbox")
sys.path.insert(0, "/sandbox")
os.chdir("/sandbox")
from boatsim.sandbox.run import open_bundle, launches
try:
    from boatsim.sandbox.helm import Game
except ImportError:
    Game = None  # an older simulator on the site: the page says so
try:
    from boatsim.sandbox.helm import UNTIL_CAP_H as UNTIL_CAP
except ImportError:
    UNTIL_CAP = 240.0
from boatsim.runner.replay import to_replay, QUIET_EVENTS
ENVS = {"": open_bundle("forcing.npz")}  # weather bundles by URL; "" = 2020 (whole, or split by month and filled as she sails)
ENV = ENVS[""]
G = None

def ahead(days=30.0):
    # The months of a split bundle the next \`days\` could read and that aren't here yet.
    from datetime import timedelta
    missing = getattr(ENV, "missing", None)
    if missing is None or G is None:
        return []
    t = G.mine.state.t
    return missing(t, t + timedelta(days=days))

def takes_challenges():
    import inspect
    return Game is not None and "challenge" in inspect.signature(Game).parameters

def takes_ports():
    import inspect
    return Game is not None and "start_port" in inspect.signature(Game).parameters

def _f(x):
    # numpy numbers to plain ones, for json
    return x.item() if hasattr(x, "item") else x

def hourly(rep):
    # One row an hour (and the last), every column kept: the 3D view wants sunlight and currents too.
    h = rep["h"]
    keep, nxt = [], 0.0
    for i, t in enumerate(h):
        if t + 1e-6 >= nxt:
            keep.append(i)
            nxt = t + 1.0
    if h and keep[-1] != len(h) - 1:
        keep.append(len(h) - 1)
    out = {k: v for k, v in rep.items() if k != "units"}
    for k, v in rep.items():
        if isinstance(v, list) and len(v) == len(h) and k != "events":
            out[k] = [v[i] for i in keep]
    out["events"] = [e for e in rep["events"] if e["kind"] not in QUIET_EVENTS]
    return out

def run_until(kw):
    # A knockdown the keel rights (capsize) isn't worth stopping the clock for:
    # carry on through those, and stop for a part that breaks or anything else.
    from boatsim.sandbox.helm import BREAKDOWNS
    from boatsim.types import EventKind
    while True:
        n = len(G.mine.log.events)
        t0 = G.mine.state.t
        out = G.run(**kw)
        if out["stopped"] != "breakdown":
            return out
        new = [e for e in G.mine.log.events[n:] if e.kind in BREAKDOWNS]
        if any(e.kind != EventKind.CAPSIZE for e in new):
            return out
        # Carry on with what's left of the hop (or of the 3-day cap).
        key = "hours" if kw.get("hours") is not None else "max_hours"
        kw[key] = kw.get(key, UNTIL_CAP) - (G.mine.state.t - t0).total_seconds() / 3600.0
        if kw[key] <= 0:
            out["stopped"] = "time"
            return out

def voyages():
    # "base": which boat is sailing ("" for our kayak, else e.g. "stock_cruiser31"), so the 3D view draws it.
    c = getattr(G, "choices", None) or {}
    return {"boat": hourly(to_replay(G.mine.log, "You")), "ghost": hourly(to_replay(G.ghost.log, "Autopilot ghost")), "base": c.get("base", "")}
`);
    return py;
  })();
  ready.catch(() => (ready = null)); // a failed load can be tried again
  return ready;
}

const loaded = new Set<string>([""]);

/** Point ENV at the weather a game needs: the 2020 bundle, or a challenge's own
 *  (fetched once, then kept: about 20-30 MB each in memory). */
async function useBundle(py: Py, url: string): Promise<void> {
  if (!loaded.has(url)) {
    say("Loading the challenge's weather...");
    const name = `/sandbox/challenge_${loaded.size}.npz`;
    py.FS.writeFile(name, await fetchBytes(url));
    py.globals.set("bundle_url", url);
    py.globals.set("bundle_path", name);
    py.runPython(`ENVS[bundle_url] = open_bundle(bundle_path)`);
    loaded.add(url);
  }
  py.globals.set("bundle_url", url);
  py.runPython(`ENV = ENVS[bundle_url]`);
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    const py = await start(m.base ?? "");
    if (m.type === "warm") {
      // Loaded while the player reads the start card (#322: no silent wait after Set sail).
      // The months the usual launch reads first come in behind it.
      if (weatherParts) for (const k of FIRST_WEATHER) addPart(py, k).catch(() => undefined);
      postMessage({ id: m.id, ok: true, value: null });
      return;
    }
    if (m.type === "new" || m.type === "load") await useBundle(py, m.bundle ?? "");
    py.globals.set("msg_json", JSON.stringify(m));
    let code: string;
    if (m.type === "new") {
      say("Loading the simulator... 95%: getting the boats ready");
      code = `
m = json.loads(msg_json)
if Game is None:
    raise RuntimeError("NO_HELM")
kw = {"safe": m["safe"], "breakdowns": m["breakdowns"]}
choices = m.get("choices")  # e.g. {"base": "stock_cruiser31"}; None sails our kayak
if m.get("mode", "hands_on") != "hands_on":
    kw["mode"] = m["mode"]  # older simulators only know hands on
if m.get("start_port"):
    if not takes_ports():
        raise RuntimeError("NO_PORTS")
    kw["start_port"] = m["start_port"]
    from boatsim.sandbox.helm import port_start
    try:
        port_start(m["start_port"], ENV)  # a plain message for a port this weather can't sail from
    except ValueError as err:
        raise RuntimeError("BAD_PORT " + str(err))
try:
    if m.get("challenge"):
        if not takes_challenges():
            raise RuntimeError("NO_CHALLENGES")
        G = Game(ENV, choices, challenge=m["challenge"], **kw)
    elif m.get("day"):
        G = Game(ENV, choices, day=m["day"], **kw)  # any April to June noon (the default: a good day)
    else:
        G = Game(ENV, choices, m["launch"], **kw)
except KeyError as err:
    if choices:
        raise RuntimeError("NO_BOAT " + str(err))  # an older simulator without this boat
    raise
json.dumps({"launches": [s.isoformat(timespec="minutes") for s, _ in launches(ENV)], "status": G.status(), **voyages()}, default=_f)
`;
    } else if (m.type === "load") {
      say(m.mine ? "Sailing back to where you left off..." : "Sailing the shared game back to where it was...");
      code = `
m = json.loads(msg_json)
if Game is None or not hasattr(Game, "load"):
    raise RuntimeError("NO_HELM")
try:
    G = Game.load(ENV, m["code"])
except ValueError as err:
    raise RuntimeError("BAD_CODE " + str(err))
json.dumps({"launches": [s.isoformat(timespec="minutes") for s, _ in launches(ENV)], "status": G.status(), "orders": G.orders, "launch": G.launch_index, **voyages()}, default=_f)
`;
    } else if (m.type === "save") {
      code = `json.dumps(G.save())`;
    } else if (m.type === "order") {
      code = `
m = json.loads(msg_json)
# Sail and engine orders (#242) go only when the page sends them, so older simulators still play.
o = G.order(m["heading"], m["power"], *([m["sails"], m["engine"]] if "sails" in m else []), **({"trim": m["trim"]} if "trim" in m else {}))
json.dumps({"order": o if isinstance(o, dict) else {"accepted": True}, "status": G.status()}, default=_f)
`;
    } else if (m.type === "run") {
      say("Sailing...");
      code = `
m = json.loads(msg_json)
kw = {k: m[k] for k in ("hours", "soc_below", "wind_above", "breakdown", "land_within_km") if k in m}
if kw.get("hours") is None and UNTIL_CAP == 240.0:
    kw["hours"] = 240.0  # an older simulator without the 3-day cap
out = run_until(kw)
json.dumps({"stopped": out["stopped"], "status": out["status"], **voyages()}, default=_f)
`;
    } else if (m.type === "preview") {
      // What an order would do over the next day, from a copy of the boat (#330). Older simulators: null.
      code = `
m = json.loads(msg_json)
json.dumps(G.preview(m["heading"], m["power"], *([m["sails"], m["engine"]] if "sails" in m else []), hours=m.get("hours", 24.0)) if hasattr(G, "preview") and G.mode == "hands_on" and not G.status()["over"] else None, default=_f)
`;
    } else if (m.type === "outlook") {
      // Each order's stake against the ghost, from the forecast as issued. Older simulators: null.
      code = `
m = json.loads(msg_json)
json.dumps(G.outlook(m["orders"], hours=m.get("hours", 48.0)) if hasattr(G, "outlook") and G.mode == "hands_on" and not G.status()["over"] else None, default=_f)
`;
    } else if (m.type === "best") {
      // The route check: the heading the forecast favours for the next 2 days. Older simulators: null.
      code = `
m = json.loads(msg_json)
json.dumps(G.best_heading(hours=m.get("hours", 48.0)) if hasattr(G, "best_heading") and G.mode == "hands_on" and not G.status()["over"] else None, default=_f)
`;
    } else if (m.type === "forecast") {
      code = `json.dumps(G.forecast(hours=120), default=_f)`;
    } else {
      code = `json.dumps({"card": G.result(), **voyages()}, default=_f)`;
    }
    // A game on the split weather stops a call that needs a month it doesn't have,
    // before anything has moved (sandbox/helm.py Game._cover): fetch it and ask again.
    let out: string;
    for (let tries = 0; ; tries++) {
      try {
        out = py.runPython(code) as string;
        break;
      } catch (e) {
        const need = weatherParts && tries < 16 ? /WEATHER_PART (\d{4}-\d{2})/.exec(String(e instanceof Error ? e.message : e)) : null;
        if (!need) throw e;
        say(m.type === "run" ? "Loading the weather ahead..." : "Loading the weather for the voyage...");
        await addPart(py, need[1]);
      }
    }
    postMessage({ id: m.id, ok: true, value: JSON.parse(out) });
    if (m.type === "new" || m.type === "load" || m.type === "run") fetchAhead(py);
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
};
export {}; // a module, so its names stay its own
