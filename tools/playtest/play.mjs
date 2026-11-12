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
import { appendFileSync, readFileSync } from "node:fs";

const SITE = (process.env.SITE ?? "https://jcolter11374.github.io/boat-sim/").replace(/\/?$/, "/");
const BROWSER = process.env.BROWSER ?? "chromium";
const MIN = 60_000;
const NOTICE = /being updated|can['’]t start|cannot start|aren['’]t published|isn['’]t published|no simulator files|simulator stopped|failed/i;
// Stops a player can legitimately hit (helm.ts Stop).
const STOPS = ["time", "battery", "wind", "land", "breakdown", "silence", "ghost_passed", "passed_ghost", "over", "order_arrived", "left_data_box"];

class CheckFail extends Error {}
class SkipCheck extends Error {}
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
  // Launch day, challenges and how you steer sit under "More options" (Nina's review); open it if this page has it.
  await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
  await setup(page);
  await page.click("#go");
  await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
  const s = await page.evaluate(() => ({ ready: window.__helm.ready, err: window.__helm.error, msg: document.querySelector("#startmsg").textContent }));
  must(s.ready && !s.err, `didn't start: ${s.err || "no error"}; the page says "${s.msg}"`);
  // Time runs by itself once you set sail (#339): pause it, and let the picture settle, so a hop measures only the hop.
  await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
  // The status can lag the start by a frame or two: settle only once there's a day to read.
  await page.waitForFunction(() => typeof window.__helm.status?.day === "number", null, { timeout: MIN }).catch(() => {});
  let last = -1;
  for (let i = 0; i < 60; i++) {
    const d = await page.evaluate(() => window.__helm.status?.day ?? 0);
    if (d === last) break;
    last = d;
    await page.waitForTimeout(1000);
  }
}

/** The helm's orders drawer (Leo's layout plan): open it before using what's inside. Builds without one: nothing to do. */
async function openOrders(page) {
  if (!(await page.locator("#orders-tab").count())) return;
  // At the start the drawer opens by itself for 10 s with a tip, then slides shut unless it's
  // in use; on slow software graphics the slide takes seconds. So: open it if it's shut, wait
  // until it has fully slid in, then point at it, which keeps it open (the player is using it).
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator("#orders.open").count())) await page.click("#orders-tab", { timeout: 15_000 }).catch(() => {});
    const there = await page
      .waitForFunction(() => { const o = document.getElementById("orders"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 })
      .then(() => true, () => false);
    if (!there) continue;
    await page.hover("#orders h2", { timeout: 10_000 }).catch(() => {});
    if (await page.locator("#orders.open").count()) return;
  }
}
async function hop(page, button) {
  const t0 = Date.now();
  const day0 = await page.evaluate(() => window.__helm.status?.day ?? 0);
  await openOrders(page);
  await page.click(button);
  await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 10 * MIN });
  const st = await page.evaluate(() => ({ day: window.__helm.status?.day, stop: window.__helm.lastStop, err: window.__helm.error, over: window.__helm.status?.over }));
  st.secs = Math.round((Date.now() - t0) / 1000);
  st.day0 = day0;
  must(!st.err, `sailing failed: ${st.err}`);
  must(STOPS.includes(st.stop), `unknown stop ${JSON.stringify(st.stop)} at day ${st.day}`);
  return st;
}

/** Cinematic mode: panels hide, the picture keeps moving, the clock doesn't move, any key leaves. */
async function cinematic(page, framesOf) {
  const day0 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  // The button only toggles a class; don't wait for navigations (software GL can stall that wait, 11 Nov).
  await page.click("#cinebtn", { noWaitAfter: true });
  await page.waitForFunction(() => document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("clicking Cinematic didn't start cinematic mode");
  });
  const f0 = await page.evaluate(framesOf);
  await page.waitForTimeout(8000);
  const f1 = await page.evaluate(framesOf);
  // Headless browsers draw on software graphics at about 1 frame a second on a
  // PC without a GPU (John's, 11 Nov: 9-10 frames in 8 s), so "moving" means a few frames.
  must(f1 - f0 >= 3, `the picture froze in cinematic mode (${f1 - f0} frames in 8 s)`);
  await page.screenshot({ path: `play-${BROWSER}-cinematic-inside.png` }).catch(() => {});
  const day1 = await page.evaluate(() => window.__helm?.status?.day ?? null);
  must(day0 === day1, `cinematic mode moved the clock from day ${day0} to ${day1}`);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.body.classList.contains("cinema"), null, { timeout: 10_000 }).catch(() => {
    throw new CheckFail("a key press didn't leave cinematic mode");
  });
  return `cinematic ran ${f1 - f0} frames in 8 s and a key press left it`;
}

/** A JPEG for people whose sandboxes can't open github.io or fetch run artifacts: saved, and printed
 *  to the log in base64 between LOOK-BEGIN/LOOK-END lines (decode it back from the job log). */
async function lookShot(page, path) {
  await page.screenshot({ path, type: "jpeg", quality: 82 });
  const b64 = readFileSync(path).toString("base64");
  console.log(`LOOK-BEGIN ${path}`);
  for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
  console.log(`LOOK-END ${path}`);
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
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      const a = await hop(page, "#s6");
      must(a.day - a.day0 > 0.2 || a.stop !== "time", `"Sail 6 hours" only went from day ${a.day0} to ${a.day}`);
      const b = await hop(page, "#sday");
      return `6 h hop to day ${a.day.toFixed(2)} (${a.secs} s), 1 day hop to ${b.day.toFixed(2)} (${b.secs} s, stop ${b.stop})`;
    },
  },
  // #339 as a first-timer sees it: only the start card at first, Set sail in view,
  // a loading message, then time runs by itself, pauses on an event and says why,
  // and the 3D day label agrees with the panel.
  "helm-first-timer": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#timebar").count())) throw new SkipCheck("this build has no time bar (#339 not deployed)");
      const first = await page.evaluate(() => {
        const shown = (id) => { const e = document.getElementById(id); if (!e || e.hidden) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none" && +cs.opacity > 0.05; };
        const go = document.getElementById("go").getBoundingClientRect();
        return { orders: shown("orders"), status: shown("status"), timebar: shown("timebar"), go: shown("go"), goInView: go.bottom <= innerHeight && go.top >= 0, moreOpen: !!document.getElementById("more")?.open, label: document.getElementById("go").textContent.trim() };
      });
      must(first.go && first.goInView, `"${first.label}" isn't visible without scrolling on the first screen`);
      must(!first.orders && !first.status && !first.timebar, `game controls show before you set sail (orders ${first.orders}, status ${first.status}, time bar ${first.timebar})`);
      must(!first.moreOpen, `"More options" starts open`);
      await page.screenshot({ path: `play-${BROWSER}-first-screen.png` }).catch(() => {});
      await page.click("#go");
      const loading = await page.waitForFunction(() => !document.getElementById("loading").hidden || window.__helm.ready, null, { timeout: 10_000 }).then(() => page.evaluate(() => !document.getElementById("loading").hidden || "already ready")).catch(() => false);
      must(loading, "nothing said it was loading after Set sail");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const st = await page.evaluate(() => ({ err: window.__helm.error, clock: window.__helm.clock, loading: !document.getElementById("loading").hidden, timebar: !document.getElementById("timebar").hidden, state: document.getElementById("timestate").textContent }));
      must(!st.err, `didn't start: ${st.err}`);
      must(!st.loading, "the loading message stayed up after it started");
      must(st.timebar, "no time bar once sailing");
      must(st.clock > 0, `time didn't start by itself (clock ${st.clock}, says "${st.state}")`);
      const d0 = await page.evaluate(() => window.__helm.status?.day ?? 0);
      await page.waitForFunction((d0) => (window.__helm.status?.day ?? 0) > d0 || window.__helm.clock === 0, d0, { timeout: 60_000 }).catch(() => {
        throw new CheckFail(`the day didn't move on its own in 60 s (day ${d0})`);
      });
      // Go fastest so an event comes soon, then wait for the clock to pause itself.
      const fast = page.locator('#timebar .rate[data-rate="96"]');
      if (await fast.count()) await fast.click({ noWaitAfter: true });
      await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.error || window.__helm.card, null, { timeout: 6 * MIN }).catch(() => {
        throw new CheckFail("the clock never paused itself for an event in 6 minutes");
      });
      const p = await page.evaluate(() => ({ err: window.__helm.error, stop: window.__helm.stops?.at(-1), state: document.getElementById("timestate").textContent, note: document.querySelector("#notes .note .txt")?.textContent ?? "", day: window.__helm.status?.day, over: window.__helm.status?.over }));
      must(!p.err, `sailing failed: ${p.err}`);
      if (!p.over) {
        must(/paused/i.test(p.state), `paused but the time bar says "${p.state}"`);
        // The reason's note appears once the picture has played on to the moment it stopped (#341), so give it time.
        if (p.stop !== "time") {
          const why = await page.waitForFunction(() => [...document.querySelectorAll("#notes .note .txt")].map((e) => e.textContent).find((t) => /^Paused:/.test(t)), null, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => "");
          must(why, `paused for "${p.stop}" with no "Paused: ..." reason in the notes after 30 s (latest note "${p.note}")`);
          p.note = why;
        }
      }
      // The picture plays on to the moment it stopped; then the 3D label and the panel must agree.
      const agree = await page.waitForFunction(() => { const c = document.getElementById("clock").textContent.trim(); return c && c === document.getElementById("day").textContent.trim(); }, null, { timeout: 30_000 }).then(() => true).catch(() => false);
      const labels = await page.evaluate(() => [document.getElementById("clock").textContent.trim(), document.getElementById("day").textContent.trim()]);
      await page.screenshot({ path: `play-${BROWSER}-first-pause.png` }).catch(() => {});
      must(agree || p.over, `the 3D day label says "${labels[0]}" but the panel says "${labels[1]}"`);
      return `first screen clean; ran by itself from day ${d0.toFixed(2)}; paused at day ${p.day?.toFixed(2)} (${p.stop}): "${p.note}"; labels ${labels.join(" = ")}`;
    },
  },
  // #334 "Sound on?" and #341 decision stops: the question shows once, "No thanks" closes it;
  // running at speed, a decision stops the clock with buttons, and picking one carries on.
  "helm-moments": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#decide").count())) throw new SkipCheck("this build has no decision stops (#341 not deployed)");
      await page.evaluate(() => {
        const a = document.getElementById("soundask");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__askedSound = true; }).observe(a, { attributes: true });
      });
      await page.click("#go", { timeout: 15_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Set sail"`);
      });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const out = [];
      if (await page.locator("#soundask").count()) {
        // Asked once on setting sail; it closes by itself after 20 s, which can pass while the
        // simulator finishes starting on a slow runner. So: it was asked, and it goes away.
        const asked = await page.evaluate(() => !document.getElementById("soundask").hidden || window.__askedSound);
        must(asked, `"Sound on?" was never asked after Set sail`);
        const clicked = (await page.click("#soundno", { noWaitAfter: true, timeout: 5_000 }).then(() => true).catch(() => false));
        const gone = await page.waitForFunction(() => document.getElementById("soundask").hidden, null, { timeout: 25_000 }).then(() => true).catch(() => false);
        must(gone, `the "Sound on?" question didn't go away${clicked ? ' after "No thanks"' : ""}`);
        out.push(`"Sound on?" asked, ${clicked ? 'closed with "No thanks"' : "closed by itself after 20 s"}`);
      }
      const fast = page.locator('#timebar .rate[data-rate="96"]');
      let decided = null;
      for (let i = 0; i < 12 && !decided; i++) {
        if (await page.evaluate(() => window.__helm.card || window.__helm.status?.over)) break;
        // Key 4 is "4 days a second" (the key hint); a key can't be blocked by a panel over the button.
        if (await page.evaluate(() => window.__helm.clock === 0)) {
          if (await fast.isVisible()) await fast.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => page.keyboard.press("4"));
          else await page.keyboard.press("4");
        }
        await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.error || window.__helm.card, null, { timeout: 4 * MIN }).catch(() => {});
        must(!(await page.evaluate(() => window.__helm.error)), "sailing failed");
        const shown = await page.waitForFunction(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length, null, { timeout: 15_000 }).then(() => true).catch(() => false);
        if (shown) {
          const d = await page.evaluate(() => ({ text: document.getElementById("decidetext").textContent, btns: [...document.querySelectorAll("#decidebtns button")].map((b) => b.textContent) }));
          must(d.text.trim() && d.btns.length >= 2, `a decision showed without a question or choices: ${JSON.stringify(d)}`);
          await page.screenshot({ path: `play-${BROWSER}-decision.png` }).catch(() => {});
          await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {
            throw new CheckFail(`couldn't click "${d.btns[0]}" on the decision`);
          });
          await page.waitForFunction(() => document.getElementById("decide").hidden && window.__helm.clock > 0, null, { timeout: 20_000 }).catch(() => {
            throw new CheckFail(`picking "${d.btns[0]}" didn't close the question and carry on`);
          });
          decided = `asked "${d.text.slice(0, 90)}", picked "${d.btns[0]}", carried on`;
        }
      }
      if (!decided) out.push("no decision came up in this voyage (not a fail)");
      else out.push(decided);
      return out.join("; ");
    },
  },
  // #348: on the cruiser, holding an arrow keeps turning, and "Take the wheel" hands you the boat until Esc.
  "helm-wheel": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page, async (p) => {
        const r = p.locator('input[name="boat"][value="stock_cruiser31"]');
        if ((await r.count()) !== 1) throw new SkipCheck("the cruiser isn't offered in the helm's boat picker");
        await r.check();
      });
      if (!(await page.locator("#b-wheel").count())) throw new SkipCheck("this build has no Take the wheel (#348 not deployed)");
      const out = [];
      // Hold-to-turn: a tap is 5 degrees; holding for 1.5 s should turn well past that.
      await page.evaluate(() => document.activeElement?.blur?.()); // keys to the page, not a focused control
      const read = () => page.evaluate(() => document.getElementById("ordertext").textContent);
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(300);
      const tapped = await read();
      const h0 = Number((tapped.match(/Steering (\d+)/) || [])[1]);
      must(Number.isFinite(h0), `an arrow key didn't give a heading to steer (orders say "${tapped}")`);
      await page.keyboard.down("ArrowRight");
      await page.waitForTimeout(1500);
      await page.keyboard.up("ArrowRight");
      await page.waitForTimeout(300);
      const held = await read();
      const h1 = Number((held.match(/Steering (\d+)/) || [])[1]);
      const turned = ((h1 - h0 + 540) % 360) - 180;
      must(turned > 10, `holding the right arrow 1.5 s only turned from ${h0}° to ${h1}°`);
      out.push(`holding → turned ${h0}° to ${h1}°`);
      await openOrders(page);
      const b = page.locator("#b-wheel");
      must(await b.isVisible(), `no "Take the wheel" button on the cruiser`);
      await b.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Take the wheel"`);
      });
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 20_000 }).catch(async () => {
        const n = await page.evaluate(() => document.querySelector("#notes .note .txt")?.textContent ?? "");
        throw new CheckFail(`"Take the wheel" didn't hand over the boat (latest note "${n}")`);
      });
      await page.keyboard.down("ArrowLeft");
      await page.waitForTimeout(1000);
      await page.keyboard.up("ArrowLeft");
      await page.screenshot({ path: `play-${BROWSER}-wheel.png` }).catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !window.__wheel.on, null, { timeout: 15_000 }).catch(() => {
        throw new CheckFail("Esc didn't hand the boat back");
      });
      const n = await page.evaluate(() => [...document.querySelectorAll("#notes .note")].filter((e) => /At the wheel/.test(e.textContent)).length);
      must(n >= 1, "no 'At the wheel' note after taking and handing back the wheel");
      out.push("took the wheel, steered, Esc handed back");
      return out.join("; ");
    },
  },
  // #359: near Annapolis (between the city and Thomas Point) the Bay's coast squares load around
  // the boat. No game start is inside the Bay yet, so this puts the boat there with ?spot= (for tests).
  "helm-bay-squares": {
    path: "helm.html?quality=low&spot=38.92,-76.42",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => "squares" in (window.__helm.land ?? {})))) throw new SkipCheck("this build has no coast squares (#359 not deployed)");
      const n = await page.waitForFunction(() => window.__helm.land.squares > 0 && window.__helm.land.squares, null, { timeout: 90_000 }).then((h) => h.jsonValue()).catch(() => 0);
      await page.screenshot({ path: `play-${BROWSER}-bay-squares.png` }).catch(() => {});
      must(n > 0, `no coast squares loaded around the boat near Annapolis in 90 s (land ${JSON.stringify(await page.evaluate(() => window.__helm.land))})`);
      const credit = await page.evaluate(() => document.body.innerText.match(/[^\n]*CUDEM[^\n]*/)?.[0] ?? "");
      return `${n} coast squares around the boat; credit "${credit.trim().slice(0, 100)}"`;
    },
  },
  // Sam's spot 5: "Sail until something happens" stops within 72 h.
  "helm-until": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      const st = await hop(page, "#sevent");
      must(st.day - st.day0 <= 3 + 1e-3, `"until something happens" ran past 72 h (day ${st.day0} to ${st.day})`);
      return `from day ${st.day0.toFixed(2)}, stopped at day ${st.day.toFixed(2)} for "${st.stop}" (${st.secs} s)`;
    },
  },
  // Sam's spot 3: real base station, an order takes about a day to arrive.
  "helm-base-order": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page, async (p) => p.locator('input[name="mode"][value="base"]').check());
      await openOrders(page); // Send lives in the orders drawer
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
    path: "helm.html?quality=low",
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
    [["helm-drone", "stock_sail_drone7"], ["helm-rower", "stock_ocean_rower45"], ["helm-cruiser", "stock_cruiser31"], ["helm-pearson", "stock_pearson31_2"]].map(([n, b]) => [
      n,
      {
        path: "helm.html?quality=low",
        run: async (page) => {
          await helmStart(page, async (p) => {
            const r = p.locator(`input[name="boat"][value="${b}"]`);
            // Only boats in PLAYABLE_STOCK (sea3d/src/boats/specs.ts) are offered; others skip.
            if ((await r.count()) !== 1) throw new SkipCheck(`${b} isn't offered in the helm's boat picker`);
            await r.check();
          });
          const st = await hop(page, "#sday");
          return `${b} to day ${st.day.toFixed(2)} (stop ${st.stop}, ${st.secs} s)`;
        },
      },
    ]),
  ),
  "helm-cinematic": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      await hop(page, "#s6");
      return cinematic(page, () => window.__helm.frames);
    },
  },
  "voyage-cinematic": {
    path: "voyage.html?voyage=2020-04-15&quality=low",
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
  // Results (#307): play "until something happens" to the end of the voyage; the
  // card says where the build stands and offers the three ways on, which work.
  "helm-results": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await helmStart(page);
      if (!(await page.$("#r-next"))) throw new SkipCheck("the deployed helm has no Results 'where this leaves you' yet");
      // The finish scene (#334): note whether the banner showed before the card.
      await page.evaluate(() => {
        const a = document.getElementById("arrive");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__sawArrive = document.getElementById("arrivehead")?.textContent || "(no headline)"; }).observe(a, { attributes: true });
      });
      let hops = 0;
      for (; hops < 60 && !(await page.evaluate(() => window.__helm.card)); hops++) {
        // The voyage can end while the button is hidden behind the card: wait for the card then.
        if (!(await page.evaluate(() => window.__helm.card))) await openOrders(page);
        if (!(await page.locator("#sevent").isVisible())) {
          await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 4 * MIN }).catch(() => {
            throw new CheckFail(`"Sail until something happens" disappeared at hop ${hops} and no results card came`);
          });
          break;
        }
        const st = await hop(page, "#sevent");
        if (st.stop === "over") await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 4 * MIN });
      }
      const card = await page.evaluate(() => window.__helm.card);
      must(card, `no results card after ${hops} hops of "until something happens"`);
      const arrive = await page.evaluate(() => ({ outcome: window.__helm.card?.boat?.outcome, saw: window.__sawArrive ?? null, has: !!document.getElementById("arrive") }));
      if (arrive.has && arrive.outcome === "arrived") must(arrive.saw, "the boat arrived but the finish scene's banner never showed");
      must(await page.locator("#result").isVisible(), "the results card isn't shown");
      await page.waitForFunction(() => window.__helm.standing, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the results card never said where the build stands");
      });
      const next = await page.evaluate(() => ({
        kind: window.__helm.standing,
        head: document.querySelector("#r-next .standing")?.textContent ?? "",
        links: [...document.querySelectorAll("#r-next .next a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href") })),
      }));
      must(next.head.trim(), "the standing line is empty");
      must(next.links.length === 3, `expected 3 ways on, got ${JSON.stringify(next.links)}`);
      await page.screenshot({ path: `play-${BROWSER}-results-card.png` }).catch(() => {});
      // Follow the leaderboard link like a player: the board loads.
      const lb = next.links.find((l) => /leaderboard/.test(l.href));
      must(lb, "no Leaderboard link on the card");
      const link = page.locator(`#r-next .next a[href="${lb.href}"]`);
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await link.click({ timeout: 15_000 }).catch((e) => {
        throw new CheckFail(`the card's Leaderboard link can't be clicked: ${String(e).split("\n")[0]}`);
      });
      await page.waitForFunction(() => window.__leaderboard?.ready, null, { timeout: MIN }).catch(() => {
        throw new CheckFail(`the card's Leaderboard link (${lb.href}) didn't open a working board`);
      });
      return `${hops} hops to the card (${card.verdict}, day ${card.boat.days.toFixed(1)}); "${next.head.trim()}" [${next.kind}]; links ${next.links.map((l) => l.text.trim()).join(" / ")}; the Leaderboard link opened the board${arrive.saw ? `; finish scene: "${arrive.saw}"` : `; outcome ${arrive.outcome}, no finish scene`}`;
    },
  },
  // Randolph Rev C5 preset (#304): labelled as our model, its weight, and it launches.
  "boatyard-revc5": {
    path: "boatyard.html?quality=low#base=revc",
    run: async (page) => {
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      const label = (await page.locator('#bases button[data-base="revc"]').textContent().catch(() => "")) ?? "";
      if (!/C5/.test(label)) throw new SkipCheck(`the deployed Boatyard has no Rev C5 preset yet ("${label.trim()}")`);
      const pressed = await page.getAttribute('#bases button[data-base="revc"]', "aria-pressed");
      must(pressed === "true", "opening #base=revc didn't select the Rev C5 preset");
      must(/our model/i.test(label), `the preset isn't labelled as our model: "${label.trim()}"`);
      // The boat's totals fill in a moment after the preset is picked: give them a few seconds.
      const shown = await page.waitForFunction(() => /26\.9\s*kg/.test(document.body.innerText), null, { timeout: 20_000 }).then(() => true).catch(() => false);
      const kg = shown ? "" : await page.evaluate(() => (document.body.innerText.match(/\d+(\.\d)?\s*kg/g) || []).slice(0, 4).join(", "));
      must(shown, `the page doesn't show 26.9 kg for the Rev C5's boat after 20 s (weights on the page: ${kg || "none"})`);
      await page.screenshot({ path: `play-${BROWSER}-revc5.png` }).catch(() => {});
      await page.click("#launch");
      await page.waitForFunction(() => window.__yard.launch || window.__yard.launchError, null, { timeout: 15 * MIN });
      const r = await page.evaluate(() => ({ err: window.__yard.launchError, n: window.__yard.launch?.replays?.length ?? 0 }));
      must(!r.err, `the Rev C5 launch failed: ${r.err}`);
      must(r.n > 0, "the Rev C5 launch gave no voyages");
      return `"${label.trim()}" selected, 26.9 kg shown, launched: ${r.n} voyages`;
    },
  },
  // "My boat" (#310): a Boatyard design saved as my boat carries to the helm,
  // race and voyage pages in the same browser. The name has tags in it, which
  // must show as plain text everywhere: the visible text has to include them
  // literally (the page's own <b> formatting around the name is fine). Skips until the deployed Boatyard has it.
  // #346: a hint by the replay's speed bar for a few seconds as a replay opens.
  "voyage-hint": {
    path: "voyage.html?quality=low",
    run: async (page) => {
      if (!(await page.locator("#warphint").count())) throw new SkipCheck("this build has no speed-bar hint (#346 not deployed)");
      const text = await page.waitForFunction(() => { const e = document.getElementById("warphint"); return !e.hidden && e.textContent.trim(); }, null, { timeout: 2 * MIN }).then((h) => h.jsonValue()).catch(() => "");
      must(text, "no hint showed by the speed bar as the replay opened");
      await page.screenshot({ path: `play-${BROWSER}-warphint.png` }).catch(() => {});
      const gone = await page.waitForFunction(() => document.getElementById("warphint").hidden, null, { timeout: 15_000 }).then(() => true).catch(() => false);
      must(gone, `the speed-bar hint "${text}" didn't go away`);
      return `hint "${text}" showed, then went`;
    },
  },
  // #344: the Boatyard's odds update as you swap a part, and parts show how they'd change them.
  "boatyard-odds": {
    path: "boatyard.html?quality=low",
    run: async (page) => {
      if (!(await page.locator("#s-odds").count())) throw new SkipCheck("this build has no live odds (#344 not deployed)");
      await page.waitForFunction(() => /\d+%/.test(document.getElementById("s-odds").textContent) && document.querySelector(".opt .delta.up, .opt .delta.down"), null, { timeout: 2 * MIN }).catch(async () => {
        const t = await page.evaluate(() => document.getElementById("s-odds").textContent);
        throw new CheckFail(`no odds with part changes showed (odds "${t}")`);
      });
      const before = await page.evaluate(() => document.getElementById("s-odds").textContent.trim());
      const opt = page.locator(".opt:has(.delta.down), .opt:has(.delta.up)").first();
      const delta = (await opt.locator(".delta").textContent())?.trim();
      await opt.scrollIntoViewIfNeeded().catch(() => {});
      await opt.click({ noWaitAfter: true });
      const after = await page.waitForFunction((b) => { const t = document.getElementById("s-odds").textContent.trim(); return t !== b && /\d+%/.test(t) && t; }, before, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => "");
      must(after, `picking a part marked ${delta} left the odds at "${before}"`);
      await page.screenshot({ path: `play-${BROWSER}-odds.png` }).catch(() => {});
      return `odds ${before}, picked a part marked ${delta}, now ${after}`;
    },
  },
  "my-boat": {
    path: "boatyard.html?quality=low",
    run: async (page) => {
      const NAME = "<b>Nina</b> Rev C test";
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.$("#mb-save"))) throw new SkipCheck("the deployed Boatyard has no \"my boat\" button yet");
      await page.click('#bases button[data-base="revc"]', { noWaitAfter: true });
      await page.fill("#mb-name", NAME);
      await page.click("#mb-save", { noWaitAfter: true });
      await page.waitForFunction(() => !!window.__yard.mine, null, { timeout: 10_000 }).catch(() => {
        throw new CheckFail("clicking Save as my boat didn't save it (window.__yard.mine is empty)");
      });
      const yard = await page.evaluate(() => ({
        line: document.querySelector("#mb-line")?.textContent ?? "",
        btn: document.querySelector("#mb-save")?.textContent ?? "",
        stored: localStorage.getItem("boatsim.myboat.v1"),
      }));
      must(yard.stored, "nothing was stored under boatsim.myboat.v1");
      must(/your boat/i.test(yard.line), `the Boatyard line doesn't say it's my boat: "${yard.line}"`);
      const seen = [`Boatyard: "${yard.line.trim()}" / button "${yard.btn.trim()}"`];

      // Helm: the "mine" row is on top and ticked, and starting sails the Rev C.
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const helm = await page.evaluate(() => {
        const r = document.querySelector('input[name="boat"][value="mine"]');
        const label = r?.closest("label")?.textContent ?? "";
        return { has: !!r, checked: !!r?.checked, label };
      });
      must(helm.has, "the helm's boat list has no row for my boat");
      must(helm.checked, "my boat isn't ticked at the helm");
      must(helm.label.includes(NAME), `the helm's row doesn't show the name as typed: "${helm.label.trim()}"`);
      await helmStart(page);
      const sailing = await page.evaluate(() => window.__helm.sailing);
      must(sailing?.base === "revc", `the helm sailed ${JSON.stringify(sailing)}, not my Rev C`);
      const st = await hop(page, "#s6");
      seen.push(`helm: sailing ${sailing.base}/${sailing.spec}, day ${st.day}`);

      // Race: my boat is the first, selected choice for boat A.
      await page.goto(SITE + "race.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => !!window.__race, null, { timeout: MIN });
      const race = await page.evaluate(() => {
        const sel = document.querySelector("#baseA");
        const first = sel?.options[0];
        return { value: sel?.value, first: first?.value, text: first?.textContent ?? "" };
      });
      must(race.first === "mine" && race.value === "mine", `the race doesn't pick my boat first: ${JSON.stringify(race)}`);
      must(race.text.includes(NAME), `the race option doesn't show the name as typed: "${race.text}"`);
      seen.push(`race: "${race.text}"`);

      // Voyage: with no ?voyage= it opens a replay of my boat's kind.
      await page.goto(SITE + "voyage.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      const rep = await page.evaluate(() => ({ err: window.__replay.error, search: location.search }));
      must(!rep.err, `the voyage page didn't load my boat's replay: ${rep.err}`);
      seen.push("voyage: a replay loaded");
      return seen.join("; ");
    },
  },
  // ---------- Omar's manual live checks (run by name: playtest dispatch, checks="...") ----------
  // #401 (Jonas, Leo, Ines, Elena): Watch a voyage on the helm system, at three sizes in Chrome
  // and Firefox. Frames printed to the log; the state around each key is printed on a STATE line.
  "look-401": {
    manual: true,
    path: "voyage.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.frames ?? 0) > 20, null, { timeout: 3 * MIN });
      const ui = () => page.evaluate(() => {
        const r = (id) => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), vis: !!e.offsetParent || getComputedStyle(e).position === "fixed" }; };
        const sel = document.getElementById("voyage");
        return {
          drawer: document.getElementById("top")?.classList.contains("open") ?? null,
          replay: sel?.selectedOptions?.[0]?.textContent ?? "",
          strip: (document.getElementById("strip")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 300),
          eq: [...document.querySelectorAll("#eq .part")].map((p) => (p.classList.contains("bad") ? "RED:" : "") + (p.getAttribute("title") ?? p.textContent ?? "").slice(0, 30)),
          eqWarn: /⚠/.test(document.getElementById("eq")?.textContent ?? ""),
          kt: /\b\d+(\.\d+)?\s*kt\b/.test(document.body.innerText),
          card: (document.querySelector(".poi-card:not(.poi-out)")?.innerText ?? "").replace(/\s+/g, " ").slice(0, 120),
          sound: `${document.getElementById("soundbtn")?.getAttribute("aria-pressed")}|${document.getElementById("soundbtn")?.textContent?.trim()}`,
          body: document.body.className,
          film: r("film"), mapbox: r("mapbox"), top: r("top"), strip_r: r("strip"),
        };
      });
      const overlap = (a, b) => a && b && a.w && b.w && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      const out = [];
      for (const [w, h] of [[1400, 900], [1280, 720], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(2000);
        const u = await ui();
        console.log(`STATE ${w} ${JSON.stringify(u)}`);
        await lookShot(page, `look-401-${BROWSER}-${w}.jpg`);
        must(!u.kt, `at ${w}: "kt" still on the page`);
        must(!u.eqWarn, `at ${w}: a warning sign in the equipment icons`);
        must(!overlap(u.film, u.top) || !u.drawer, `at ${w}: the map icon row overlaps the open drawer`);
        out.push(`${w}: drawer ${u.drawer}, ${u.eq.length} icons`);
      }
      const u0 = await ui();
      must(/1 Jun/.test(u0.replay), `default replay isn't 1 Jun: "${u0.replay}"`);
      // R: the drawer toggles.
      await page.mouse.click(5, 300).catch(() => {}); // focus the page, away from the strip
      await page.keyboard.press("r");
      await page.waitForTimeout(1500);
      const u1 = await ui();
      await lookShot(page, `look-401-${BROWSER}-1024-R.jpg`);
      must(u1.drawer !== u0.drawer, `R didn't toggle the drawer (${u0.drawer} -> ${u1.drawer})`);
      // N: sound; C: cinematic (and C again to leave).
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      const u2 = await ui();
      await page.keyboard.press("n");
      await page.keyboard.press("c");
      await page.waitForTimeout(2500);
      const u3 = await ui();
      await lookShot(page, `look-401-${BROWSER}-1024-C.jpg`);
      await page.keyboard.press("c");
      await page.waitForTimeout(1500);
      console.log(`STATE keys ${JSON.stringify({ n: [u1.sound, u2.sound], c: [u1.body, u3.body] })}`);
      must(u2.sound !== u1.sound, `N didn't change the sound button (${u1.sound})`);
      must(u3.body !== u1.body || u3.strip !== u1.strip, "C didn't change anything on the page");
      // Late in the voyage: equipment icons that broke are red; history card shows "N of M".
      await page.evaluate(() => window.__replay.setHour?.(24 * 60));
      await page.waitForTimeout(3000);
      const u4 = await ui();
      await lookShot(page, `look-401-${BROWSER}-1024-late.jpg`);
      console.log(`STATE late ${JSON.stringify({ eq: u4.eq, card: u4.card })}`);
      out.push(`R ok, N ok, C ok; late day 60: ${u4.eq.filter((x) => x.startsWith("RED")).length} red icons`);
      return out.join("; ");
    },
  },
  // #396 (Ravi, Milo's words): the helm results card on the 1 May 2020 launch (both boats lose a part on day 3.9).
  "card-396": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("one browser is enough for the words");
      await helmStart(page, async (p) => p.selectOption("#launch", "2"));
      for (let i = 0; i < 40 && !(await page.evaluate(() => window.__helm.card)); i++) {
        await openOrders(page);
        await page.click("#sevent");
        await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 4 * MIN });
        if ((await page.evaluate(() => window.__helm.lastStop)) === "over") await page.waitForFunction(() => window.__helm.card || window.__helm.error, null, { timeout: 4 * MIN });
      }
      must(await page.evaluate(() => !!window.__helm.card), "no results card");
      await page.waitForTimeout(4000);
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => ({ card: document.getElementById("result")?.innerText ?? "", preview: document.getElementById("preview")?.textContent ?? "", bar: (document.querySelector("#hud, .hud, #strip")?.innerText ?? "").replace(/\s+/g, " ") }));
      console.log(`CARD-396 ${JSON.stringify(t)}`);
      await lookShot(page, `look-396-${BROWSER}-card.jpg`);
      must(!/\$|\bbill\b|\bcost\b/i.test(t.card), "money words on the card");
      must(!/\b1 orders\b/.test(t.card), '"1 orders" on the card');
      return t.card.split("\n").filter((l) => /board|order|Launch/i.test(l)).join(" | ").slice(0, 400);
    },
  },
  // Maya's batch (12 Nov): #411 chase camera 42 deg off the stern, #412 opaque sea (no keel "stilts"),
  // #393 practice time trials (clock, best, medals, ghost), #404 no link, no orders. Frames + text.
  "look-maya": {
    manual: true,
    path: "helm.html",
    run: async (page) => {
      const out = [];
      await page.setViewportSize({ width: 1280, height: 720 });
      if (!process.env.NOLINK) {
      // #411/#412: the default crossing, a few seconds after Set sail.
      await helmStart(page);
      await page.evaluate(() => { if (!window.__helm.clock) document.getElementById("t-pause")?.click(); }); // let her move
      await page.waitForTimeout(6000);
      await lookShot(page, `look-maya-${BROWSER}-helm-chase.jpg`);
      out.push("helm chase frame");
      // #393: practice, triangle in a good breeze: the goal banner with its clock.
      await page.goto(SITE + "helm.html?practice", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.waitForFunction(() => !document.getElementById("practice-courses")?.hidden, null, { timeout: MIN }).catch(() => {});
      // A DOM click: Playwright's click waited out 15 s on the busy page (live 9cfdc91, both browsers).
      await page.evaluate(() => document.querySelector('#practice-breeze button[data-b="good"]')?.click());
      await page.waitForTimeout(500);
      await page.evaluate(() => document.querySelector('#practice-courses button[data-course="triangle"]')?.click());
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: MIN }).catch(() => { throw new CheckFail("the triangle didn't put me at the wheel"); });
      await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(1500); await page.keyboard.up("ArrowLeft");
      await page.waitForTimeout(8000);
      const what = await page.evaluate(() => (document.body.innerText.match(/Next mark[^\n]*/) ?? [document.getElementById("practice-what")?.innerText ?? ""])[0].replace(/\s+/g, " "));
      console.log(`PRACTICE ${JSON.stringify(what)}`);
      await lookShot(page, `look-maya-${BROWSER}-practice.jpg`);
      must(/\d+:\d\d/.test(what) || /\d+ s\b/.test(what), `no clock in the practice banner: "${what}"`);
      out.push(`practice banner "${what.slice(0, 80)}"`);
      }
      // #404: 1 May 2020, both boats lose the main box on day 3.9: the orders lock with "no link".
      if (BROWSER !== "chromium" && process.env.NOLINK) throw new SkipCheck("one browser is enough for the lock");
      if (BROWSER === "chromium" && process.env.NOLINK) {
        // nolink-404 opens helm.html?quality=low itself: a second goto here aborted its model fetches.
        await helmStart(page, async (p) => p.selectOption("#launch", "2"));
        let st = null;
        for (let i = 0; i < 30; i++) {
          st = await page.evaluate(() => ({ nl: window.__helm.status?.no_link ?? null, card: !!window.__helm.card, day: window.__helm.status?.day }));
          if (st.nl || st.card) break;
          await openOrders(page);
          await page.click("#sevent");
          await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 4 * MIN });
        }
        // The picture plays up to the stop at its own pace; the lock lands when it gets there.
        if (st?.nl) {
          await page.evaluate(() => { if (!window.__helm.clock) document.getElementById("t-pause")?.click(); });
          await page.waitForFunction((d) => parseFloat((document.getElementById("day")?.textContent ?? "").replace(/[^0-9.]/g, "")) >= d - 0.05 || !document.getElementById("nolink")?.hidden, st.day, { timeout: 6 * MIN }).catch(() => {});
        }
        await page.waitForTimeout(3000);
        if (await page.locator("#result").isVisible().catch(() => false)) await lookShot(page, `look-maya-${BROWSER}-nolink-card.jpg`).catch(() => {});
        await page.evaluate(() => { const c = document.getElementById("result"); if (c) c.hidden = true; }); // see what's behind it
        await openOrders(page);
        await page.waitForTimeout(1500);
        const nl = await page.evaluate(() => ({
          tab: document.querySelector("#orders-tab span")?.textContent ?? "",
          banner: document.getElementById("nolink")?.hidden === false ? document.getElementById("nolinktext")?.textContent : "(hidden)",
          strip: document.getElementById("c-orderv")?.textContent ?? "",
          status: window.__helm.status?.no_link ?? null,
        }));
        console.log(`NOLINK ${JSON.stringify({ ...nl, st })}`);
        await lookShot(page, `look-maya-${BROWSER}-nolink.jpg`).catch(() => {});
        must(nl.status, `no_link never set (day ${st?.day})`);
        must(/no link/i.test(nl.tab) && /no link/i.test(nl.strip), `orders not locked: ${JSON.stringify(nl)}`);
        out.push(`no link on day ${st.day?.toFixed?.(1)}: tab "${nl.tab}", strip "${nl.strip}"`);
      }
      return out.join("; ");
    },
  },
  // First-10-minutes sweep (Elena, 12 Nov), Omar's part: Boatyard, a replay and results, at
  // 1280x720 and 1920x1080, frames to the log. Also #383: no money anywhere in the Boatyard.
  "sweep-omar": {
    manual: true,
    path: "boatyard.html",
    run: async (page) => {
      const out = [];
      const money = () => page.evaluate(() => (document.body.innerText.match(/.{0,40}(\$\s?\d|\bprice|\bcost\b|\bbill\b|USD).{0,40}/gi) ?? []).slice(0, 8));
      for (const [w, h] of [[1280, 720], [1920, 1080]]) {
        await page.setViewportSize({ width: w, height: h });
        // Boatyard: our kayak, then a swap, then Rev C5.
        await page.goto(SITE + "boatyard.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 10, null, { timeout: 2 * MIN });
        await page.waitForTimeout(3000);
        await lookShot(page, `sweep-${BROWSER}-${w}-boatyard.jpg`);
        const m1 = await money();
        await page.locator('.opt[data-slot="bat"][data-opt="two-100ah"]').click().catch(() => {});
        await page.waitForTimeout(3000);
        await lookShot(page, `sweep-${BROWSER}-${w}-boatyard-swap.jpg`);
        await page.goto(SITE + "boatyard.html#base=revc", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 10, null, { timeout: 2 * MIN });
        await page.waitForTimeout(3000);
        await lookShot(page, `sweep-${BROWSER}-${w}-boatyard-revc.jpg`);
        const m2 = await money();
        console.log(`MONEY ${w} ${JSON.stringify([...m1, ...m2])}`);
        out.push(`${w}: Boatyard money hits ${m1.length + m2.length}`);
        // A replay: default, a minute in at 1 d/s, and the end card.
        await page.goto(SITE + "voyage.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__replay && (window.__replay.frames ?? 0) > 20, null, { timeout: 3 * MIN });
        await page.waitForTimeout(4000);
        await lookShot(page, `sweep-${BROWSER}-${w}-replay-open.jpg`);
        await page.waitForTimeout(12_000);
        await lookShot(page, `sweep-${BROWSER}-${w}-replay-15s.jpg`);
        await page.evaluate(() => window.__replay.setHour?.(24 * 30));
        await page.waitForTimeout(4000);
        await lookShot(page, `sweep-${BROWSER}-${w}-replay-day30.jpg`);
        await page.evaluate(() => window.__replay.setHour?.(24 * 400));
        await page.waitForTimeout(5000);
        await lookShot(page, `sweep-${BROWSER}-${w}-replay-end.jpg`);
        // Results: Boatyard "Test it" results (in this browser), then the leaderboard it links to.
        await page.goto(SITE + "boatyard.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__yard?.ready, null, { timeout: 2 * MIN });
        await page.click("#launch").catch(() => {});
        await page.waitForTimeout(90_000);
        await lookShot(page, `sweep-${BROWSER}-${w}-results-testit.jpg`);
        const m3 = await money();
        if (m3.length) console.log(`MONEY ${w} results ${JSON.stringify(m3)}`);
        await page.goto(SITE + "leaderboard.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__leaderboard?.ready || window.__leaderboard?.error, null, { timeout: MIN }).catch(() => {});
        await lookShot(page, `sweep-${BROWSER}-${w}-results-leaderboard.jpg`);
        must(!m1.length && !m2.length, `money in the Boatyard at ${w}: ${JSON.stringify([...m1, ...m2].slice(0, 3))}`);
      }
      return out.join("; ");
    },
  },
  "nolink-404": { manual: true, path: "helm.html?quality=low", run: async (page) => { process.env.NOLINK = "1"; await page.setViewportSize({ width: 1280, height: 720 }); return CHECKS["look-maya"].run(page); } },
  // #380 (audit item 9, Leo's copy): player names on the leaderboard and in the Boatyard.
  "names-380": {
    manual: true,
    path: "leaderboard.html",
    run: async (page) => {
      await page.waitForFunction(() => window.__leaderboard?.ready || window.__leaderboard?.error, null, { timeout: 2 * MIN });
      const lb = await page.evaluate(() => ({
        err: window.__leaderboard.error,
        head: document.querySelector("#you, .you")?.innerText ?? document.body.innerText.split("\n").find((l) => /^Best:/.test(l)) ?? "",
        names: [...document.querySelectorAll("#rows .name")].map((c) => c.firstChild?.textContent ?? ""),
        randolph: [...document.querySelectorAll("#rows .name")].filter((c) => /Randolph/.test(c.textContent)).map((c) => !!c.querySelector(".modeltag")),
        best: (document.body.innerText.match(/Best:[^\n]*/) ?? [""])[0],
      }));
      console.log(`NAMES-380 ${JSON.stringify(lb)}`);
      await page.setViewportSize({ width: 1280, height: 720 });
      await lookShot(page, `look-380-${BROWSER}-leaderboard.jpg`);
      must(!lb.err, `the board didn't load: ${lb.err}`);
      must(/^Best: /.test(lb.best.trim()) && /% finish/.test(lb.best), `headline: "${lb.best}"`);
      const leaked = lb.names.filter((n) => /Drive:|solar-\d|two-100ah|one-box|\b[a-z]+-[a-z0-9]+\b|\(our model\)|GUESS|ROUGH|OUR PICK|as modelled|as published/.test(n));
      must(!leaked.length, `internal words in names: ${JSON.stringify(leaked)}`);
      must(lb.randolph.length && lb.randolph.every(Boolean), `Randolph rows without the "our model" tag: ${JSON.stringify(lb.randolph)}`);
      // The Boatyard: Rev C5 as built, "Test it" -> the note names the grid build.
      await page.goto(SITE + "boatyard.html?quality=low#base=revc", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__yard?.ready, null, { timeout: 2 * MIN });
      await page.click("#launch");
      const note = await page
        .waitForFunction(() => (document.body.innerText.match(/(Simulated|Closest build we've simulated): [^\n]*/) ?? [null])[0], null, { timeout: 4 * MIN })
        .then((h) => h.jsonValue())
        .catch(() => "");
      await lookShot(page, `look-380-${BROWSER}-boatyard-revc.jpg`);
      must(note === "Simulated: Randolph Rev C5, as built (our model).", `Boatyard note: "${note}"`);
      return `"${lb.best.trim()}"; ${lb.names.length} names clean; ${lb.randolph.length} Randolph rows tagged; Boatyard: "${note}"`;
    },
  },
  // #385 (Felix): the sea sound. Taps what reaches the speakers with an analyser: silent before the
  // first click, starts after it, louder in a gale than on a light day, N mutes and brings it back,
  // and nothing clips. (No volume control on the page: on or off only.)
  "sound-385": {
    manual: true,
    path: "",
    run: async (page) => {
      await page.addInitScript(() => {
        const taps = (window.__taps = []);
        const orig = AudioNode.prototype.connect;
        AudioNode.prototype.connect = function (dest, ...rest) {
          if (dest instanceof AudioDestinationNode) {
            const a = this.context.createAnalyser();
            a.fftSize = 4096;
            orig.call(this, a);
            taps.push(a);
          }
          return orig.call(this, dest, ...rest);
        };
        window.__level = () => {
          let sum = 0, n = 0, peak = 0;
          const st = window.__taps[0]?.context.state ?? "none";
          for (const a of window.__taps) {
            const b = new Float32Array(a.fftSize);
            a.getFloatTimeDomainData(b);
            for (const v of b) { sum += v * v; n++; peak = Math.max(peak, Math.abs(v)); }
          }
          const rms = n ? Math.sqrt(sum / n) : 0;
          return { st, db: rms > 0 ? Math.round(20 * Math.log10(rms) * 10) / 10 : -999, peak: Math.round(peak * 1000) / 1000 };
        };
      });
      const listen = async (secs) => {
        const xs = [];
        for (let i = 0; i < secs * 4; i++) { xs.push(await page.evaluate(() => window.__level())); await page.waitForTimeout(250); }
        const dbs = xs.map((x) => x.db).filter((d) => d > -999).sort((a, b) => a - b);
        return { st: xs.at(-1).st, med: dbs.length ? dbs[Math.floor(dbs.length / 2)] : -999, peak: Math.max(...xs.map((x) => x.peak)) };
      };
      const out = [];
      const play = async (label, setup) => {
        await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        const before = await listen(2);
        must(before.med === -999 || before.med < -80, `${label}: sound before any click (${JSON.stringify(before)})`);
        await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
        await setup();
        await page.click("#go");
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
        const ask = await page.waitForSelector("#soundyes", { state: "visible", timeout: 30_000 }).then(() => true).catch(() => false);
        if (ask) await page.click("#soundyes");
        else {
          // Turned on last visit: it comes back by itself at the first click (#go). Only press N if it didn't.
          await page.waitForTimeout(2000);
          if ((await listen(1)).med < -80) await page.keyboard.press("n");
        }
        await page.waitForTimeout(3000);
        const on = await listen(8);
        const w = await page.evaluate(() => ({ wind: window.__helm.status?.wind_ms ?? window.__helm.status?.wind ?? null, hs: window.__helm.status?.hs ?? null }));
        out.push(`${label}: ${on.med} dBFS median, peak ${on.peak}, ctx ${on.st}, asked ${ask}, weather ${JSON.stringify(w)}`);
        must(on.st === "running", `${label}: the audio never started (${on.st})`);
        must(on.med > -70, `${label}: sound on but silent (${on.med} dBFS)`);
        must(on.peak < 0.99, `${label}: clipping (peak ${on.peak})`);
        must(on.med < -10, `${label}: too loud (${on.med} dBFS median)`);
        return on;
      };
      const calm = await play("23 Apr light day", async () => {});
      await page.keyboard.press("n");
      await page.waitForTimeout(1500);
      const off = await listen(3);
      must(off.med < calm.med - 30 || off.med === -999, `N didn't mute (${off.med} dBFS vs ${calm.med})`);
      await page.keyboard.press("n");
      await page.waitForTimeout(2000);
      const back = await listen(3);
      must(back.med > calm.med - 10, `N didn't bring it back (${back.med} dBFS)`);
      out.push(`N: ${off.med} dBFS muted, ${back.med} back`);
      const gale = await play("Dorian challenge", async () => {
        await page.waitForFunction(() => !document.querySelector("#chpick").hidden, null, { timeout: MIN });
        const id = await page.evaluate(() => [...document.querySelectorAll("#challenge option")].map((o) => o.value).find((v) => /dorian/i.test(v)));
        must(id, "no Dorian challenge offered");
        await page.selectOption("#challenge", id);
      });
      must(gale.med > calm.med + 6, `the gale isn't louder than the light day (${gale.med} vs ${calm.med} dBFS)`);
      return out.join("; ");
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

/** First line of a Playwright error plus the last steps of its call log (why a click waited: hidden, disabled, covered, off screen). */
function whyStuck(e) {
  const lines = String(e).split("\n");
  const log = lines.filter((l) => /^\s+-\s/.test(l)).slice(-3).map((l) => l.trim().replace(/^-\s*/, ""));
  return lines[0] + (log.length ? ` [${log.join(" / ")}]` : "");
}

async function runCheck(browser, name) {
  const t0 = Date.now();
  let o;
  let result = "";
  let failure = "";
  try {
    o = await open(browser, CHECKS[name].path);
    result = await CHECKS[name].run(o.page);
  } catch (e) {
    if (e instanceof SkipCheck) {
      await o?.ctx.close().catch(() => {});
      return { name, ok: true, skip: true, detail: [`skipped: ${e.message}`], notes: [], secs: Math.round((Date.now() - t0) / 1000) };
    }
    failure = e instanceof CheckFail ? e.message : `stuck or crashed: ${whyStuck(e)}`;
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
// Headless Firefox on a runner has no WebGL ("WebGL creation failed"); run it
// headed under xvfb (HEADED=1, see the workflows) on Mesa's software GL, with WebGL forced on.
const LAUNCH = {
  headless: !process.env.HEADED,
  ...((process.env.BROWSER ?? "chromium") === "firefox"
    ? { firefoxUserPrefs: { "webgl.force-enabled": true, "webgl.disabled": false, "webgl.enable-webgl2": true } }
    : {}),
};
const browser = await pw[BROWSER].launch(LAUNCH);
const results = [];
for (const n of names) {
  const r = await runCheck(browser, n);
  results.push(r);
  console.log(`${r.skip ? "SKIP" : r.ok ? "PASS" : "FAIL"} ${BROWSER} ${n} (${r.secs} s):${r.detail.map((d) => `\n    - ${d}`).join("")}`);
  for (const x of r.notes.slice(0, 10)) console.log(`    (${x})`);
}
await browser.close();
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `| ${BROWSER} | Result |\n|---|---|\n${results.map((r) => `| ${r.skip ? "➖" : r.ok ? "✅" : "❌"} ${r.name} | ${r.detail.join("<br>").replace(/\|/g, "\\|")} |`).join("\n")}\n`,
  );
process.exit(results.some((r) => !r.ok) ? 1 : 0);
