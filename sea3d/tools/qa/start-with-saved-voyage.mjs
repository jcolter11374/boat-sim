// A voyage of yours is at sea, and you come back to the Set sail card (John, 24 Nov 2026: "this doesn't
// start"). Sails two days so the browser saves the voyage, opens the card again and checks: "Continue your
// voyage" is the bright button, the start button says "Start a new crossing" and is never dimmed, one press
// asks, and a second press of the same button starts the new crossing.
//
//   tools/build_site.sh   (from the repo root)
//   PYODIDE_DIR=... [OUT=<picture folder>] node tools/qa/start-with-saved-voyage.mjs
// Exits 1 on a failed check.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
const PORT = 4187, URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
  const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
  const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
  route.fulfill({ body: readFileSync(`${process.env.PYODIDE_DIR}/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
});
const page = await context.newPage();
let bad = 0;
const check = (ok, words) => { console.log(`${ok ? "ok  " : "FAIL"} ${words}`); if (!ok) bad++; };
const shot = (n) => (process.env.OUT ? page.screenshot({ path: `${process.env.OUT}/${n}.png` }) : null);
page.on("pageerror", (e) => console.log("page error:", e.message));
page.on("console", (m) => m.type() === "error" && console.log("console error:", m.text().slice(0, 200)));
const q = process.argv[2] ?? "quality=low";
await page.goto(`${URL}helm.html?${q}`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await page.click("#go");
await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 300000 });
await page.click('#timebar .rate[data-rate="24"]').catch(() => {});
await page.waitForFunction(() => (window.__helm.status?.day ?? 0) > 2 || !document.getElementById("decide").hidden, null, { timeout: 120000 }).catch(() => {});
await page.keyboard.press("Escape");
await page.waitForTimeout(3000);
console.log("day", await page.evaluate(() => window.__helm.status?.day), "saved:", await page.evaluate(() => !!localStorage.getItem("boatsim.voyage.v1")));
// come back to the Set sail card
await page.goto(`${URL}helm.html?${q}`);
await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 120000 });
await page.waitForTimeout(3000);
await shot("1-card");
const dim = () => page.evaluate(() => { const c = getComputedStyle(document.getElementById("go")); return Number(c.opacity) < 0.9 || document.getElementById("go").disabled; });
check((await page.textContent("#go")).trim() === "Start a new crossing", `the start button says "${(await page.textContent("#go")).trim()}"`);
check(await page.isVisible("#ss-continue-go"), '"Continue your voyage" is offered');
check(!(await dim()), "the start button is not dimmed");
const t0 = Date.now();
await page.click("#go");
await page.waitForTimeout(500);
check(await page.isVisible("#ss-ask"), "one press asks before ending the voyage at sea");
check((await page.textContent("#go")).trim() === "Yes, end it and start a new one" && !(await dim()), `the same button is now the yes, and not dimmed: "${(await page.textContent("#go")).trim()}"`);
await shot("2-ask");
await page.click("#go");
const started = await page.waitForFunction(() => window.__helm.ready && !window.__helm.busy && (window.__helm.status?.day ?? 9) < 1, null, { timeout: 120000 }).then(() => true).catch(() => false);
check(started, `a second press starts the new crossing (${((Date.now() - t0) / 1000).toFixed(0)} s after the first press)`);
await shot("3-started");
await browser.close(); server.kill(); process.exit(bad ? 1 : 0);
