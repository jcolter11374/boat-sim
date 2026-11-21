// Screenshots of a fresh load at 0.6, 1.5, 3, 4.8 and 6.5 s, in real Chrome on the real graphics card.
// SITE (default: the live site), OUT (file prefix). See docs/qa/title-load-2026-11.md.
import * as pw from "playwright";
const SITE = process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/";
const b = await pw.chromium.launch({ channel: "chrome", headless: false, args: ["--window-size=1600,900"] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const t0 = Date.now(); await p.goto(SITE, { waitUntil: "commit" });
for (const t of [600, 1500, 3000, 4800, 6500]) { await p.waitForTimeout(Math.max(0, t - (Date.now() - t0))); await p.screenshot({ path: `${process.env.OUT ?? "load"}-${t}.png` }); }
await b.close();
