// Fresh-load timeline on the real GPU: every frame gap, warm-up pixel reads (drawEach), draws per frame.
// SITE, WAIT, OUT.
// See docs/qa/title-load-2026-11.md.
import * as pw from "playwright";
import fs from "node:fs";
const SITE = process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/";
const WAIT = Number(process.env.WAIT ?? 12000);
const browser = await pw.chromium.launch({ channel: "chrome", headless: false, args: ["--window-size=1600,900"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.addInitScript(() => {
  const ev = (window.__ev = []);
  const now = () => Math.round(performance.now());
  let draws = 0, progs = 0;
  for (const C of [WebGL2RenderingContext, WebGLRenderingContext]) {
    const P = C.prototype;
    for (const n of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced"]) {
      const o = P[n]; P[n] = function (...a) { draws++; return o.apply(this, a); };
    }
    const rp = P.readPixels; P.readPixels = function (...a) { const s = performance.now(); const r = rp.apply(this, a); const d = performance.now() - s; if (d > 20) ev.push([now(), "readPixels", Math.round(d)]); return r; };
    const lp = P.linkProgram; P.linkProgram = function (...a) { progs++; return lp.apply(this, a); };
  }
  let last = performance.now();
  const raf = (ts) => {
    const g = ts - last; last = ts;
    if (g > 40 || draws !== window.__pd || progs) ev.push([Math.round(ts), g > 40 ? "GAP" : "f", Math.round(g), "draws", draws, "progs", progs]); window.__pd = draws;
    draws = 0; progs = 0;
    requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  new MutationObserver(() => {
    if (!window.__t && document.getElementById("title") && !document.getElementById("title").hidden) { window.__t = 1; ev.push([now(), "title shown"]); }
  }).observe(document, { subtree: true, childList: true, attributes: true });
});
page.on("console", (m) => { if (m.type() === "error") console.log("console error:", m.text().slice(0, 200)); });
await page.goto(SITE);
await page.waitForTimeout(WAIT);
const ev = await page.evaluate(() => window.__ev);
for (const e of ev) console.log(e.join(" "));
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify(ev));
await browser.close();
