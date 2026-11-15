// Title load on the real GPU with ?perf: cold load, then a warm reload in the same browser.
// SITE (default live), WAIT ms per load (default 15000), OUT file prefix.
// See docs/qa/title-load-2026-11.md.
import * as pw from "playwright";
import fs from "node:fs";
const SITE = process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/";
const WAIT = Number(process.env.WAIT ?? 15000);
const OUT = process.env.OUT ?? "perfrun";
const url = SITE + (SITE.includes("?") ? "&" : "?") + "perf";
const browser = await pw.chromium.launch({ channel: "chrome", headless: false, args: ["--window-size=1600,900"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const summary = (r) => ({ frames: r.frames, median: r.median, p99: r.p99, worst: r.worst, over50: r.over50, over100: r.over100, stalls: (r.stalls ?? []).map((s) => `${Math.round(s.at)}ms:${Math.round(s.ms)} prog=${s.prog} link=${s.linkMs} wait=${s.waitMs} up=${s.upMs}/${s.upB} sync=${s.syncMs}`) });
for (const label of ["cold", "warm"]) {
  if (label === "cold") await page.goto(url); else await page.reload();
  await page.waitForTimeout(WAIT);
  const r = await page.evaluate(() => window.__perf?.report());
  fs.writeFileSync(`${OUT}-${label}.json`, JSON.stringify(r, null, 1));
  console.log(label, JSON.stringify(summary(r ?? {}), null, 1));
}
await browser.close();
