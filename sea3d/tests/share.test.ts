import { test } from "node:test";
import assert from "node:assert/strict";
import { copyText } from "../src/helm/share.ts";

test("a clipboard that copies says so", async () => {
  let got = "";
  assert.equal(await copyText("x", { writeText: async (t) => void (got = t) }), true);
  assert.equal(got, "x");
});

test("a refused, missing or throwing clipboard is just 'not copied'", async () => {
  assert.equal(await copyText("x", { writeText: () => Promise.reject(new Error("NotAllowedError")) }), false);
  assert.equal(await copyText("x", undefined), false);
  assert.equal(
    await copyText("x", {
      writeText: () => {
        throw new Error("sync");
      },
    }),
    false,
  );
});

test("a clipboard that never answers gives up after the wait (#293)", async () => {
  const t0 = Date.now();
  assert.equal(await copyText("x", { writeText: () => new Promise(() => {}) }, 50), false);
  assert.ok(Date.now() - t0 < 1000);
});
