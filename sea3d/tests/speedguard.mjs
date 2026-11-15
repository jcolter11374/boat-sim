// The speed guard in the fast PR checks (Omar's speed list, rank 19, 14 Nov 2026): today's
// speed wins don't quietly come back. Runner times vary about threefold between machines, so it
// guards counts, not times:
//   - shader programs built after Set sail on the sailing screen (0 since #606: a new one froze
//     the first seconds of the voyage),
//   - shader programs built in all on the title, the sailing screen and a voyage replay,
//   - draw calls per frame at Low on each of them (the middle of about 40 drawn frames).
// The baseline is tests/speed-baseline.json, measured on main. A count above its baseline by
// more than its margin fails, naming the count. When an increase is intended (a new effect worth
// its cost), re-measure and commit the new baseline in the same PR:
//   npm run build && npm run test:speed -- --update   (or copy the counts the failed quick job printed:
//   the baseline is the runner's, which has the Blender boats a local build may lack)
// SITE=http://host:port/ uses a site already being served instead of starting vite preview.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { writeFixture } from "./fixture-voyage.mjs";
import { chromium } from "playwright";

const BASELINE = new URL("./speed-baseline.json", import.meta.url);
const update = process.argv.includes("--update");
const SITE = process.env.SITE ?? "http://localhost:4175/";
const server = process.env.SITE ? null : spawn("node_modules/.bin/vite", ["preview", "--port", "4175", "--strictPort"], { stdio: "inherit" });
const t0 = Date.now();
let browser;
const stop = async (code) => {
  await browser?.close().catch(() => {});
  server?.kill();
  process.exit(code);
};

/** Counts every shader program linked and every draw call, from the page's first script on. */
function instrument() {
  const P = WebGL2RenderingContext.prototype;
  const g = (window.__speed = { programs: 0, draws: 0, frames: [] });
  const link = P.linkProgram;
  P.linkProgram = function (p) {
    g.programs++;
    // After Set sail, what each one is, to say in a failure (SHADER_NAME, else its first defines).
    if (g.after) {
      const src = (this.getAttachedShaders(p) || []).map((x) => this.getShaderSource(x) || "").join("\n");
      const name = [(src.match(/#define SHADER_TYPE (.*)/) || [])[1], (src.match(/#define SHADER_NAME (.*)/) || [])[1]].filter(Boolean).join(" ");
      // A ShaderMaterial without a name: its own uniforms (after three's built-in ones) say which it is.
      const own = [...src.matchAll(/uniform\s+\w+\s+(\w+)/g)].map((m) => m[1]).filter((u, i, a) => !/^(modelMatrix|modelViewMatrix|projectionMatrix|viewMatrix|normalMatrix|cameraPosition|isOrthographic)$/.test(u) && a.indexOf(u) === i).slice(0, 6);
      g.after.push([name, (src.match(/#define (USE_\w+|STANDARD|PHYSICAL)/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(" "), own.length ? `uniforms ${own.join(" ")}` : ""].filter(Boolean).join("; ") || `${src.length} characters`);
    }
    return link.call(this, p);
  };
  for (const fn of ["drawArrays", "drawElements", "drawArraysInstanced", "drawElementsInstanced", "drawRangeElements"]) {
    const o = P[fn];
    P[fn] = function (...a) {
      g.draws++;
      return o.apply(this, a);
    };
  }
  // Draw calls between two frames of our own: one frame of the page's (frames it skipped are 0).
  let last = 0;
  const tick = () => {
    g.frames.push(g.draws - last);
    last = g.draws;
    if (g.frames.length > 4000) g.frames.splice(0, 2000);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** Wait until no program has been built for `quietMs` (the page's warm-up is over), at most `maxMs`. */
async function settled(page, quietMs = 3000, maxMs = 30_000) {
  const end = Date.now() + maxMs;
  let n = await page.evaluate(() => window.__speed.programs);
  let since = Date.now();
  while (Date.now() < end) {
    await page.waitForTimeout(250);
    const m = await page.evaluate(() => window.__speed.programs);
    if (m !== n) [n, since] = [m, Date.now()];
    else if (Date.now() - since >= quietMs) break;
  }
  return n;
}

/** Draw calls per drawn frame: the middle of the next 40 frames that drew anything. */
async function drawsPerFrame(page, where) {
  const from = await page.evaluate(() => window.__speed.frames.length);
  await page
    .waitForFunction((f) => window.__speed.frames.slice(f).filter((d) => d > 0).length >= 40, from, { timeout: 60_000, polling: 200 })
    .catch(() => {});
  const d = (await page.evaluate((f) => window.__speed.frames.slice(f), from)).filter((x) => x > 0).sort((a, b) => a - b);
  if (d.length < 10) throw new Error(`${where}: only ${d.length} frames drew in a minute`);
  return d[d.length >> 1];
}

const counts = {};
let afterSail = [];
let env = "";
try {
  for (let i = 0; i < 50 && server; i++) {
    try { if ((await fetch(SITE)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  browser = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const open = async (path) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await ctx.addInitScript(instrument);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => console.error(`page error (${path}): ${e}`));
    await page.goto(SITE + path, { timeout: 60_000 });
    return { ctx, page };
  };

  // The title.
  {
    const { ctx, page } = await open("?quality=low");
    env = await page.evaluate(() => {
      const gl = document.createElement("canvas").getContext("webgl2");
      const dbg = gl?.getExtension("WEBGL_debug_renderer_info");
      const out = `${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? navigator.userAgent}; ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : "?"}; parallel compile ${!!gl?.getExtension("KHR_parallel_shader_compile")}`;
      gl?.getExtension("WEBGL_lose_context")?.loseContext(); // a throwaway context (Maya, #615)
      return out;
    });
    await page.waitForFunction(() => (window.__sea3d?.frames ?? 0) > 10, null, { timeout: 60_000 });
    counts.titlePrograms = await settled(page);
    counts.titleDraws = await drawsPerFrame(page, "title");
    await ctx.close();
  }

  // The sailing screen: warm-up, Set sail (Go: the simulator starts), sailing.
  {
    const { ctx, page } = await open("helm.html?quality=low");
    await page.waitForFunction(() => window.__helm && document.getElementById("go") && !document.getElementById("go").disabled, null, { timeout: 60_000 });
    // The page's own word that everything queued behind the card is built (helm.ts page.warmed): on a
    // slow runner a 3 s lull came mid-warm-up and the click beat its last shader (Maya, #616).
    await page.waitForFunction(() => window.__helm.warmed, null, { timeout: 180_000, polling: 250 }).catch(() => console.log("  (the sailing screen never said its shaders were built: clicking anyway)"));
    const before = await settled(page);
    const h0 = await page.evaluate(() => window.__helm.hour);
    await page.evaluate(() => {
      window.__speed.after = [];
      document.getElementById("go").click();
    });
    await page.waitForFunction((h) => window.__helm.ready && window.__helm.hour > h + 0.001, h0, { timeout: 120_000, polling: 100 });
    const after = await settled(page);
    // Counted from the click itself: on a slow runner the warm-up can still be building when it lands.
    afterSail = await page.evaluate(() => window.__speed.after);
    counts.sailProgramsAfterSetSail = afterSail.length;
    if (after - before !== afterSail.length) console.log(`  (${after - before - afterSail.length} programs built between the warm-up seeming done and the click)`);
    counts.sailPrograms = after;
    counts.sailDraws = await drawsPerFrame(page, "sailing screen");
    await ctx.close();
  }

  // A voyage replay (the fixture voyage when the build has no real ones, as quick.mjs does).
  {
    const real = existsSync("dist/voyages/index.json");
    const dir = real ? "voyages" : "voyages-fixture";
    if (!real && !existsSync(`dist/${dir}/index.json`)) writeFixture(`dist/${dir}`);
    const { ctx, page } = await open(`voyage.html?quality=low&data=./${dir}`);
    await page.waitForFunction(() => window.__replay?.ready || window.__replay?.error, null, { timeout: 60_000 });
    counts.voyagePrograms = await settled(page);
    counts.voyageDraws = await drawsPerFrame(page, "voyage replay");
    await ctx.close();
  }
} catch (e) {
  console.error("FAIL: the speed guard couldn't measure:", e?.message ?? e);
  await stop(1);
}

const what = {
  sailProgramsAfterSetSail: "shader programs built after Set sail on the sailing screen",
  titlePrograms: "shader programs built on the title",
  sailPrograms: "shader programs built on the sailing screen",
  voyagePrograms: "shader programs built on a voyage replay",
  titleDraws: "draw calls per frame on the title at Low",
  sailDraws: "draw calls per frame on the sailing screen at Low",
  voyageDraws: "draw calls per frame on a voyage replay at Low",
};
const base = JSON.parse(readFileSync(BASELINE, "utf8"));
console.log(`speed guard (${Math.round((Date.now() - t0) / 1000)} s; ${env}):`);
for (const k of Object.keys(what)) console.log(`  ${k}: ${counts[k]} (baseline ${base.counts[k] ?? "none"})`);

if (update) {
  base.counts = counts;
  base.measured = new Date().toISOString().slice(0, 10);
  writeFileSync(BASELINE, JSON.stringify(base, null, 2) + "\n");
  console.log("baseline updated: commit tests/speed-baseline.json with the change that needs it");
  await stop(0);
}

const over = [];
for (const k of Object.keys(what)) {
  const b = base.counts[k];
  if (b === undefined) continue;
  const m = base.margins[k] ?? base.margins.default;
  const limit = Math.floor(b + Math.max(m.add ?? 0, b * (m.share ?? 0)));
  if (counts[k] > limit)
    over.push(
      `${what[k]}: ${counts[k]}, above the baseline ${b} by more than the margin (limit ${limit})` +
        (k === "sailProgramsAfterSetSail" ? `\n    built after Set sail: ${afterSail.join("; ")}\n    (warm them behind the Set sail card: helm.ts warmShaders, or a stand-in as wildlife.ts standIns())` : ""),
    );
}
if (over.length) {
  console.error("FAIL: speed guard, a count went up:\n  " + over.join("\n  "));
  console.error(
    "If the increase is intended (a new effect worth its cost), re-measure and commit the new baseline in this PR (or copy the counts above, measured on the runner):\n" +
      "  cd sea3d && npm run build && npm run test:speed -- --update   (tests/speed-baseline.json)",
  );
  await stop(1);
}
console.log("OK (speed guard): no count above its baseline");
await stop(0);
