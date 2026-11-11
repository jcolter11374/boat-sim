// Nina's playtest: plays the DEPLOYED pages the way a person does, in Chrome and
// Firefox, and fails on what a player would hit. It sits beside Ravi's
// tools/live_site_check.mjs (which checks that each page starts and sails a day)
// and covers the paths a player takes after that: cinematic mode, "sail until
// something happens", the real base station, and the same core paths in Firefox.
// Read-only: it only visits the public site.
//
//   BROWSER=firefox node tools/playtest/play.mjs [check ...]   (no names = all)
//   SITE=https://example.github.io/boat-sim/ node tools/playtest/play.mjs helm-cinematic
//
// Each check prints one PASS/FAIL line with evidence, and saves
// play-<browser>-<check>.png. Exit code 1 if anything failed.
import * as pw from "playwright";
import { appendFileSync } from "node:fs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const BROWSER = process.env.BROWSER ?? "chromium";
const MIN = 60_000;
const NOTICE = /being updated|can['’]t start|cannot start|aren['’]t published|isn['’]t published|no simulator files|simulator stopped|failed/i;
// Stops a player can legitimately hit (helm.ts Stop).
const STOPS = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived", "left_data_box"];

class CheckFail extends Error {}
const must = (ok, msg) => {
  if (!ok) throw new CheckFail(msg);
};

async function open(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  const notes = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400) notes.push(`HTTP ${r.status()}: ${r.url()}`);
  });
  await page.goto(SITE + path, { waitUntil: "load", timeout: 2 * MIN });
  return { ctx, page, errors, notes };
}

async function visibleNotices(page) {
  const text = await page.evaluate(() => document.body.innerText);
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && NOTICE.test(l));
}

async function helmStart(page, setup = async () => {}) {
  await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
  await setup(page);
  await page.click("#go");
  await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
  const s = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
  must(s.ready && !s.err, `didn't start: ${s.err || "no error"}; the page says "${s.msg}"`);
}

async function hop(page, button) {
  const t0 = Date.now();
  await page.click(button);
  await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 10 * MIN });
  const st = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error, over: window.__helm.status?.over }));
  st.secs = Math.round((Date.now() - t0) / 1000);
  must(!st.err, `sailing failed: ${st.err}`);
  must(STOPS.includes(st.stop), `unknown stop ${JSON.stringify(st.stop)} at day ${st.day}`);
  return st;
}

/** Cinematic mode: panels hide, the picture keeps moving, the clock doesn't move, any key leaves. */
async function cinematic(page, framesOf) {
  const day0 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  await page.click("#cinebtn");
  await page.waitForFunction(() => document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("clicking Cinematic didn't start cinematic mode");
  });
  const f0 = await page.evaluate(framesOf);
  await page.waitForTimeout(8000);
  const f1 = await page.evaluate(framesOf);
  must(f1 - f0 >= 10, `the picture froze in cinematic mode (${f1 - f0} frames in 8 s)`);
  await page.screenshot({ path: `play-${BROWSER}-cinematic-inside.png` }).catch(() => {});
  const day1 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  must(day0 === day1, `cinematic mode moved the clock from day ${day0} to ${day1}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("a key press didn't leave cinematic mode");
  });
  return `cinematic ran ${f1 - f0} frames in 8 s and a key press left it`;
}

const CHECKS = {
  // The four pages load and draw in this browser.
  index: {
    path: "",
    run: async (page) => {
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      return "drawing";
    },
  },
  // The default helm game: start, sail 6 hours, sail a day.
  "helm-play": {
    path: "helm.html",
    run: async (page) => {
      await helmStart(page);
      const a = await hop(page, "#s6");
      must(a.day > 0.2 || a.stop !== "time", `"Sail 6 hours" only reached day ${a.day}`);
      const b = await hop(page, "#sday");
      return `6 h hop to day ${a.day.toFixed(2)} (${a.secs} s), 1 day hop to ${b.day.toFixed(2)} (${b.secs} s, stop ${b.stop})`;
    },
  },
  // Sam's spot 5: "Sail until something happens" stops within 72 h.
  "helm-until": {
    path: "helm.html",
    run: async (page) => {
      await helmStart(page);
      const st = await hop(page, "#sevent");
      must(st.day <= 3 + 1e-3, `"until something happens" ran past 72 h (day ${st.day})`);
      return `stopped at day ${st.day.toFixed(2)} for "${st.stop}" (${st.secs} s)`;
    },
  },
  // Sam's spot 3: real base station, an order takes about a day to arrive.
  "helm-base-order": {
    path: "helm.html",
    run: async (page) => {
      await helmStart(page, async (p) => p.locator('input[name="mode"][value="base"]').check());
      const visible = await page.isVisible("#send");
      must(visible, "in base-station mode there's no Send button");
      await page.click("#send");
      const stops = [];
      for (let i = 0; i < 4; i++) {
        const st = await hop(page, "#sday");
        stops.push(`${st.stop}@${st.day.toFixed(2)}`);
        if (st.day >= 2) break;
      }
      return `stops: ${stops.join(", ")}`;
    },
  },
  // Maya, 11 Nov: the paths the stale simulator bundle blocked.
  "helm-norfolk": {
    path: "helm.html",
    run: async (page) => {
      await helmStart(page, async (p) => {
        await p.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN }).catch(() => {
          throw new CheckFail("the port picker never appeared");
        });
        await p.selectOption("#port", "norfolk");
      });
      const st = await hop(page, "#sday");
      must(!(st.stop === "land" && st.day < 0.05), `an instant "land" stop at day ${st.day}`);
      return `from Norfolk to day ${st.day.toFixed(2)} (stop ${st.stop}, ${st.secs} s)`;
    },
  },
  ...Object.fromEntries(
    [["helm-drone", "stock_sail_drone7"], ["helm-rower", "stock_ocean_rower45"], ["helm-cruiser", "stock_cruiser31"]].map(([n, b]) => [
      n,
      {
        path: "helm.html",
        run: async (page) => {
          await helmStart(page, async (p) => {
            const r = p.locator(`input[name="boat"][value="${b}"]`);
            must((await r.count()) === 1, `the boat picker doesn't offer ${b}`);
            await r.check();
          });
          const st = await hop(page, "#sday");
          return `${b} to day ${st.day.toFixed(2)} (stop ${st.stop}, ${st.secs} s)`;
        },
      },
    ]),
  ),
  "helm-cinematic": {
    path: "helm.html",
    run: async (page) => {
      await helmStart(page);
      await hop(page, "#s6");
      return cinematic(page, () => window.__helm.frames);
    },
  },
  "voyage-cinematic": {
    path: "voyage.html?voyage=2020-04-15",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const err = await page.evaluate(() => window.__replay.error);
      must(!err, `the replay didn't load: ${err}`);
      return cinematic(page, () => window.__replay.frames);
    },
  },
  boatyard: {
    path: "boatyard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      await page.click("#launch");
      await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 15 * MIN });
      const r = await page.evaluate(() => ({ backend: window.__yard.backend, err: window.__yard.launchError, n: window.__yard.launch?.replays?.length ?? 0 }));
      must(!r.err, `the launch failed: ${r.err}`);
      must(r.n > 0, "the launch gave no voyages");
      return `launched via ${r.backend}: ${r.n} voyages`;
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
      return "race started";
    },
  },
  leaderboard: {
    path: "leaderboard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: MIN });
      const lb = await page.evaluate(() => window.__leaderboard);
      must(!lb.error, `the board didn't load: ${lb.error}`);
      return `${lb.rows} rows`;
    },
  },
};

async function runCheck(browser, name) {
  const t0 = Date.now();
  let o;
  let result = "";
  let failure = "";
  try {
    o = await open(browser, CHECKS[name].path);
    result = await CHECKS[name].run(o.page);
  } catch (e) {
    failure = e instanceof CheckFail ? e.message : `stuck or crashed: ${String(e).split("\n")[0]}`;
  }
  let notices = [];
  if (o) {
    notices = await visibleNotices(o.page).catch(() => []);
    await o.page.screenshot({ path: `play-${BROWSER}-${name}.png` }).catch(() => {});
  }
  const problems = [...(failure ? [failure] : []), ...(o?.errors ?? []), ...notices.map((n) => `notice: "${n}"`)];
  await o?.ctx.close().catch(() => {});
  return { name, ok: !problems.length, detail: problems.length ? problems : [result], notes: o?.notes ?? [], secs: Math.round((Date.now() - t0) / 1000) };
}

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS);
for (const n of names) if (!CHECKS[n]) throw new Error(`unknown check ${n}; known: ${Object.keys(CHECKS).join(" ")}`);
const browser = await pw[BROWSER].launch();
const results = [];
for (const n of names) {
  const r = await runCheck(browser, n);
  results.push(r);
  console.log(`${r.ok ? "PASS" : "FAIL"} ${BROWSER} ${n} (${r.secs} s):${r.detail.map((d) => `\n    - ${d}`).join("")}`);
  for (const x of r.notes.slice(0, 10)) console.log(`    (${x})`);
}
await browser.close();
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `| ${BROWSER} | Result |\n|---|---|\n${results.map((r) => `| ${r.ok ? "✅" : "❌"} ${r.name} | ${r.detail.join("<br>").replace(/\|/g, "\\|")} |`).join("\n")}\n`,
  );
process.exit(results.some((r) => !r.ok) ? 1 : 0);
