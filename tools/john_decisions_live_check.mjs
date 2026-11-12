// John's decisions, checked on the LIVE site in a fresh browser.
// Each check maps to an item in the locked decisions list (T1, T2, S1, ...).
// Read-only: it only visits the public site.
//   node tools/john_decisions_live_check.mjs
import * as pw from "playwright";
import { appendFileSync } from "node:fs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const results = [];
const note = (id, ok, what, evidence) => {
  results.push({ id, ok, what, evidence });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} ${what} :: ${evidence}`);
};

async function fresh(browser, path, viewport = { width: 1280, height: 720 }) {
  const ctx = await browser.newContext({ viewport, serviceWorkers: "block" });
  const page = await ctx.newPage();
  await page.goto(SITE + path, { waitUntil: "load", timeout: 120_000 });
  return { ctx, page };
}
const visibleText = (page) => page.evaluate(() => document.body.innerText);

async function voyage(browser) {
  const { ctx, page } = await fresh(browser, "voyage.html");
  try {
    await page.waitForFunction(() => window.__replay && window.__replay.playing, null, { timeout: 120_000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const s = await page.evaluate(() => ({ warp: window.__replay.warp, playing: window.__replay.playing, sky: window.__replay.sky }));
    note("T2", s.playing && s.warp <= 1 / 3600 + 1e-9, "Watch a voyage opens playing in real time", `playing=${s.playing}, warp=${s.warp} voyage h/s (real time = ${(1 / 3600).toFixed(6)})`);
    const realBtn = page.locator('button[data-warp="0.000277778"]');
    const n = await realBtn.count();
    const vis = n ? await realBtn.first().isVisible() : false;
    note("T1-voyage", vis, "Real time button visible on Watch a voyage without opening a menu", `buttons=${n}, visible=${vis}`);
    const local = (await page.locator("#w-local").textContent().catch(() => "")) ?? "";
    note("S1-voyage", local.trim().length > 0, "Boat's local time shown on Watch a voyage", JSON.stringify(local.trim()));
    const sky = s.sky ?? {};
    note("L4-voyage", ["sunAz", "moonAz", "polarisAz"].every((k) => k in sky), "Sun, moon and North Star bearings available (sky guide)", JSON.stringify(Object.keys(sky)));
    note("C1-voyage", (await page.locator("#cinebtn").count()) > 0, "Cinematic button on Watch a voyage", "");
    await page.screenshot({ path: "jd-voyage.png" });
  } finally {
    await ctx.close();
  }
}

async function tracker(browser) {
  const { ctx, page } = await fresh(browser, "voyage.html?live");
  try {
    await page.waitForTimeout(15000);
    const t = await visibleText(page);
    const banner = await page.evaluate(() => window.__replay?.live?.banner);
    note("S2", !/\bsimulated\b/i.test(t) && !banner, "No 'simulated' banner on the live tracker", `banner=${banner}, text mentions simulated=${/\bsimulated\b/i.test(t)}`);
    await page.screenshot({ path: "jd-tracker.png" });
  } finally {
    await ctx.close();
  }
}

async function helm(browser) {
  const { ctx, page } = await fresh(browser, "helm.html");
  try {
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120_000 });
    const rates = await page.$$eval("#timebar button", (bs) => bs.map((b) => `${b.textContent.trim()}=${b.dataset.rate}`));
    const hasReal = rates.some((r) => /real|1×|1x/i.test(r) || /=0\.000277/.test(r));
    note("T1-helm", hasReal, "Real time is a speed choice on the helm time bar", rates.join(", "));
    note("S1-helm", (await page.locator("#local").count()) > 0, "Helm has a local-time line", "");
    note("C1-helm", (await page.locator("#cinebtn").count()) > 0, "Cinematic button on the helm", "");
    note("C3-helm", (await page.locator("#soundbtn").count()) > 0, "Sound on/off button on the helm", "");
    const firstThing = await page.evaluate(() => {
      const tb = document.querySelector("#timebar");
      return tb ? !tb.hidden && tb.offsetParent !== null : false;
    });
    note("T3", !firstThing, "Time speed is not shown before Set sail", `time bar visible on arrival=${firstThing}`);
    await page.screenshot({ path: "jd-helm.png" });
  } finally {
    await ctx.close();
  }
}

async function boatyard(browser) {
  const { ctx, page } = await fresh(browser, "boatyard.html");
  try {
    await page.waitForTimeout(12000);
    const t = await visibleText(page);
    const money = t.match(/\$\s?\d[\d,.]*|\bprice\b|\bcost\b/gi) ?? [];
    note("B7", money.length === 0, "No money shown in the Boatyard", money.slice(0, 5).join(" | ") || "none");
    note("B2-boatyard", /randolph/i.test(t) && /our model/i.test(t), "Randolph boat in the Boatyard, labelled our model", `randolph=${/randolph/i.test(t)}, our model=${/our model/i.test(t)}`);
    await page.screenshot({ path: "jd-boatyard.png" });
  } finally {
    await ctx.close();
  }
}

const browser = await pw.chromium.launch();
for (const f of [voyage, tracker, helm, boatyard]) {
  try {
    await f(browser);
  } catch (e) {
    note(f.name, false, "page check crashed", String(e).slice(0, 300));
  }
}
await browser.close();
const md = ["| Item | Result | Check | Evidence |", "|---|---|---|---|", ...results.map((r) => `| ${r.id} | ${r.ok ? "PASS" : "**FAIL**"} | ${r.what} | ${String(r.evidence).replace(/\|/g, "/")} |`)].join("\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## John's decisions on the live site\n\n${md}\n`);
console.log(md);
