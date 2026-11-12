// The quick pre-merge smoke (coordinator, 12 Nov: merge fast, test the whole game nightly).
// A few minutes in Chromium on the built site: every page opens without a page error,
// the sea page and a voyage replay draw and keep animating, and every speed bar still
// offers Real time (the voyage replay's, the race's and the helm's). The full smoke
// (tests/smoke.mjs) and the playtests run nightly on main.
//
// Run after `npm run build` (or on the site build_site.sh makes). Needs Playwright + Chromium.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFixture, writeRaceFixture } from "./fixture-voyage.mjs";
import { chromium } from "playwright";

const URL = "http://localhost:4174/";
const server = spawn("node_modules/.bin/vite", ["preview", "--port", "4174", "--strictPort"], { stdio: "inherit" });
const t0 = Date.now();
const done = [];
let browser;
const fail = async (msg) => {
  console.error("FAIL:", msg);
  await browser?.close().catch(() => {});
  server.kill();
  process.exit(1);
};

/** A speed bar's Real time button: there and enabled, and (if `shown`) on screen now. */
async function realTime(page, sel, where, shown = true) {
  const ok = await page.evaluate(([s, shown]) => {
    const b = document.querySelector(s);
    return !!b && /real time/i.test(b.textContent ?? "") && !b.disabled && (!shown || (!b.closest("[hidden]") && getComputedStyle(b).display !== "none"));
  }, [sel, shown]);
  if (!ok) await fail(`${where}: no Real time on the speed bar (${sel})`);
  done.push(`${where} real time`);
}

/** The page keeps drawing: its frame counter moves. */
async function animates(page, expr, where) {
  const f0 = await page.evaluate(expr);
  await page.waitForFunction(([e, n]) => (0, eval)(e) > n + 3, [expr, f0], { timeout: 60_000 }).catch(() => fail(`${where}: not animating`));
}

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`${page.url()}: ${e}`));

  // Every page opens.
  for (const p of ["", "boatyard.html", "leaderboard.html", "race.html"]) {
    await page.goto(`${URL}${p}?quality=low`, { waitUntil: "load", timeout: 60_000 });
    await page.waitForTimeout(1500);
    done.push(p || "title");
  }

  // A voyage replay: draws, animates, Real time on its speed bar.
  const real = existsSync("dist/voyages/index.json");
  const dataDir = real ? "voyages" : "voyages-fixture";
  if (!real) writeFixture(`dist/${dataDir}`);
  await page.goto(`${URL}voyage.html?quality=low&data=./${dataDir}`, { timeout: 60_000 });
  await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 60_000 }).catch(() => fail("voyage: never ready"));
  const verr = await page.evaluate(() => window.__replay.error);
  if (verr) await fail(`voyage: ${verr}`);
  await animates(page, "window.__replay.frames", "voyage");
  await realTime(page, '[data-warp="0.000277778"]', "voyage");
  const png = await page.screenshot();
  if (png.length < 20_000) await fail(`voyage looks blank (${png.length} bytes)`);

  // The race replay: the same speed bar.
  if (!existsSync("dist/voyages-race-fixture/index.json")) writeRaceFixture("dist/voyages-race-fixture");
  await page.goto(`${URL}voyage.html?quality=low&data=./voyages-race-fixture&race=2020-05-01`, { timeout: 60_000 });
  await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 60_000 }).catch(() => fail("race: never ready"));
  await realTime(page, '[data-warp="0.000277778"]', "race");

  // The helm: draws, animates, Real time on its speed bar (no simulator run: that's nightly).
  await page.goto(`${URL}helm.html?quality=low`, { timeout: 60_000 });
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 60_000 }).catch(() => fail("helm: never drew"));
  await animates(page, "window.__helm.frames", "helm");
  // The helm's time bar shows once a voyage is running (after Go, which runs the simulator).
  await realTime(page, '[data-rate="rt"]', "helm", false);

  if (errors.length) await fail(`page errors: ${errors.join("; ")}`);
  console.log(`OK (quick, ${Math.round((Date.now() - t0) / 1000)} s): ${done.join(", ")}`);
  await browser.close();
  server.kill();
} catch (e) {
  await fail(String(e));
}
