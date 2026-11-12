#!/usr/bin/env node
// Proof frames and clips from a built site, the same way on every branch (Ada, 12 Nov).
//
//   node tools/proof/capture.mjs --site http://localhost:4180/ --out proofs [--set standard]
//        [--shard 1/4] [--only kayak-f8] [--size 1920x1080] [--quality ultra] [--fps 24] [--list]
//
// The shots (boats, seas, times of day, camera views, clips and the named sets) are in
// tools/proof/shots.json. Each "unit" is one page load: a boat in one sea at one time of
// day, with its still views, or one clip. --shard i/n renders the i-th share of the units,
// balanced by cost, so n machines can split a set.
//
// Why clips come out smooth on software graphics: the page's clock is held, and each frame
// is stepped exactly 1/fps seconds of page time before it is captured, however long the
// frame takes to draw (about 5 s a frame at High on a CI runner). Math.random is seeded,
// so the cinematic picks the same shots every run.
//
// Needs the page hooks in voyage.ts (__replay.cam, force.sea, sunAt). A branch from before
// them still renders, with the logged sea and the page's own camera, and says so.
import { createRequire } from "node:module";
import { execFileSync, execSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");

function loadPlaywright() {
  const tries = [join(REPO, "sea3d", "package.json"), join(HERE, "package.json")];
  try {
    tries.push(join(execSync("npm root -g", { encoding: "utf8" }).trim(), "noop.json"));
  } catch {
    /* no npm */
  }
  for (const t of tries) {
    try {
      return createRequire(t)("playwright");
    } catch {
      /* next */
    }
  }
  throw new Error("playwright not found: npm install --no-save playwright@1 in sea3d/");
}

// ---------- arguments ----------
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(`--${name}`);
const SHOTS = JSON.parse(readFileSync(opt("shots", join(HERE, "shots.json")), "utf8"));
const SET_NAME = opt("set", "standard");
const SET = SHOTS.sets[SET_NAME];
if (!SET) throw new Error(`no set "${SET_NAME}" in shots.json (have: ${Object.keys(SHOTS.sets).join(", ")})`);
const SITE = opt("site", "http://localhost:4180/").replace(/\/?$/, "/");
const OUT = resolve(opt("out", "proofs"));
const [SHARD, SHARDS] = opt("shard", "1/1").split("/").map(Number);
const ONLY = opt("only", "") ? new RegExp(opt("only")) : null;
const [W, H] = opt("size", SET.size ?? "1280x720").split("x").map(Number);
const QUALITY = opt("quality", SET.quality ?? "high");
const FPS = Number(opt("fps", "24"));
const WARM_STEPS = Number(opt("warm", "24")); // 100 ms steps at a small size before each unit: 2.4 s for the boat and wake to settle

// ---------- units ----------
const units = [];
const cross = (spec, fn) => {
  for (const boat of spec.boats ?? []) for (const sea of spec.seas ?? []) for (const time of spec.times ?? []) fn(boat, sea, time);
};
cross(SET, (boat, sea, time) => {
  if (SET.views?.length) units.push({ id: `${boat}-${sea}-${time}`, boat, sea, time, views: SET.views, cost: SET.views.length + 4 });
});
for (const c of SET.clips ?? []) {
  cross(c, (boat, sea, time) => {
    for (const clip of c.clips) {
      const secs = SHOTS.clips[clip].seconds;
      units.push({ id: `${boat}-${sea}-${time}-${clip}`, boat, sea, time, clip, cost: secs * FPS + 4 });
    }
  });
}
for (const u of units) {
  for (const [k, table] of [["boat", "boats"], ["sea", "seas"], ["time", "times"]]) {
    if (!SHOTS[table][u[k]]) throw new Error(`${u.id}: no ${k} "${u[k]}" in shots.json`);
  }
  for (const v of u.views ?? []) if (!SHOTS.views[v]) throw new Error(`${u.id}: no view "${v}"`);
  if (u.clip && !SHOTS.clips[u.clip]) throw new Error(`${u.id}: no clip "${u.clip}"`);
}
const wanted = units.filter((u) => !ONLY || ONLY.test(u.id));
// Split by cost: biggest first, each to the lightest shard (the same answer on every machine).
const load = Array.from({ length: SHARDS }, () => 0);
const mine = [];
for (const u of [...wanted].sort((a, b) => b.cost - a.cost || a.id.localeCompare(b.id))) {
  const s = load.indexOf(Math.min(...load));
  load[s] += u.cost;
  if (s === SHARD - 1) mine.push(u);
}
if (flag("list")) {
  for (const u of mine) console.log(u.id, u.views ? `${u.views.length} stills` : `clip ${SHOTS.clips[u.clip].seconds}s`, `cost ${u.cost}`);
  console.log(`shard ${SHARD}/${SHARDS}: ${mine.length} of ${wanted.length} units; shard costs ${load.join(" ")}`);
  process.exit(0);
}

// ---------- the page ----------
// Runs in the page before its own scripts: a seeded Math.random, and a clock we can hold
// and step (performance.now, Date.now and requestAnimationFrame).
const INIT = `(() => {
  let seed = 20261112 >>> 0;
  Math.random = () => { seed = (seed + 0x6d2b79f5) >>> 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const realRaf = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance), realDate = Date.now.bind(Date);
  let held = null, vt = 0; const q = [];
  window.__proofClock = {
    hold() { if (held === null) { held = realNow(); vt = held; } },
    step(ms) { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } return cbs.length; },
  };
  performance.now = () => (held === null ? realNow() : vt);
  Date.now = () => (held === null ? realDate() : realDate() - (realNow() - vt));
  window.requestAnimationFrame = (cb) => (held === null ? realRaf(cb) : (q.push(cb), q.length));
})();`;
// Only the 3D view (and the cinematic's letterbox bars) in the picture.
const CSS = `body > *:not(#app):not(#cine) { display: none !important; } #cine .hint, #cine .cap { display: none !important; }`;

const { chromium } = loadPlaywright();
const ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];

async function openUnit(browser, u) {
  const boat = SHOTS.boats[u.boat];
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/^Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on("response", (r) => r.status() >= 400 && errors.push(`${r.status()} ${new URL(r.url()).pathname}`));
  await page.addInitScript(INIT);
  const q = new URLSearchParams({ voyage: boat.voyage, quality: QUALITY, gl: "full", bar: "0", title: "0" });
  if (boat.drawas) q.set("drawas", boat.drawas);
  await page.goto(`${SITE}voyage.html?${q}`, { timeout: 120000 });
  await page.waitForFunction(() => window.__replay?.ready, null, { timeout: 240000 });
  // The detailed Blender model, if the site has one (it falls back to the drawn-in-code boat).
  await page.waitForFunction(() => window.__replay.detailed, null, { timeout: 20000 }).catch(() => {});
  await page.addStyleTag({ content: CSS });
  const sea = SHOTS.seas[u.sea];
  const time = SHOTS.times[u.time];
  const info = await page.evaluate(
    ({ sea, time }) => {
      const r = window.__replay;
      r.pause();
      const hooks = typeof r.sunAt === "function" && Array.isArray(r.force?.sea) && "cam" in r;
      // The time of day: an hour on day 2 (the boat well clear of the drop) where the sun is right.
      let hour = 30;
      if (typeof r.sunAt === "function") {
        const hs = [];
        for (let h = 24; h <= 72; h += 0.05) hs.push([h, r.sunAt(h)]);
        const day = hs.filter(([h]) => h < 48);
        if (time.pick === "max") hour = day.reduce((a, b) => (b[1] > a[1] ? b : a))[0];
        else if (time.pick === "min") hour = day.reduce((a, b) => (b[1] < a[1] ? b : a))[0];
        else {
          for (let i = 1; i < hs.length; i++) {
            const [, e0] = hs[i - 1];
            const [h1, e1] = hs[i];
            if (time.falling ? e0 >= time.sun && e1 < time.sun : e0 <= time.sun && e1 > time.sun) {
              hour = h1;
              break;
            }
          }
        }
      }
      if (sea.wind !== undefined) r.force.wind = sea.wind;
      if (sea.cloud !== undefined) r.force.cloud = sea.cloud;
      r.force.fog = 0;
      if (hooks && sea.hs !== undefined) r.force.sea = [sea.hs, sea.tp, sea.from ?? -1];
      if (Array.isArray(r.force?.heel) && sea.heel) r.force.heel = sea.heel;
      r.setHour(hour);
      return { hooks, hour, sunEl: typeof r.sunAt === "function" ? r.sunAt(hour) : null, boats: r.boats, models: r.models };
    },
    { sea, time },
  );
  if (!info.hooks) errors.push("this branch has no proof hooks in voyage.ts (merge main): logged sea, page camera");
  // Settle at a small size (cheap on software graphics), then hold the clock at full size.
  await page.setViewportSize({ width: 320, height: 180 });
  await page.evaluate(() => window.__proofClock.hold());
  for (let i = 0; i < WARM_STEPS; i++) await page.evaluate(() => window.__proofClock.step(100));
  await page.setViewportSize({ width: W, height: H });
  // A few frames at full size: the first ones after a resize can come out blank.
  // A throwaway capture as well: the first one after the resize was blank in testing.
  await page.waitForTimeout(500);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__proofClock.step(1000 / 24));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 10 });
  return { ctx, page, cdp, errors, info };
}

const step = (page, ms) => page.evaluate((ms) => window.__proofClock.step(ms), ms);
async function shot(cdp, path, format = "png") {
  const r = await cdp.send("Page.captureScreenshot", format === "png" ? { format } : { format, quality: 92 });
  writeFileSync(path, Buffer.from(r.data, "base64"));
}
const setCam = (page, v) => page.evaluate((v) => "cam" in window.__replay && (window.__replay.cam = v), v);

async function renderUnit(browser, u) {
  const t0 = Date.now();
  const { ctx, page, cdp, errors, info } = await openUnit(browser, u);
  const files = [];
  try {
    if (u.views) {
      for (const v of u.views) {
        const view = SHOTS.views[v];
        await setCam(page, { az: view.az, dist: view.dist, h: view.h, fov: view.fov, look: view.look });
        // Two frames: the first after a camera move can still carry the last view's reflections.
        await step(page, 1000 / FPS);
        await step(page, 1000 / FPS);
        const file = `${u.id}-${v}.png`;
        await shot(cdp, join(OUT, file));
        files.push({ file, kind: "still", view: v });
      }
    } else {
      const clip = SHOTS.clips[u.clip];
      const n = Math.round(clip.seconds * FPS);
      const dir = join(OUT, `.frames-${u.id}`);
      mkdirSync(dir, { recursive: true });
      if (clip.cinema) {
        await setCam(page, null);
        const ok = await page.evaluate((kind) => {
          const c = window.__replay.cine;
          if (!c) return false;
          c.start();
          c.cut(kind);
          // Hold the shot for the whole clip: no cut or dip to black part-way.
          if (c.shot) c.shot.len = 1e6;
          return true;
        }, clip.cinema);
        if (!ok) errors.push("no cinematic mode on this page");
      }
      const view = clip.view ? SHOTS.views[clip.view] : null;
      for (let i = 0; i < n; i++) {
        if (view) await setCam(page, { az: view.az + (clip.azRate ?? 0) * (i / FPS), dist: view.dist, h: view.h, fov: view.fov, look: view.look });
        await step(page, 1000 / FPS);
        await shot(cdp, join(dir, `${String(i).padStart(5, "0")}.jpg`), "jpeg");
      }
      const file = `${u.id}.mp4`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", join(dir, "%05d.jpg"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", "-movflags", "+faststart", join(OUT, file)]);
      // A poster: the clip's middle frame.
      const poster = `${u.id}-poster.jpg`;
      execFileSync("cp", [join(dir, `${String(Math.floor(n / 2)).padStart(5, "0")}.jpg`), join(OUT, poster)]);
      rmSync(dir, { recursive: true, force: true });
      files.push({ file, kind: "clip", clip: u.clip, poster, seconds: clip.seconds, fps: FPS });
    }
  } finally {
    await ctx.close();
  }
  return { ...u, files, hour: info.hour, sunEl: info.sunEl, models: info.models, errors, seconds: Math.round((Date.now() - t0) / 1000) };
}

mkdirSync(OUT, { recursive: true });
console.log(`set ${SET_NAME}, shard ${SHARD}/${SHARDS}: ${mine.length} units, ${W}x${H} ${QUALITY}, site ${SITE}`);
const browser = await chromium.launch({ args: ARGS });
const done = [];
let failed = 0;
for (const u of mine) {
  try {
    const r = await renderUnit(browser, u);
    done.push(r);
    console.log(`${u.id}: ${r.files.length} file(s) in ${r.seconds}s${r.errors.length ? `; page said: ${r.errors.slice(0, 2).join(" | ")}` : ""}`);
  } catch (e) {
    failed++;
    done.push({ ...u, files: [], errors: [String(e?.message ?? e)] });
    console.log(`${u.id}: FAILED ${e?.message ?? e}`);
  }
}
await browser.close();
writeFileSync(
  join(OUT, `manifest-${SHARD}-of-${SHARDS}.json`),
  JSON.stringify({ set: SET_NAME, size: `${W}x${H}`, quality: QUALITY, fps: FPS, shard: SHARD, shards: SHARDS, units: done }, null, 1),
);
if (failed) {
  console.log(`${failed} unit(s) failed`);
  process.exit(1);
}
