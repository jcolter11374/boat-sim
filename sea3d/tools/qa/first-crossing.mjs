// Plays a first visit in a headless browser (John, 24 Nov 2026: "New players will have no idea what
// to do") and checks the guided first crossing (src/helm/guide.ts), with pictures:
//  1. with nothing saved, the title's Set sail says "Start here" and goes straight to sea: no Set sail card;
//  2. at sea the goal card says what the game is and who the ghost is, and the orders drawer stays shut;
//  3. after it, one tip: time runs by itself, nothing to do yet;
//  4. the first decision card says what a decision is; choosing brings the steering tip, and steering ends it;
//  5. back on the title she is no longer new: Continue is offered and Set sail opens the card; a reload at sea
//     does not start a new crossing over the one at sea;
//  6. someone who has played before gets none of it: the drawer opens with its coach line, as before.
//
//   tools/build_site.sh   (from the repo root: the page and the simulator)
//   node tools/qa/first-crossing.mjs [picture folder]
//
// Thread sandboxes can't reach the Pyodide CDN: PYODIDE_DIR=<unpacked pyodide release> serves it from
// disk, as tests/smoke.mjs does. Exits 1 if any check fails.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const PORT = 4185;
const URL = `http://localhost:${PORT}/`;
const server = spawn("node_modules/.bin/vite", ["preview", "--port", String(PORT), "--strictPort"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
let bad = 0;
const check = (ok, words) => { console.log(`${ok ? "ok  " : "FAIL"} ${words}`); if (!ok) bad++; };
const Q = process.env.QUALITY ?? "low";

async function fresh(viewport) {
  const context = await browser.newContext({ viewport });
  if (process.env.PYODIDE_DIR) {
    await context.route("https://cdn.jsdelivr.net/pyodide/v0.27.7/full/**", (route) => {
      const name = new globalThis.URL(route.request().url()).pathname.split("/").pop();
      const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".json") ? "application/json" : "application/octet-stream";
      route.fulfill({ body: readFileSync(`${process.env.PYODIDE_DIR}/${name}`), contentType: type, headers: { "access-control-allow-origin": "*" } });
    });
  }
  const page = await context.newPage();
  page.on("pageerror", (e) => { console.error("page error:", e.message); bad++; });
  return { context, page };
}
const shown = (page, id) => page.evaluate((i) => { const e = document.getElementById(i); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 2 && r.height > 2 && s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.5; }, id);
const text = (page, id) => page.evaluate((i) => document.getElementById(i)?.textContent?.replace(/\s+/g, " ").trim() ?? "", id);
const shot = async (page, name) => { if (out) await page.screenshot({ path: `${out}/${name}.png` }).catch(() => {}); };

for (const [name, viewport] of [["desktop", { width: 1280, height: 720 }], ["phone", { width: 390, height: 844 }]]) {
  const sfx = name === "phone" ? "-phone" : "";
  const { context, page } = await fresh(viewport);
  // 1. The title, nothing saved.
  await page.goto(`${URL}?quality=${Q}`);
  await page.waitForSelector("#t-setsail");
  await page.waitForTimeout(3000);
  const link = await page.evaluate(() => { const a = document.getElementById("t-setsail"); const s = a.querySelector("small"); return { href: a.getAttribute("href"), first: a.classList.contains("first"), line: s.textContent, lineShown: getComputedStyle(s).display !== "none", cont: !document.getElementById("t-continue").hidden }; });
  check(link.first && /helm\.html\?sail$/.test(link.href) && !link.cont, `${name}: a first visit's Set sail goes straight to sea (${link.href})`);
  check(link.lineShown && /^Start here\./.test(link.line), `${name}: it says "${link.line}"`);
  await shot(page, `1-title${sfx}`);
  // 2. Straight to sea: no card, then the goal.
  await page.goto(`${URL}helm.html?sail&quality=${Q}`);
  await page.waitForTimeout(1500);
  check(!(await shown(page, "start")), `${name}: no Set sail card on the way`);
  await page.waitForFunction(() => document.body.classList.contains("goal"), null, { timeout: 240000 });
  await page.waitForTimeout(1200);
  const goal = await text(page, "goalcard");
  check(/across the Atlantic/.test(goal) && /the ghost/.test(goal) && /before it/.test(goal), `${name}: the goal card says what the game is: "${goal.slice(0, 80)}..."`);
  check(!(await page.evaluate(() => document.getElementById("orders").classList.contains("open"))), `${name}: the orders drawer is shut`);
  await shot(page, `2-goal${sfx}`);
  // 3. One tip: nothing to do yet.
  await page.mouse.click(viewport.width / 2, viewport.height / 2);
  await page.waitForFunction(() => { const t = document.getElementById("tip"); return !t.hidden && t.classList.contains("in"); }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(900);
  check((await shown(page, "tip")) && /^Nothing to do yet\./.test(await text(page, "tip")), `${name}: then one tip: "${(await text(page, "tip")).slice(0, 60)}..."`);
  check(!(await page.evaluate(() => document.getElementById("orders").classList.contains("open"))), `${name}: the drawer is still shut`);
  await shot(page, `3-tip-time${sfx}`);
  // 4. The first decision.
  await page.waitForFunction(() => !document.getElementById("decide").hidden, null, { timeout: 400000 });
  await page.waitForTimeout(1500);
  check((await shown(page, "tip")) && /^Your first decision\./.test(await text(page, "tip")), `${name}: the first decision comes with one tip that says what a decision is`);
  const fits = await page.evaluate(() => { const last = document.querySelector("#decidebtns button:last-child").getBoundingClientRect(); const strip = document.getElementById("strip").getBoundingClientRect(); const tip = document.getElementById("tip").getBoundingClientRect(); const card = document.getElementById("decide").getBoundingClientRect(); return { options: last.bottom <= Math.min(innerHeight, strip.top) + 1 || last.bottom <= innerHeight && (last.left >= strip.right || last.right <= strip.left), clear: tip.bottom <= card.top || tip.right <= card.left || tip.left >= card.right }; });
  check(fits.clear, `${name}: the tip is clear of the decision card`);
  if (name === "desktop") check(fits.options, "desktop: every option is on the screen, above the instruments");
  await shot(page, `4-first-decision${sfx}`);
  await page.click("#decidebtns button:last-child");
  await page.waitForFunction(() => { const t = document.getElementById("tip"); return !t.hidden && t.classList.contains("in"); }, null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(900);
  const steer = await text(page, "tip");
  check((await shown(page, "tip")) && /^You can steer her yourself/.test(steer), `${name}: then the steering tip: "${steer.slice(0, 70)}..."`);
  await shot(page, `5-tip-steer${sfx}`);
  if (name === "desktop") {
    check(await shown(page, "keyhint"), "desktop: the key line is up with it");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(1200);
    check(!(await shown(page, "tip")), "desktop: steering ends the tip");
  } else {
    await page.click("#tip-x");
    await page.waitForTimeout(1200);
    check(!(await shown(page, "tip")), "phone: Got it ends the tip");
  }
  // A second decision has no help line. Jump ahead to it if one comes within the wait.
  await page.keyboard.press("5");
  const second = await page.waitForFunction(() => !document.getElementById("decide").hidden, null, { timeout: 240000 }).then(() => true, () => false);
  if (second) check(!(await shown(page, "tip")), `${name}: the second decision has no tip`);
  else console.log(`${name}: no second decision in the wait, so that check is skipped`);
  // 5. Back on the title: not new any more.
  await page.goto(`${URL}?quality=${Q}`);
  await page.waitForSelector("#t-setsail");
  await page.waitForTimeout(2500);
  const back = await page.evaluate(() => { const a = document.getElementById("t-setsail"); return { href: a.getAttribute("href"), first: a.classList.contains("first"), cont: !document.getElementById("t-continue").hidden }; });
  check(!back.first && /helm\.html$/.test(back.href), `${name}: after that, Set sail opens the card (${back.href})`);
  check(back.cont, `${name}: and Continue your voyage is offered`);
  // A reload of the crossing's own address (it keeps ?sail) must not start a new one over the voyage at sea.
  await page.goto(`${URL}helm.html?sail&quality=${Q}`);
  await page.waitForFunction(() => document.querySelector("#ss-when-opts .ss-pill"), null, { timeout: 120000 }).catch(() => {});
  await page.waitForTimeout(1500);
  check((await shown(page, "start")) && (await shown(page, "ss-continue")), `${name}: a reload with her at sea shows the card with Continue, and does not set sail again`);
  await context.close();
}

// 6. Someone who has played before: the opening as it was.
{
  const { context, page } = await fresh({ width: 1280, height: 720 });
  await page.addInitScript(() => localStorage.setItem("boatsim.myboat.v1", JSON.stringify({ v: 1, kind: "yard", base: "kayak", hash: "", name: "Our kayak", choices: {}, saved: "2026-11-24T00:00:00Z" })));
  await page.goto(`${URL}?quality=${Q}`);
  await page.waitForSelector("#t-setsail");
  await page.waitForTimeout(2000);
  const link = await page.evaluate(() => { const a = document.getElementById("t-setsail"); return { href: a.getAttribute("href"), lineShown: getComputedStyle(a.querySelector("small")).display !== "none" }; });
  check(/helm\.html$/.test(link.href) && !link.lineShown, "a returning player's Set sail opens the card, with no extra line");
  await page.goto(`${URL}helm.html?quality=${Q}`);
  await page.waitForFunction(() => document.querySelector("#ss-when-opts .ss-pill"), null, { timeout: 120000 });
  await page.click("#go");
  await page.waitForFunction(() => document.body.classList.contains("goal"), null, { timeout: 240000 });
  await page.waitForTimeout(1000);
  check(/^Beat the autopilot to Portugal\./.test(await text(page, "goalcard")), "a returning player's goal card is the short one");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.getElementById("orders").classList.contains("open"), null, { timeout: 15000 }).catch(() => {});
  check(await page.evaluate(() => document.getElementById("orders").classList.contains("open")), "and the orders drawer opens with its coach line");
  check(!(await shown(page, "tip")), "with no tip");
  await context.close();
}
await browser.close();
server.kill();
process.exit(bad ? 1 : 0);
