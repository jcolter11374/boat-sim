// Sandbox reference voyages in Node + Pyodide: the same WebAssembly Python and
// numpy the yard page runs in its Web Workers, so its numbers must match the
// browser's bit for bit (Ravi's gate, docs/sandbox.md).
//
//   node reference.mjs --pack boatsim.zip --bundle forcing_2020.npz --out ref.json \
//       [--builds k-p25 ...] [--launches 0 1 ...] [--trace] [--packages DIR]
//
// --pack is the zip from `python -m boatsim.sandbox pack`, unpacked into
// Pyodide's file system as the page does. --packages: a folder with the numpy
// and pyyaml wheels, for machines that can't reach the Pyodide CDN.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadPyodide } from "pyodide";

function args(argv) {
  const out = { builds: [], launches: [] };
  let key = null;
  for (const a of argv) {
    if (a === "--trace") out.trace = true;
    else if (a.startsWith("--")) key = a.slice(2);
    else if (key === "builds" || key === "launches") out[key].push(a);
    else out[key] = a;
  }
  return out;
}

const a = args(process.argv.slice(2));
const t0 = Date.now();
const py = await loadPyodide();
const pkgs = a.packages
  ? readdirSync(a.packages).filter((f) => /^(numpy|pyyaml)-.*\.whl$/.test(f)).map((f) => join(a.packages, f))
  : ["numpy", "pyyaml"];
await py.loadPackage(pkgs);
py.FS.mkdirTree("/sandbox");
try {
  py.FS.writeFile("/sandbox/boatsim.zip", readFileSync(a.pack));
  py.FS.writeFile("/sandbox/forcing.npz", readFileSync(a.bundle));
  py.runPython(`import zipfile; zipfile.ZipFile("/sandbox/boatsim.zip").extractall("/sandbox")`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
console.error(`pyodide ${py.version} ready in ${Date.now() - t0} ms`);

py.globals.set("builds", py.toPy(a.builds));
py.globals.set("which", py.toPy(a.launches.map(Number)));
py.globals.set("trace", Boolean(a.trace));
let rows;
try {
  rows = py.runPython(`
import json, os, sys, warnings
warnings.simplefilter("ignore")
sys.path.insert(0, "/sandbox")
os.chdir("/sandbox")
from boatsim.sandbox.__main__ import reference
import numpy
rows = reference("forcing.npz", list(builds) or None, list(which) or None, trace=trace)
for r in rows:
    r["runtime"] = f"pyodide {sys.version.split()[0]} numpy {numpy.__version__}"
json.dumps(rows)
`);
} catch (e) {
  console.error(e.message); // a Python traceback; without this Node prints minified Pyodide source
  process.exit(1);
}
writeFileSync(a.out, JSON.stringify(JSON.parse(rows), null, 1));
for (const r of JSON.parse(rows)) console.log(r.build, r.start, r.outcome, r.days, r.events, r.end_lat);
console.error(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
