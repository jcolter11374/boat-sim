// How long the title locks the page when its look changes (High to Low, as when it steps itself
// down on a slow computer). Prints the longest time the page could not answer, and when the
// drawing carried on. SITE (default live). SOFT=1 runs headless on software graphics (the cloud:
// only good for comparing two builds). See docs/qa/title-load-2026-11.md.
import * as pw from "playwright";
const SITE = process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/";
const soft = !!process.env.SOFT;
const url = SITE + (SITE.includes("?") ? "&" : "?") + "quality=high" + (soft ? "&gl=full" : "");
const browser = soft
  ? await pw.chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] })
  : await pw.chromium.launch({ channel: "chrome", headless: false, args: ["--window-size=1600,900"] });
const page = await browser.newPage({ viewport: soft ? { width: 1280, height: 720 } : { width: 1600, height: 900 } });
await page.goto(url);
await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 120000 });
await page.waitForTimeout(6000);
const r = await page.evaluate(async () => {
  let worst = 0;
  let last = performance.now();
  const iv = setInterval(() => {
    const n = performance.now();
    worst = Math.max(worst, n - last);
    last = n;
  }, 10);
  const t0 = performance.now();
  const start = window.__sea3d.frames;
  const sel = document.getElementById("quality");
  sel.value = "low";
  sel.dispatchEvent(new Event("change"));
  let resumed = 0;
  while (performance.now() - t0 < 60000) {
    await new Promise((res) => setTimeout(res, 20));
    if (!resumed && window.__sea3d.frames > start + 1) resumed = performance.now() - t0;
    if (window.__sea3d.frames > start + 40) break;
  }
  clearInterval(iv);
  return { pageLockedWorstMs: Math.round(worst), drawingCarriedOnAfterMs: Math.round(resumed) };
});
console.log(JSON.stringify(r));
await browser.close();
