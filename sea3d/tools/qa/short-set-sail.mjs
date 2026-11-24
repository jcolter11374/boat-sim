// Checks the short Set sail card (John, 24 Nov 2026: "overly complicated") in a headless browser and
// takes its pictures:
//  1. the plain card opens short: Who steers, Race against, challenges and today's weather are hidden;
//  2. opening "More ways to sail" shows them, and the first of them is in view (not scrolled past);
//  3. a link that shows them (?who=autopilot) keeps them when "You" is pressed.
// Run at a desktop window and at a phone's.
//
//   npm run build   (or tools/build_site.sh from the repo root, for her voyages)
//   node tools/qa/short-set-sail.mjs [picture folder]
//
// Exits 1 if any check fails.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const PORT = 4183;
const URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
let bad = 0;
const check = (ok, words) => { console.log(`${ok ? "ok  " : "FAIL"} ${words}`); if (!ok) bad++; };
const rows = (page) => page.evaluate(() => {
  const card = document.getElementById("ss-card").getBoundingClientRect();
  const one = (id) => {
    const e = document.getElementById(id);
    const b = e.getBoundingClientRect();
    return { hidden: e.hidden, inView: !e.hidden && b.top >= card.top - 1 && b.top < Math.min(card.bottom, innerHeight) };
  };
  return { who: one("ss-who"), rival: one("ss-rival"), ch: one("ss-ch"), today: one("ss-today"), card: Math.round(card.height), open: document.getElementById("more").open };
});

for (const [name, viewport] of [["desktop", { width: 1280, height: 800 }], ["phone", { width: 390, height: 844 }]]) {
  const page = await browser.newPage({ viewport });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`${URL}helm.html?quality=low`);
  await page.waitForFunction(() => document.querySelector("#ss-when-opts .ss-pill"), null, { timeout: 120000 });
  await page.waitForFunction(() => !document.body.classList.contains("ss-filling"), null, { timeout: 30000 }).catch(() => {});
  let r = await rows(page);
  console.log(`${name}: short card ${r.card} px`);
  check(r.who.hidden && r.rival.hidden && r.ch.hidden && r.today.hidden, `${name}: the plain card opens short`);
  if (out) await page.screenshot({ path: `${out}/card-short${name === "phone" ? "-phone" : ""}.png` });
  await page.click("#more > summary");
  await page.waitForTimeout(400);
  r = await rows(page);
  const shown = ["who", "rival", "ch", "today"].filter((k) => !r[k].hidden);
  console.log(`${name}: opened, shows ${shown.join(", ") || "nothing more"}; card ${r.card} px`);
  check(shown.length > 0, `${name}: opening More ways to sail shows the other rows`);
  check(shown.length > 0 && r[shown[0]].inView, `${name}: the first of them (${shown[0]}) is in view`);
  if (out) await page.screenshot({ path: `${out}/card-open${name === "phone" ? "-phone" : ""}.png` });

  await page.goto(`${URL}helm.html?quality=low&who=autopilot`);
  await page.waitForFunction(() => !document.getElementById("ss-who").hidden, null, { timeout: 120000 }).catch(() => {});
  r = await rows(page);
  if (r.who.hidden) console.log(`${name}: no voyages in this build, so the link check is skipped`);
  else {
    await page.evaluate(() => [...document.querySelectorAll("#ss-who-opts .ss-pill")].find((b) => b.textContent === "You").click());
    await page.waitForTimeout(300);
    r = await rows(page);
    check(!r.who.hidden, `${name}: ?who=autopilot then "You" keeps Who steers on the card`);
  }
  await page.close();
}
await browser.close();
server.kill();
process.exit(bad ? 1 : 0);
