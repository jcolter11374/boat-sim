// The simulator-files check shared by the helm, race and Boatyard pages (src/sandbox.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { PLAYABLE_STOCK } from "../src/boats/specs";
import { sandboxThere } from "../src/sandbox";

const BASE = "https://example.org/boat-sim/sandbox/";
function serve(answer: () => Promise<Response>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (u: string | URL, init?: RequestInit) => {
    asked.push(`${init?.method ?? "GET"} ${u}`);
    return answer();
  }) as typeof fetch;
  return asked;
}

test("both files are there: a HEAD request each for boatsim.zip and the weather under the base", async () => {
  const asked = serve(async () => new Response(null, { headers: { "content-type": "application/zip" } }));
  assert.equal(await sandboxThere(BASE), true);
  assert.deepEqual(asked.sort(), [`HEAD ${BASE}boatsim.zip`, `HEAD ${BASE}forcing_2020.npz`]);
});

test("the zip without the weather bundle counts as missing", async () => {
  globalThis.fetch = (async (u: string | URL) =>
    String(u).endsWith("boatsim.zip") ? new Response(null, { headers: { "content-type": "application/zip" } }) : new Response(null, { status: 404 })) as typeof fetch;
  assert.equal(await sandboxThere(BASE), false);
});

test("a preview server's HTML fallback counts as missing", async () => {
  serve(async () => new Response("<!DOCTYPE html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
  assert.equal(await sandboxThere(BASE), false);
});

test("a 404 or a network error counts as missing", async () => {
  serve(async () => new Response(null, { status: 404 }));
  assert.equal(await sandboxThere(BASE), false);
  serve(async () => {
    throw new TypeError("Failed to fetch");
  });
  assert.equal(await sandboxThere(BASE), false);
});

// sandbox-needs.json is what the deploy check holds the packed simulator to
// (python -m boatsim.sandbox check-page in sea3d.yml). Keep it honest: every
// "the simulator can't do this yet" error a worker raises is listed, and every
// stock boat the helm offers is a needed base.

const needs = JSON.parse(readFileSync("sandbox-needs.json", "utf8")) as {
  features: Record<string, string[]>;
  bases: string[];
  codes: Record<string, string>;
};
const allNeeds = new Set(Object.values(needs.features).flat());

test("every NO_... error a worker raises maps to a capability the pages need", () => {
  for (const f of ["src/helm/worker.ts", "src/race/worker.ts", "src/yard/sim.worker.ts"]) {
    for (const [, code] of readFileSync(f, "utf8").matchAll(/RuntimeError\("(NO_[A-Z_]+)/g)) {
      const cap = needs.codes[code];
      assert.ok(cap, `${f} raises ${code}: add it to sandbox-needs.json "codes"`);
      if (!cap.endsWith("*")) assert.ok(allNeeds.has(cap), `${code} -> ${cap} isn't under any feature`);
    }
  }
});

test("every stock boat the helm offers is a base the simulator must have", () => {
  for (const k of PLAYABLE_STOCK) assert.ok(needs.bases.includes(k), `${k} is playable but not in sandbox-needs.json "bases"`);
  assert.ok(needs.bases.includes("kayak"));
});
