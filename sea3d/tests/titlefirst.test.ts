import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { WORDMARK_CSS } from "../src/wordmark";

// The title from the first paint (John, 13 Nov 2026: the sea demo's panel showed for seconds before
// the title on a first visit, while the scripts loaded and the sea's shaders compiled).

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8").replace(/\r\n/g, "\n");

test("index.html opens on the title, before any script has run", () => {
  assert.match(html, /<body class="title">/);
  assert.match(html, /<section id="title" aria-labelledby="title-h">/, "the title card isn't hidden in the page itself");
  assert.match(html, /body\.title \{ background: linear-gradient\(/, "a backdrop in the hero's colours while the sea loads");
});

test("the inline check hides the title on the same rule as title.ts (?title=0, or dismissed in this tab)", () => {
  const inline = html.split('<script>')[1]?.split("</script>")[0] ?? "";
  assert.match(inline, /get\("title"\) === "0"/);
  assert.match(inline, /sessionStorage\.getItem\("boatsim\.title\.dismissed"\) === "1"/);
  assert.match(inline, /classList\.remove\("title"\)/);
});

test("the wordmark's early copy in index.html is the same as WORDMARK_CSS", () => {
  const early = html.split('<style id="wordmark-early">')[1]?.split("</style>")[0] ?? "";
  assert.ok(early.includes(WORDMARK_CSS.replace(/\r\n/g, "\n")), "copy src/wordmark.ts WORDMARK_CSS into index.html's #wordmark-early again");
});
