// How "Take the helm" FEELS to a player: load time, time to the first control,
// time from "Take the helm" to sailing, how long each sail button takes, the frame
// rate while idle and while the simulator works, and how fast the page answers a
// click on the heading dial or a drag of the power slider (Event Timing: input to
// next paint). Default quality, as a player opens it, unless QUALITY is set.
//
//   node tools/playtest/feel.mjs                 (Chromium, the live site)
//   CHANNEL=chrome node tools/playtest/feel.mjs  (the installed Chrome, real GPU)
//   SITE=http://localhost:4173/ BROWSER=firefox node tools/playtest/feel.mjs
//
// Prints one block per scenario and a summary table; writes feel-<scenario>.png.
// Read-only: it only visits the site.
import * as pw from "playwright";
import { appendFileSync, writeFileSync } from "node:fs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const BROWSER = process.env.BROWSER ?? "chromium";
const Q = process.env.QUALITY ? `?quality=${process.env.QUALITY}` : "";
const MIN = 60_000;

const SCENARIOS = [
  { name: "kayak-drop", setup: async () => {} },
  {
    name: "kayak-norfolk",
    setup: async (p) => {
      await p.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN });
      await p.selectOption("#port", "norfolk");
    },
  },
  {
    name: "cruiser-drop",
    setup: async (p) => {
      const r = p.locator('input[name="boat"][value="stock_cruiser31"]');
      if ((await r.count()) === 1) await r.check();
    },
  },
];

/** Frame gaps (ms) over `secs` seconds, measured in the page. */
async function frames(page, secs) {
  return page.evaluate(
    (secs) =>
      new Promise((done) => {
        const gaps = [];
        let last = performance.now();
        const end = last + secs * 1000;
        const tick = (t) => {
          gaps.push(t - last);
          last = t;
          if (t < end) requestAnimationFrame(tick);
          else done(gaps);
        };
        requestAnimationFrame(tick);
      }),
    secs,
  );
}
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))] : NaN);
const fps = (gaps) => (gaps.length ? Math.round((1000 * gaps.length) / gaps.reduce((a, b) => a + b, 0)) : 0);
const ms = (x) => `${Math.round(x)} ms`;

/** Starts recording input-to-paint times (Event Timing API; Chromium only). */
async function watchInputs(page) {
  await page.evaluate(() => {
    window.__feel = { events: [] };
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) if (["pointerdown", "pointerup", "click", "input", "change", "keydown"].includes(e.name)) window.__feel.events.push({ name: e.name, dur: e.duration, delay: e.processingStart - e.startTime });
      }).observe({ type: "event", durationThreshold: 16, buffered: false });
      window.__feel.supported = true;
    } catch {
      window.__feel.supported = false;
    }
  });
}

/** Wall time of one sail button, and the frame rate while the simulator works. */
/** The helm's orders drawer (Leo's layout plan): open it before using what's inside. Builds without one: nothing to do. */
async function openOrders(page) {
  if ((await page.locator("#orders-tab").count()) && !(await page.locator("#orders.open").count())) {
    await page.click("#orders-tab");
    await page.waitForTimeout(400); // it slides in
  }
}
async function sail(page, button) {
  const t0 = Date.now();
  await openOrders(page);
  const during = frames(page, 4); // overlaps the busy period
  await page.click(button, { noWaitAfter: true });
  await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 10 * MIN });
  const secs = (Date.now() - t0) / 1000;
  const gaps = await during;
  const st = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error }));
  return { button, secs, fpsBusy: fps(gaps), worstFrame: Math.max(...gaps), ...st };
}

async function play(browser, sc) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const r = { scenario: sc.name };
  try {
    const t0 = Date.now();
    await page.goto(SITE + "helm.html" + Q, { waitUntil: "load", timeout: 2 * MIN });
    r.loadSecs = (Date.now() - t0) / 1000;
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
    await page.locator("#go").waitFor({ state: "visible", timeout: MIN });
    r.firstControlSecs = (Date.now() - t0) / 1000;
    const idle = await frames(page, 3);
    r.fpsStartCard = fps(idle);
    await sc.setup(page);
    const t1 = Date.now();
    await page.click("#go", { noWaitAfter: true });
    await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
    r.startSecs = (Date.now() - t1) / 1000;
    const err = await page.evaluate(() => window.__helm.error);
    if (err) throw new Error(`didn't start: ${err}`);
    const sailing = await frames(page, 4);
    r.fpsSailing = fps(sailing);
    r.p90FrameSailing = pct(sailing, 0.9);

    // Controls: three clicks around the heading dial, then a power slider drag.
    await watchInputs(page);
    await openOrders(page);
    const dial = await page.locator("#dial").boundingBox();
    if (dial) {
      const cx = dial.x + dial.width / 2, cy = dial.y + dial.height / 2, rad = Math.min(dial.width, dial.height) * 0.38;
      for (const deg of [60, 120, 90]) {
        const a = ((deg - 90) * Math.PI) / 180;
        await page.mouse.click(cx + rad * Math.cos(a), cy + rad * Math.sin(a));
        await page.waitForTimeout(400);
      }
    }
    const power = page.locator("#power");
    if (await power.isVisible().catch(() => false)) {
      await power.fill("40").catch(() => {});
      await power.dispatchEvent("change").catch(() => {});
      await page.waitForTimeout(400);
    }
    const inputs = await page.evaluate(() => window.__feel);
    r.inputSupported = inputs.supported;
    r.inputEvents = inputs.events.length;
    r.worstInputMs = inputs.events.length ? Math.max(...inputs.events.map((e) => e.dur)) : 0;
    r.worstInputDelayMs = inputs.events.length ? Math.max(...inputs.events.map((e) => e.delay)) : 0;

    r.hops = [];
    for (const b of ["#s6", "#sday", "#sevent"]) r.hops.push(await sail(page, b));
    await page.screenshot({ path: `feel-${sc.name}.png` }).catch(() => {});
  } catch (e) {
    r.error = String(e).split("\n")[0];
  }
  r.pageErrors = errors.slice(0, 5);
  await ctx.close();
  return r;
}

const LAUNCH = {
  headless: !process.env.HEADED,
  ...(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {}),
  ...(BROWSER === "firefox" ? { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.enable-webgl2": true } } : {}),
};
const browser = await pw[BROWSER].launch(LAUNCH);
const gpu = await (async () => {
  const p = await browser.newPage();
  const g = await p.evaluate(() => {
    const gl = document.createElement("canvas").getContext("webgl2");
    const d = gl?.getExtension("WEBGL_debug_renderer_info");
    return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl ? "webgl2 (renderer hidden)" : "no WebGL2";
  });
  await p.close();
  return g;
})();
const names = process.argv.slice(2);
const results = [];
for (const sc of SCENARIOS.filter((s) => !names.length || names.includes(s.name))) {
  const r = await play(browser, sc);
  results.push(r);
  console.log(`\n== ${r.scenario}${r.error ? `  ERROR: ${r.error}` : ""}`);
  console.log(`  load ${r.loadSecs?.toFixed(1)} s, first control ${r.firstControlSecs?.toFixed(1)} s, start card ${r.fpsStartCard} fps`);
  console.log(`  Take the helm -> sailing ${r.startSecs?.toFixed(1)} s; sailing ${r.fpsSailing} fps (p90 frame ${ms(r.p90FrameSailing ?? 0)})`);
  console.log(`  dial/power: ${r.inputEvents} slow inputs (>16 ms), worst input-to-paint ${ms(r.worstInputMs ?? 0)}, worst input delay ${ms(r.worstInputDelayMs ?? 0)}${r.inputSupported ? "" : " (Event Timing not supported here)"}`);
  for (const h of r.hops ?? []) console.log(`  ${h.button}: ${h.secs.toFixed(1)} s to day ${h.day?.toFixed(2)} (${h.stop}); ${h.fpsBusy} fps while working, worst frame ${ms(h.worstFrame)}`);
  if (r.pageErrors.length) console.log(`  page errors: ${r.pageErrors.join(" | ")}`);
}
await browser.close();
console.log(`\nbrowser ${BROWSER}${process.env.CHANNEL ? ` (${process.env.CHANNEL})` : ""}, GPU: ${gpu}, quality ${process.env.QUALITY ?? "default"}`);
writeFileSync(`feel-${BROWSER}.json`, JSON.stringify({ gpu, site: SITE, results }, null, 2));
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Helm feel, ${BROWSER} (${gpu})\n\n\`\`\`\n${JSON.stringify(results, null, 1)}\n\`\`\`\n`);
