// Smoke test: serve the built page, load it in a headless browser, check that
// it animates, that the sea's wave height matches the chosen sea state, and
// that the picture isn't blank. Saves a screenshot to test-output/.
//
// Run after `npm run build`. Needs the `playwright` package and Chromium.
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const URL = "http://localhost:4173/";
const server = spawn("npx", ["vite", "preview", "--port", "4173", "--strictPort"], { stdio: "inherit" });
const fail = (msg) => { console.error("FAIL:", msg); server.kill(); process.exit(1); };

try {
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(URL)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(URL);
  await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 10, null, { timeout: 30000 });

  const hs = await page.evaluate(() => window.__sea3d.hs);
  if (Math.abs(hs - 1.5) > 1e-6) fail(`moderate sea should have Hs 1.5 m, got ${hs}`);

  await page.selectOption("#sea", "gale");
  await page.waitForTimeout(300);
  const hsGale = await page.evaluate(() => window.__sea3d.hs);
  if (Math.abs(hsGale - 5.0) > 1e-6) fail(`gale should have Hs 5 m, got ${hsGale}`);

  mkdirSync("test-output", { recursive: true });
  const png = await page.screenshot({ path: "test-output/sea-gale.png" });
  // A blank canvas compresses to almost nothing; a rendered sea doesn't.
  if (png.length < 20000) fail(`screenshot looks blank (${png.length} bytes)`);
  if (errors.length) fail(`page errors: ${errors.join("; ")}`);

  await browser.close();
  console.log(`OK: animates, Hs moderate ${hs} m, gale ${hsGale} m, screenshot ${png.length} bytes`);
} catch (e) {
  fail(String(e));
}
server.kill();
