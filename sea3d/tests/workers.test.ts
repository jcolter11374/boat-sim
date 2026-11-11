import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// Every in-browser simulator worker must tell Pyodide where its files are.
// Firefox can't work it out from a module imported in a worker and stops with
// "Could not extract indexURL path from pyodide module location" (#294).

const SRC = new URL("../src/", import.meta.url).pathname;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}

test("every Pyodide loader passes indexURL", () => {
  const loaders = files(SRC).filter((f) => /\bloadPyodide\s*\(/.test(readFileSync(f, "utf8")));
  // The helm, the race and the Boatyard each run the simulator in a worker.
  for (const w of ["helm/worker.ts", "race/worker.ts", "yard/sim.worker.ts"]) {
    assert.ok(loaders.some((f) => f.endsWith(w)), `${w} no longer loads Pyodide: update this test`);
  }
  for (const f of loaders) {
    const src = readFileSync(f, "utf8");
    const calls = [...src.matchAll(/\bloadPyodide\s*\(([^)]*)\)/g)].filter((m) => !/^\s*o\s*:/.test(m[1])); // skip the type
    assert.ok(calls.length > 0, `${f}: no loadPyodide call found`);
    for (const c of calls) assert.match(c[1], /indexURL\s*:/, `${f}: loadPyodide(${c[1]}) without indexURL`);
    // ... and the folder is the one the module comes from.
    const dir = src.match(/PYODIDE_DIR\s*=\s*"([^"]+)"/)?.[1];
    const mod = src.match(/PYODIDE\s*=\s*[`"]([^`"]+)[`"]/)?.[1]?.replace("${PYODIDE_DIR}", dir ?? "");
    assert.ok(dir && dir.endsWith("/"), `${f}: PYODIDE_DIR should be a folder URL ending in /`);
    assert.equal(mod, `${dir}pyodide.mjs`, `${f}: the module and indexURL point at different places`);
  }
});
