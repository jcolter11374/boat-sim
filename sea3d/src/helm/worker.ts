// Take the helm: one game in this Web Worker. Pyodide (CPython in WebAssembly,
// with numpy and pyyaml) runs Sam's boatsim.sandbox.helm.Game on the 2020
// weather, as the Boatyard's workers run its voyages (docs/sandbox.md).
//
// Messages in:  {id, type: "new", base, launch, safe, breakdowns, mode, challenge?, bundle?, start_port?}
//                 mode: "hands_on" or "base"; challenge: an id from challenges.json, whose
//                 weather is `bundle` (a URL; left out for the 2020 bundle); start_port:
//                 a port id from ports.json, started from instead of the usual drop
//               {id, type: "load", code, bundle?}         a shared game (Game.save's code)
//               {id, type: "save"}
//               {id, type: "order", heading, power}       heading: degrees, "finish" or "route"; power 0..1
//               {id, type: "run", hours?, soc_below?, wind_above?, breakdown?}
//               {id, type: "forecast"} | {id, type: "result"}
// Messages out: {id, ok: true, value} | {id, ok: false, error} | {type: "progress", text}
// Replies that move time carry both boats' voyages so far as replays (hourly rows).

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide.mjs";

interface Py {
  loadPackage(p: string[]): Promise<void>;
  runPython(code: string): unknown;
  globals: { set(k: string, v: unknown): void };
  FS: { mkdirTree(p: string): void; writeFile(p: string, d: Uint8Array): void };
}

let ready: Promise<Py> | null = null;
const say = (text: string) => postMessage({ type: "progress", text });

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}

function start(base: string): Promise<Py> {
  ready ??= (async () => {
    say("Loading Python in the browser...");
    const mod = (await import(/* @vite-ignore */ PYODIDE)) as { loadPyodide: () => Promise<Py> };
    const [py, zip, bundle] = await Promise.all([mod.loadPyodide(), fetchBytes(`${base}boatsim.zip`), fetchBytes(`${base}forcing_2020.npz`)]);
    await py.loadPackage(["numpy", "pyyaml"]);
    py.FS.mkdirTree("/sandbox");
    py.FS.writeFile("/sandbox/boatsim.zip", zip);
    py.FS.writeFile("/sandbox/forcing.npz", bundle);
    say("Loading the 2020 weather...");
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
ENVS = {"": open_bundle("forcing.npz")}  # weather bundles by URL; "" = 2020
ENV = ENVS[""]
G = None

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
    return {"boat": hourly(to_replay(G.mine.log, "You")), "ghost": hourly(to_replay(G.ghost.log, "Autopilot ghost"))}
`);
    return py;
  })();
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
    if (m.type === "new" || m.type === "load") await useBundle(py, m.bundle ?? "");
    py.globals.set("msg_json", JSON.stringify(m));
    let code: string;
    if (m.type === "new") {
      say("Getting the boats ready...");
      code = `
m = json.loads(msg_json)
if Game is None:
    raise RuntimeError("NO_HELM")
kw = {"safe": m["safe"], "breakdowns": m["breakdowns"]}
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
if m.get("challenge"):
    if not takes_challenges():
        raise RuntimeError("NO_CHALLENGES")
    G = Game(ENV, None, challenge=m["challenge"], **kw)
else:
    G = Game(ENV, None, m["launch"], **kw)
json.dumps({"launches": [s.isoformat(timespec="minutes") for s, _ in launches(ENV)], "status": G.status(), **voyages()}, default=_f)
`;
    } else if (m.type === "load") {
      say("Sailing the shared game back to where it was...");
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
o = G.order(m["heading"], m["power"])
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
    } else if (m.type === "forecast") {
      code = `json.dumps(G.forecast(hours=120), default=_f)`;
    } else {
      code = `json.dumps({"card": G.result(), **voyages()}, default=_f)`;
    }
    postMessage({ id: m.id, ok: true, value: JSON.parse(py.runPython(code) as string) });
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
};
export {}; // a module, so its names stay its own
