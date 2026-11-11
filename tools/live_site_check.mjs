// Live-site end-to-end check: visit the DEPLOYED pages the way a first-time
// visitor does (a fresh browser profile per check, no cache) and fail on what a
// visitor would hit: any console error or uncaught page error, any "being
// updated" or "can't start" notice, or a launch that never produces a day of
// sailing. Read-only: it only visits the public site.
//
//   node tools/live_site_check.mjs [check ...]     (no names = every check)
//   SITE=https://example.github.io/boat-sim/ node tools/live_site_check.mjs helm-drop
//
// Each check prints one PASS/FAIL line plus its evidence, and writes
// live-<check>.png. The exit code is the number of failed checks (capped at 1).
import * as pw from "playwright";
import { appendFileSync } from "node:fs";
import { PAGES, checkPage } from "./live_visual_checks.mjs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const MIN = 60_000;
// A notice a visitor must never see on the live site.
const NOTICE = /being updated|can['’]t start|cannot start|aren['’]t published|isn['’]t published|no simulator files|simulator stopped|failed/i;
// Helm stops a player can legitimately hit before a full day.
const STOPS = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived"];

class CheckFail extends Error {}
const must = (ok, msg) => {
  if (!ok) throw new CheckFail(msg);
};

/** Open a page in a brand-new browser context, collecting console errors, page errors and failed loads. */
async function open(browser, path, viewport = { width: 1400, height: 900 }) {
  const ctx = await browser.newContext({ viewport, bypassCSP: false, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  const notes = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}${m.location()?.url ? ` (${m.location().url})` : ""}`);
  });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("requestfailed", (r) => notes.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ""}`));
  page.on("response", (r) => {
    if (r.status() >= 400) notes.push(`HTTP ${r.status()}: ${r.request().method()} ${r.url()}`);
  });
  await page.goto(SITE + path, { waitUntil: "load", timeout: 2 * MIN });
  return { ctx, page, errors, notes };
}

/** Text a visitor can see that reads like a "being updated" / "can't start" notice. */
async function visibleNotices(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && NOTICE.test(l));
}

/** Median and 90th-percentile time between animation frames over `secs`, in ms (the page's main-thread cadence). */
async function frameTimes(page, secs = 3) {
  return page.evaluate(
    (ms) =>
      new Promise((done) => {
        const gaps = [];
        let last = performance.now();
        const t0 = last;
        const tick = (now) => {
          gaps.push(now - last);
          last = now;
          if (now - t0 < ms) requestAnimationFrame(tick);
          else {
            gaps.sort((a, b) => a - b);
            const q = (f) => Math.round(gaps[Math.min(gaps.length - 1, Math.floor(f * gaps.length))]);
            done({ median: q(0.5), p90: q(0.9), n: gaps.length });
          }
        };
        requestAnimationFrame(tick);
      }),
    secs * 1000,
  );
}

/** Click, and if it gets stuck say which control it was and why (Maya, #293). */
async function clickNamed(page, selector, what, opts = {}) {
  try {
    await page.click(selector, opts);
  } catch (e) {
    throw new CheckFail(`clicking ${what} (${selector}) got stuck: ${whyStuck(e)}`);
  }
}

// ---------- helm ----------
// The functional helm checks run on Low quality, as the smoke test does: on the
// runner's software graphics, High spends the frame in the browser's own raster work
// (Sam's profile, #293), which starved clicks. visual-helm keeps the default look.
const HELM = "helm.html?quality=low";
async function helmStart(page, setup) {
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
  await setup(page);
  await clickNamed(page, "#go", "Take the helm");
  await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
  const s = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
  must(s.ready && !s.err, `didn't start: ${s.err || "no error"}; the page says "${s.msg}"`);
}

/** Sail in one-day hops until the clock passes a day (a known stop just means hop again). */
async function helmSailADay(page) {
  let st;
  for (let hop = 0; hop < 8; hop++) {
    const t0 = Date.now();
    await clickNamed(page, "#sday", "Sail 1 day");
    await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 8 * MIN });
    st = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error, over: window.__helm.status?.over }));
    st.secs = Math.round((Date.now() - t0) / 1000);
    must(!st.err, `sailing failed: ${st.err}`);
    // Sam's fragile spot 2: a start near land must not stop for land at once.
    must(!(hop === 0 && st.stop === "land" && st.day < 0.05), `an instant "land" stop at day ${st.day?.toFixed(3)}`);
    must(STOPS.includes(st.stop), `unknown stop ${JSON.stringify(st.stop)} at day ${st.day}`);
    if (st.day >= 1 - 1e-6) return st;
    must(!st.over, `the game ended on day ${st.day?.toFixed(2)} (${st.stop}) before a day of sailing`);
  }
  throw new CheckFail(`still short of a day after 8 hops: day ${st?.day}, last stop ${st?.stop}`);
}

// A page that slows down as the voyage goes on (Sam measured 300-430 ms frames after a
// day, #293). Runners draw on software graphics, so this compares the page with itself:
// after a day it may be at most 3x slower than just after the start (plus 100 ms slack).
const SLOWDOWN = 3;
async function framesAfterADay(page, before) {
  const after = await frameTimes(page);
  must(
    after.median <= SLOWDOWN * before.median + 100,
    `the page slowed down after a day of sailing: frames ${before.median} ms at the start, ${after.median} ms after a day (90th percentile ${after.p90} ms)`,
  );
  return `; frames ${before.median} -> ${after.median} ms`;
}

const helm = (setup, extra = async () => "") => async (page) => {
  await helmStart(page, setup);
  const before = await frameTimes(page);
  const st = await helmSailADay(page);
  const frames = await framesAfterADay(page, before);
  return `sailed to day ${st.day.toFixed(2)} (last stop: ${st.stop}; the last hop took ${st.secs} s${frames})${await extra(page)}`;
};

const pickBoat = (value) => async (page) => {
  const r = page.locator(`input[name="boat"][value="${value}"]`);
  must((await r.count()) === 1, `the boat picker doesn't offer ${value || "our kayak"}`);
  await r.check();
};

const CHECKS = {
  index: {
    path: "",
    run: async (page) => {
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      return `${await page.evaluate(() => window.__sea3d.frames)} frames drawn`;
    },
  },
  "helm-drop": { path: HELM, run: helm(async (p) => p.selectOption("#launch", "0")) },
  "helm-port": {
    path: HELM,
    run: helm(async (p) => {
      await p.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the port picker never appeared");
      });
      must((await p.locator('#port option[value="norfolk"]').count()) === 1, "the port picker has no Norfolk");
      await p.selectOption("#port", "norfolk");
    }),
  },
  "helm-challenge": {
    path: HELM,
    run: helm(
      async (p) => {
        await p.waitForFunction(() => !document.querySelector("#chpick").hidden, null, { timeout: MIN }).catch(() => {
          throw new CheckFail("the weather challenge picker never appeared");
        });
        const ids = await p.evaluate(() => [...document.querySelectorAll("#challenge option")].map((o) => o.value).filter(Boolean));
        const id = ids.find((i) => /dorian/i.test(i));
        must(id, `no Dorian challenge offered (offered: ${ids.join(", ")})`);
        await p.selectOption("#challenge", id);
      },
      async (p) => `, challenge ${await p.evaluate(() => window.__helm.challenge)}`,
    ),
  },
  // Sam's fragile spot 1: a fresh share link reopens the game at the same spot, in a fresh profile.
  "helm-share": {
    path: HELM,
    run: async (page) => {
      await helmStart(page, async (p) => p.selectOption("#launch", "1"));
      const before = await frameTimes(page);
      const st = await helmSailADay(page);
      const after = await frameTimes(page);
      console.log(`    (helm-share frames: ${before.median} ms at the start, ${after.median} ms after a day, p90 ${after.p90} ms)`);
      await clickNamed(page, "#share", "Copy a share link");
      await page.waitForFunction(() => !!window.__helm.share, null, { timeout: 2 * MIN });
      const link = await page.evaluate(() => window.__helm.share);
      const o = await open(page.context().browser(), `${link.slice(SITE.length)}&quality=low`);
      try {
        await o.page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        if (!(await o.page.evaluate(() => window.__helm.ready))) {
          if (await o.page.isVisible("#go")) await o.page.click("#go");
          await o.page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
        }
        const s2 = await o.page.evaluate(() => ({ day: window.__helm.status?.day, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
        must(!s2.err, `the share link didn't reopen: ${s2.err}; the page says "${s2.msg}"`);
        must(Math.abs(s2.day - st.day) < 0.01, `the share link reopened at day ${s2.day}, not ${st.day}`);
        must(!o.errors.length, `errors on the reopened link: ${o.errors.join("; ")}`);
        const n = await visibleNotices(o.page);
        must(!n.length, `notices on the reopened link: ${n.join("; ")}`);
        return `a share link at day ${st.day.toFixed(2)} reopened at the same day`;
      } finally {
        await o.ctx.close();
      }
    },
  },
  "helm-base": { path: HELM, run: helm(async (p) => p.locator('input[name="mode"][value="base"]').check()) },
};

// One helm check per boat the live picker offers (our kayak is helm-drop).
const STOCK_BOATS = ["stock_cruiser31", "stock_sail_drone7", "stock_ocean_rower45", "stock_dinghy14", "stock_beachcat16"];
for (const b of STOCK_BOATS)
  CHECKS[`helm-${b}`] = {
    path: HELM,
    optional: true, // only if the live picker offers it; the list of offered boats is checked in helm-boats
    run: helm(pickBoat(b)),
  };
CHECKS["helm-boats"] = {
  path: HELM,
  run: async (page) => {
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
    const offered = await page.evaluate(() => [...document.querySelectorAll('input[name="boat"]')].map((r) => r.value || "kayak"));
    return `the picker offers: ${offered.join(", ")}`;
  },
};

Object.assign(CHECKS, {
  boatyard: {
    path: "boatyard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      await page.click("#launch");
      await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 15 * MIN });
      const r = await page.evaluate(() => ({
        backend: window.__yard.backend,
        err: window.__yard.launchError,
        n: window.__yard.launch?.replays?.length ?? 0,
        days: Math.max(0, ...(window.__yard.launch?.replays ?? []).map((v) => v.days ?? v.summary?.days ?? 0)),
        text: document.querySelector("#result")?.textContent?.slice(0, 200),
      }));
      must(!r.err, `the launch failed: ${r.err}`);
      must(r.n > 0, `the launch gave no voyages (${r.text})`);
      return `launched via ${r.backend}: ${r.n} voyages`;
    },
  },
  "voyage-replay": {
    path: "voyage.html?voyage=2020-04-15",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const r = await page.evaluate(() => ({ ready: window.__replay.ready, err: window.__replay.error, maxHour: window.__replay.maxHour }));
      must(r.ready && !r.err, `the replay didn't load: ${r.err}`);
      must(r.maxHour >= 24, `the replay is shorter than a day (${r.maxHour} h)`);
      await page.waitForFunction(() => window.__replay.frames > 5, null, { timeout: MIN });
      return `replay of ${(r.maxHour / 24).toFixed(1)} days drawing`;
    },
  },
  "voyage-annapolis": {
    path: "voyage.html?place=annapolis",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const r = await page.evaluate(() => ({ ready: window.__replay.ready, err: window.__replay.error }));
      must(r.ready && !r.err, `the page didn't load: ${r.err}`);
      await page.waitForFunction(() => window.__replay.frames > 5, null, { timeout: MIN });
      return "Annapolis view drawing";
    },
  },
  race: {
    path: "race.html",
    run: async (page) => {
      await page.waitForFunction(() => !!window.__race, null, { timeout: MIN });
      await page.click("#go");
      await page.waitForFunction(() => window.__race.ready || window.__race.error, null, { timeout: 8 * MIN });
      const s = await page.evaluate(() => ({ ready: window.__race.ready, err: window.__race.error, msg: document.querySelector("#msg")?.textContent }));
      must(s.ready && !s.err, `didn't start: ${s.err}; the page says "${s.msg}"`);
      await page.click("#day");
      await page.waitForFunction(() => !window.__race.busy, null, { timeout: 8 * MIN });
      const r = await page.evaluate(() => ({ day: window.__race.status?.day, err: window.__race.error, names: window.__race.status?.boats.map((b) => b.name) }));
      must(!r.err, `racing failed: ${r.err}`);
      must(r.day >= 1 - 1e-6, `the race stopped at day ${r.day}`);
      return `${r.names?.join(" vs ")} raced to day ${r.day.toFixed(2)}`;
    },
  },
  leaderboard: {
    path: "leaderboard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: MIN });
      const lb = await page.evaluate(() => window.__leaderboard);
      must(!lb.error, `the board didn't load: ${lb.error}`);
      must(lb.rows >= 2 && !lb.sample, `the board shows ${lb.rows} rows${lb.sample ? " (the sample board)" : ""}`);
      return `${lb.rows} designs on the board`;
    },
  },
});

// Iris's visual checks (tools/live_visual_checks.mjs): the 3D picture itself, at the
// small window she tuned them on, plus the main control responding.
const VISUAL = { "visual-sea": "sea (index)", "visual-voyage": "voyage replay", "visual-helm": "helm", "visual-boatyard": "boatyard", "visual-race": "race" };
for (const [name, pageName] of Object.entries(VISUAL)) {
  const p = PAGES.find((x) => x.name === pageName);
  CHECKS[name] = {
    path: p.path,
    viewport: { width: 960, height: 540 },
    run: async (page) => {
      const problems = await checkPage(page, SITE, p);
      must(!problems.length, problems.join("; "));
      return "the picture and the main control look right";
    },
  };
}
// Iris's find: in a small window the helm's start card must still let you reach "Take the helm".
CHECKS["helm-small-window"] = {
  path: "helm.html",
  viewport: { width: 960, height: 540 },
  run: async (page) => {
    await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
    await page.click("#go", { trial: true, timeout: 10_000 }).catch(() => {
      throw new CheckFail('"Take the helm" can\'t be reached at 960x540 (the start card is taller than the window and doesn\'t scroll)');
    });
    return '"Take the helm" is reachable at 960x540';
  },
};

/** First line of a Playwright error plus the last steps of its call log (why a click waited: hidden, disabled, covered, off screen). */
function whyStuck(e) {
  const lines = String(e).split("\n");
  const log = lines.filter((l) => /^\s+-\s/.test(l)).slice(-3).map((l) => l.trim().replace(/^-\s*/, ""));
  return lines[0] + (log.length ? ` [${log.join(" / ")}]` : "");
}

async function runCheck(browser, name) {
  const c = CHECKS[name];
  const t0 = Date.now();
  let o;
  let result = "";
  let failure = "";
  try {
    o = await open(browser, c.path, c.viewport);
    if (c.optional && name.startsWith("helm-stock")) {
      await o.page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const b = name.slice("helm-".length);
      if (!(await o.page.locator(`input[name="boat"][value="${b}"]`).count())) {
        await o.ctx.close();
        return { name, status: "SKIP", detail: "not offered in the live boat picker", secs: 0 };
      }
    }
    result = await c.run(o.page);
  } catch (e) {
    failure = e instanceof CheckFail ? e.message : `stuck or crashed: ${whyStuck(e)}`;
  }
  let notices = [];
  if (o) {
    notices = await visibleNotices(o.page).catch(() => []);
    await o.page.screenshot({ path: `live-${name}.png` }).catch(() => {});
  }
  const problems = [...(failure ? [failure] : []), ...(o?.errors ?? []), ...notices.map((n) => `notice: "${n}"`)];
  const out = { name, status: problems.length ? "FAIL" : "PASS", detail: problems.length ? problems : result, notes: o?.notes ?? [], secs: Math.round((Date.now() - t0) / 1000) };
  await o?.ctx.close().catch(() => {});
  return out;
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
for (const n of names) if (!CHECKS[n]) throw new Error(`unknown check ${n}; known: ${Object.keys(CHECKS).join(" ")}`);
// BROWSER=firefox (or webkit) plays the same checks in another engine; default Chrome.
// Headless Firefox on a runner has no WebGL ("WebGL creation failed"); run it
// headed under xvfb (HEADED=1, see the workflows) on Mesa's software GL, with WebGL forced on.
const LAUNCH = {
  headless: !process.env.HEADED,
  ...((process.env.BROWSER ?? "chromium") === "firefox"
    ? { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.enable-webgl2": true } }
    : {}),
};
const browser = await pw[process.env.BROWSER ?? "chromium"].launch(LAUNCH);
const results = [];
for (const n of names) {
  const r = await runCheck(browser, n);
  results.push(r);
  const detail = Array.isArray(r.detail) ? r.detail.map((d) => `\n    - ${d}`).join("") : ` ${r.detail}`;
  console.log(`${r.status} ${n} (${r.secs} s):${detail}`);
  for (const x of (r.notes ?? []).slice(0, 15)) console.log(`    (${x})`);
}
await browser.close();
if (process.env.GITHUB_STEP_SUMMARY) {
  const md = results
    .map((r) => `| ${r.status === "PASS" ? "✅" : r.status === "SKIP" ? "➖" : "❌"} ${r.name} | ${(Array.isArray(r.detail) ? r.detail.join("<br>") : r.detail).replace(/\|/g, "\\|")} |`)
    .join("\n");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `| Check | Result |\n|---|---|\n${md}\n`);
}
process.exit(results.some((r) => r.status === "FAIL") ? 1 : 0);
