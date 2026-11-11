// One Boatyard voyage in the real simulator, in this Web Worker: Pyodide
// (CPython compiled to WebAssembly, with numpy and pyyaml) runs Theo's
// boatsim.sandbox (docs/sandbox.md). The page starts a few of these, one
// launch each; they take 20 to 80 s per voyage on a laptop.
//
// Messages in:  {id, type: "run", base, choices, index}   base: where boatsim.zip and forcing_2020.npz live
//               {id, type: "meta", base, choices}          the build's id, effects, nearest grid build
// Messages out: {id, ok: true, value} | {id, ok: false, error} | {type: "progress", text}

// Pass the folder too: Firefox can't work it out from a module imported in a worker
// ("Could not extract indexURL path from pyodide module location", #294).
const PYODIDE_DIR = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
const PYODIDE = `${PYODIDE_DIR}pyodide.mjs`;

interface Py {
  loadPackage(p: string[]): Promise<void>;
  runPython(code: string): unknown;
  globals: { set(k: string, v: unknown): void };
  toPy(v: unknown): unknown;
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
from boatsim.sandbox import catalog
from boatsim.sandbox.run import open_bundle, launches, run_voyage, note
from boatsim.sandbox.__main__ import fingerprint
ENV = open_bundle("forcing.npz")
`);
    return py;
  })();
  return ready;
}

self.onmessage = async (ev: MessageEvent) => {
  const { id, type, base, choices, index } = ev.data;
  try {
    const py = await start(base);
    py.globals.set("choices_json", JSON.stringify(choices));
    let out: string;
    if (type === "meta") {
      out = py.runPython(`
c = json.loads(choices_json)
grid, exact = catalog.nearest(c)
json.dumps({"build": catalog.grid_id(c), "effects": catalog.effects(c), "odds_build": grid, "exact": exact,
            "note": note(ENV), "launches": [[s.isoformat(timespec="minutes"), seed] for s, seed in launches(ENV)]})
`) as string;
    } else {
      py.globals.set("which", index);
      say("Sailing...");
      out = py.runPython(`
c = json.loads(choices_json)
s, seed = launches(ENV)[which]
r = run_voyage(c, ENV, s, seed)
json.dumps({"result": r["result"], "replay": r["replay"], "fingerprint": fingerprint(catalog.grid_id(c), r)})
`) as string;
    }
    postMessage({ id, ok: true, value: JSON.parse(out) });
  } catch (e) {
    postMessage({ id, ok: false, error: String(e instanceof Error ? e.message : e) });
  }
};
