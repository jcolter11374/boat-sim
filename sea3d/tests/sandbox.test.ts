// The simulator-files check shared by the helm, race and Boatyard pages (src/sandbox.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
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

test("the zip is there: a HEAD request for boatsim.zip under the base", async () => {
  const asked = serve(async () => new Response(null, { headers: { "content-type": "application/zip" } }));
  assert.equal(await sandboxThere(BASE), true);
  assert.deepEqual(asked, [`HEAD ${BASE}boatsim.zip`]);
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
