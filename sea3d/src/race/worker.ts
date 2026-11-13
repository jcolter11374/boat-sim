// Race view: one race in this Web Worker. Pyodide runs Theo's
// boatsim.sandbox.race (two builds, the same launch, the same dice) on the
// 2020 weather, as the helm page's worker runs its game (docs/sandbox.md).
//
// Messages in:  {id, type: "new", base, a, b, launch, breakdowns, drop}   a/b: Boatyard choices
//               {id, type: "run", hours?}            hours: a fixed hop; none = until something happens
//               {id, type: "result"}                 sail both to the end, the results card
//               {id, type: "season_launch", i}       one launch of the season, both boats
//               {id, type: "season_verdict"}         the paired verdict over the launches run so far
//               {id, type: "warm"}                   load Python, the simulator and the weather now
// With `replays: true` on "new", "run" and "result" (the helm's sailing screen, M2 R3), the reply
// also carries both boats' voyages so far as replays (hourly rows), as the helm's own worker does.
// Messages out: {id, ok: true, value} | {id, ok: false, error} | {type: "progress", text}

// Pass the folder too: Firefox can't work it out from a module imported in a worker
// ("Could not extract indexURL path from pyodide module location", #294).
const PYODIDE_DIR = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const PYODIDE = `${PYODIDE_DIR}pyodide.mjs`;

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
    const mod = (await import(/* @vite-ignore */ PYODIDE)) as { loadPyodide: (o: { indexURL: string }) => Promise<Py> };
    const [py, zip, bundle] = await Promise.all([mod.loadPyodide({ indexURL: PYODIDE_DIR }), fetchBytes(`${base}boatsim.zip`), fetchBytes(`${base}forcing_2020.npz`)]);
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
    from boatsim.sandbox import race as RACE
except ImportError:
    RACE = None  # an older simulator on the site: the page says so
ENV = open_bundle("forcing.npz")
try:
    from boatsim.runner.replay import to_replay, QUIET_EVENTS
except ImportError:
    to_replay = None

def hourly(rep):
    # One row an hour (and the last), every column kept, as in the helm's worker.
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

def reps(m):
    # Both boats' voyages so far, when the page asks (the helm's sailing screen).
    if not m.get("replays"):
        return None
    if to_replay is None:
        raise RuntimeError("NO_RACE")
    return [hourly(to_replay(v.log, n)) for v, n in zip(R.boats, R.names)]

R = None
SEASON = []
A = B = None
DROP = "same"

def _f(x):
    return x.item() if hasattr(x, "item") else x

def hop(hours):
    # A fixed hop sails the hours whatever happens; "until something happens"
    # stops for a breakdown, a lead change or a finish, but carries on through
    # knockdowns the keel rights (as the helm page does).
    from boatsim.sandbox.helm import BREAKDOWNS
    from boatsim.types import EventKind
    if hours is not None:
        out = R.run(hours=hours, breakdown=False, lead_change=False)
        return out, [out["track"]]
    tracks = []
    left = None
    while True:
        seen = [len(v.log.events) for v in R.boats]
        t0 = R.now()
        out = R.run() if left is None else R.run(max_hours=left)
        tracks.append(out["track"])
        if out["stopped"] != "breakdown":
            return out, tracks
        new = [e for i, v in enumerate(R.boats) for e in v.log.events[seen[i]:] if e.kind in BREAKDOWNS]
        if any(e.kind != EventKind.CAPSIZE for e in new):
            return out, tracks
        left = (left if left is not None else RACE.UNTIL_CAP_H) - (R.now() - t0).total_seconds() / 3600.0
        if left <= 0:
            out["stopped"] = "time"
            return out, tracks
`);
    return py;
  })();
  return ready;
}

self.onmessage = async (ev: MessageEvent) => {
  const m = ev.data;
  try {
    const py = await start(m.base ?? "");
    if (m.type === "warm") return postMessage({ id: m.id, ok: true, value: null });
    py.globals.set("msg_json", JSON.stringify(m));
    let code: string;
    if (m.type === "new") {
      say("Getting both boats ready...");
      code = `
m = json.loads(msg_json)
if RACE is None:
    raise RuntimeError("NO_RACE")
A, B, DROP = m["a"], m["b"], m["drop"]
SEASON = []
R = RACE.Race(ENV, A, B, launch_index=m["launch"], breakdowns=m["breakdowns"], drop=DROP)
json.dumps({"launches": [s.isoformat(timespec="minutes") for s, _ in launches(ENV)], "status": R.status(), "track": R.track(), "replays": reps(m)}, default=_f)
`;
    } else if (m.type === "run") {
      say("Racing...");
      code = `
m = json.loads(msg_json)
out, tracks = hop(m.get("hours"))
json.dumps({"stopped": out["stopped"], "status": out["status"], "track": R.track(), "replays": reps(m)}, default=_f)
`;
    } else if (m.type === "result") {
      say("Sailing both boats to the end...");
      code = `
m = json.loads(msg_json)
json.dumps({"card": R.result(), "status": R.status(), "track": R.track(), "replays": reps(m)}, default=_f)
`;
    } else if (m.type === "season_launch") {
      code = `
m = json.loads(msg_json)
r = RACE.season_launch(ENV, A, B, m["i"], drop=DROP)
r.pop("replays", None)
SEASON.append(r)
json.dumps({"a": r["a"], "b": r["b"]}, default=_f)
`;
    } else {
      code = `json.dumps(RACE.season_verdict(A, B, SEASON), default=_f)`;
    }
    postMessage({ id: m.id, ok: true, value: JSON.parse(py.runPython(code) as string) });
  } catch (e) {
    postMessage({ id: m.id, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
};
export {};
