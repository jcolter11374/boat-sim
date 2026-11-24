// Pictures of the harbour behind the Set sail card, as a player sees it: a chosen boat and window size
// (John, 24 Nov 2026, Beneteau First 31.7 in a 1911 x 898 window: "it looks terrible").
//
//   tools/build_boats.sh; tools/build_site.sh   (from the repo root)
//   node tools/qa/harbour-look.mjs <out.png> [boat name part, e.g. Beneteau] [width] [height] [query]
// Default query: gl=full (the real shaders even on software graphics; slow, a still picture only).
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const [out, boat = "Beneteau", w = "1911", h = "898", query = "gl=full"] = process.argv.slice(2);
const PORT = 4188, URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
try {
  const page = await (await browser.newContext({ viewport: { width: +w, height: +h } })).newPage();
  page.on("pageerror", (e) => console.log("page error:", e.message));
  await page.goto(`${URL}helm.html?${query}&dock=1`);
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 300000 });
  if (boat) {
    await page.evaluate(() => document.getElementById("ss-change").click()); // not page.click: at full graphics on software a frame can take seconds
    const picked = await page.evaluate((name) => {
      const r = [...document.querySelectorAll('input[name="boat"]')].find((i) => i.parentElement.textContent.includes(name));
      if (!r) return null;
      // As starting a game with her does (helm.ts rememberBoat): she is "my boat" from the next load on.
      const label = r.parentElement.querySelector("b")?.textContent ?? name;
      localStorage.setItem("boatsim.myboat.v1", JSON.stringify({ v: 1, kind: "stock", base: r.value, hash: "", name: label, choices: { base: r.value }, saved: new Date().toISOString() }));
      return label;
    }, boat);
    console.log("boat:", picked);
  }
  if (boat) {
    // The pick is kept in the browser: load the page again, so the picker is closed and she is there from the start.
    await page.reload();
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 300000 });
  }
  // The town and trees come in after the first frames: wait for them, then for a few frames of the new boat.
  await page.waitForFunction(() => window.__helm.land?.detail === "done" || window.__helm.land?.town, null, { timeout: 120000 }).catch(() => console.log("no 'done' from the land: taking the picture anyway"));
  const f = await page.evaluate(() => window.__helm.frames);
  await page.waitForFunction((f0) => window.__helm.frames > f0 + 6, f, { timeout: 300000 }).catch(() => {});
  console.log(JSON.stringify(await page.evaluate(() => ({ dock: window.__helm.dock, frames: window.__helm.frames, third: window.__helm.third, view: window.__helm.camView?.() }))));
  await page.screenshot({ path: out, timeout: 300000 });
} finally {
  await browser.close();
  server.kill();
}
