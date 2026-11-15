import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STILL_KEY, STILL_MAX_AGE_MS } from "../src/helm/still.ts";

// helm.html reads the title's picture in an inline script, before any module has loaded, so it
// spells the key and the age out itself: they must stay the same as helm/still.ts's.
test("helm.html's first script reads the picture the title saves", () => {
  const html = readFileSync(new URL("../helm.html", import.meta.url), "utf8");
  const script = html.slice(html.indexOf('<div id="still"'), html.indexOf('<div id="app">'));
  assert.ok(script.includes(`sessionStorage.getItem("${STILL_KEY}")`), "the same key");
  assert.ok(script.includes(`sessionStorage.removeItem("${STILL_KEY}")`), "used once");
  assert.ok(script.includes(`s.at < ${STILL_MAX_AGE_MS} &&`), "the same age limit");
  assert.ok(script.indexOf("<script>") < script.indexOf("</script>"), "before the page's own elements");
});
