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


/** Pick a boat row. The Set sail card keeps the radios hidden and picks through the top bar's
 * My boat picker, which ticks the row and fires change: do the same when the row can't be seen. */
async function tickBoat(r) {
  if (await r.isVisible()) return r.check();
  await r.evaluate((el) => {
    el.checked = true;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
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
  // The status reads day 0 until the clock's first run (already under way when we paused) comes
  // back, which can take a few seconds in Firefox: settle only after that (#368 gate, helm-until).
  await page.waitForFunction(() => (window.__helm.status?.day ?? 0) > 0, null, { timeout: 30_000 }).catch(() => {});
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

/** A look frame. On software graphics one heavy frame can take more than 30 s to draw (look-heel,
 * 12 Nov), so allow 90 s and try twice; a frame that still won't come is noted, not a failure. */
async function jpeg(page, path) {
  for (let i = 0; i < 2; i++) {
    try {
      await page.screenshot({ path, type: "jpeg", quality: 85, timeout: 90_000, animations: "disabled" });
      return true;
    } catch (e) {
      console.log(`(frame ${path} not taken, try ${i + 1}: ${String(e.message).split("\n")[0]})`);
    }
  }
  return false;
}
/** Practice: start "The triangle" and wait until you have the wheel. The course buttons can
 * resolve before they take clicks (still loading or sliding in; look-heel 12 Nov), so wait for
 * the page to be idle and the button to be visible and enabled, retry, then click in-page. */
async function practiceTriangle(page) {
  // The Set sail card opens on Annapolis on a practice page (M1): pick the triangle, then Set sail.
  const sel = "#go";
  await page.waitForFunction(() => document.querySelector("#ss-course-opts .ss-pill"), null, { timeout: 3 * MIN }).catch(() => {});
  await page.evaluate(() => document.querySelector("#ss-course-opts .ss-pill")?.click()); // the first course: the triangle
  await page.waitForFunction(() => !window.__helm?.busy, null, { timeout: 3 * MIN }).catch(() => {});
  for (let i = 0; i < 3 && !(await page.evaluate(() => !!window.__wheel?.on)); i++) {
    await page.waitForFunction((s) => { const b = document.querySelector(s); return b && !b.disabled && b.offsetParent !== null; }, sel, { timeout: MIN }).catch(() => {});
    await page.click(sel, { timeout: 15_000 }).catch(() => page.evaluate((s) => document.querySelector(s)?.click(), sel));
    await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 30_000 }).catch(() => {});
  }
  const on = await page.evaluate(() => !!window.__wheel?.on);
  if (!on) {
    const why = await page.evaluate((s) => { const b = document.querySelector(s); if (!b) return "no button"; const r = b.getBoundingClientRect(); const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return `button ${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)} disabled=${b.disabled}; on top: ${top ? top.tagName + "#" + top.id + "." + top.className : "nothing"}`; }, sel);
    throw new CheckFail(`"The triangle" didn't put me at the wheel (${why})`);
  }
}
/** Reload once the page has finished fetching: in Chromium, leaving while the boat model's
 * textures are still decoding logs "GLTFLoader: Couldn't load texture blob:" (sound-helm, 12 Nov). */
async function calmReload(page) {
  await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await page.reload({ waitUntil: "load", timeout: 2 * MIN });
}
/** Ada's proof clock (tools/proof/capture.mjs), plus release(): held, the page's rAF,
 * performance.now and Date.now only move when stepped, so each filmed frame is exactly 1/fps. */
const FILM_CLOCK = `(() => {
  const realRaf = window.requestAnimationFrame.bind(window), realNow = performance.now.bind(performance), realDate = Date.now.bind(Date);
  let held = null, vt = 0, lag = 0; const q = [];
  window.__proofClock = {
    hold() { if (held === null) { held = realNow(); vt = held - lag; } },
    step(ms) { vt += ms; const cbs = q.splice(0); for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } } return cbs.length; },
    release() { if (held === null) return; lag = realNow() - vt; held = null; for (const cb of q.splice(0)) realRaf(cb); },
  };
  performance.now = () => (held === null ? realNow() - lag : vt);
  Date.now = () => realDate() - (realNow() - performance.now());
  window.requestAnimationFrame = (cb) => (held === null ? realRaf((t) => cb(t - lag)) : (q.push(cb), q.length));
})();`;
/** #385: count the page's AudioContexts (an init script, so it sees the very first one). */
const soundSpy = () => {
  window.__ac = [];
  const Orig = window.AudioContext;
  if (Orig) window.AudioContext = class extends Orig { constructor(...a) { super(...a); window.__ac.push(this); } };
};
const soundState = (page) =>
  page.evaluate(() => {
    const b = document.getElementById("soundbtn");
    let stored = null;
    try { stored = localStorage.getItem("boatsim-sound"); } catch {}
    return { contexts: (window.__ac ?? []).length, state: (window.__ac ?? []).map((c) => c.state).join(",") || "none", pressed: b?.getAttribute("aria-pressed") === "true", text: b?.textContent.trim(), icon: b?.textContent.trim(), stored };
  });

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
      const fast = page.locator('#timebar .rate[data-rate="96"]');
      let decided = null;
      for (let i = 0; i < 12 && !decided; i++) {
        if (await page.evaluate(() => window.__helm.card || window.__helm.status?.over)) break;
        // Key 5 is "4 days a second" (key 1 is real time since T1) (the key hint); a key can't be blocked by a panel over the button.
        if (await page.evaluate(() => window.__helm.clock === 0)) {
          if (await fast.isVisible()) await fast.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => page.keyboard.press("5"));
          else await page.keyboard.press("5");
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
      // "Sound on?" (#334, then Leo's one-thing-at-a-time opening): asked once, a minute in or
      // a few seconds after the first call, whichever comes first (older builds: on Set sail).
      // It closes by itself after 20 s, so: it was asked, and it goes away.
      if (await page.locator("#soundask").count()) {
        const asked = await page.waitForFunction(() => !document.getElementById("soundask").hidden || window.__askedSound, null, { timeout: 75_000 }).then(() => true).catch(() => false);
        must(asked, `"Sound on?" was never asked (expected a minute in, or after the first call)`);
        const clicked = (await page.click("#soundno", { noWaitAfter: true, timeout: 5_000 }).then(() => true).catch(() => false));
        const gone = await page.waitForFunction(() => document.getElementById("soundask").hidden, null, { timeout: 25_000 }).then(() => true).catch(() => false);
        must(gone, `the "Sound on?" question didn't go away${clicked ? ' after "No thanks"' : ""}`);
        out.push(`"Sound on?" asked, ${clicked ? 'closed with "No thanks"' : "closed by itself after 20 s"}`);
      }
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
        await tickBoat(r);
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
      // The new heading starts a simulator run; Take the wheel waits for it (takeWheel awaits the
      // run in flight), which on a busy runner in Firefox can pass 20 s (Lena, #368). Let it finish
      // first, then time the handover itself; a slow one is reported, not failed.
      const tIdle = Date.now();
      await page.waitForFunction(() => !window.__helm.busy, null, { timeout: 2 * MIN }).catch(() => {});
      await page.waitForTimeout(1500);
      const idleSecs = Math.round((Date.now() - tIdle) / 1000);
      await openOrders(page);
      const b = page.locator("#b-wheel");
      must(await b.isVisible(), `no "Take the wheel" button on the cruiser`);
      const t0 = Date.now();
      await b.click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Take the wheel"`);
      });
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 60_000 }).catch(async () => {
        const n = await page.evaluate(() => document.querySelector("#notes .note .txt")?.textContent ?? "");
        throw new CheckFail(`"Take the wheel" didn't hand over the boat in 60 s (busy ${await page.evaluate(() => window.__helm.busy)}; latest note "${n}")`);
      });
      const handSecs = (Date.now() - t0) / 1000;
      out.push(`after the new heading the simulator was busy ~${idleSecs} s; the wheel took ${handSecs.toFixed(1)} s${handSecs > 5 ? " (slow for a player)" : ""}`);
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
  // #374 (Kai's NOW list): the default start is a good day with a "Rough start" offered, the chip
  // says "My boat: Our kayak" with no boat saved, both day labels agree running and after a player's
  // pause, and an event that happens to you and the ghost together is one note.
  "helm-now": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      const card = await page.evaluate(() => ({
        sel: document.querySelector("#launch option:checked")?.textContent ?? "",
        rough: [...document.querySelectorAll("#launch option")].some((o) => /rough start/i.test(o.textContent)),
        chip: document.querySelector("#topbar .boat")?.textContent.trim() ?? "",
      }));
      if (!/23 April/.test(card.sel)) throw new SkipCheck(`this build's default launch is "${card.sel}" (#374 not deployed)`);
      must(card.rough, 'no "Rough start" launch on the card');
      must(/My boat:\s*Our kayak/.test(card.chip), `the top bar chip says "${card.chip}" with no boat saved`);
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      await page.waitForFunction(() => (window.__helm.hour ?? 0) > 24 || window.__helm.clock === 0, null, { timeout: 3 * MIN }).catch(() => {});
      const read = () => page.evaluate(() => [document.getElementById("clock").textContent.trim(), document.getElementById("day").textContent.trim()]);
      const running = await read();
      if (await page.evaluate(() => window.__helm.clock > 0)) await page.click("#t-pause", { noWaitAfter: true });
      await page.waitForTimeout(2500);
      const paused = await read();
      await page.screenshot({ path: `play-${BROWSER}-now-paused.png` }).catch(() => {});
      must(paused[0] && paused[0] === paused[1], `after pressing pause the picture says "${paused[0]}" and the panel "${paused[1]}"`);
      must(running[0] === running[1], `while running the picture said "${running[0]}" and the panel "${running[1]}" in the same frame`);
      // Shared events: no two notes with the same words for "You" and "Ghost" at the same time.
      const notes = await page.evaluate(() => [...document.querySelectorAll("#notes .note")].map((n) => ({ when: n.querySelector(".when")?.textContent ?? "", txt: n.querySelector(".txt")?.textContent ?? "" })));
      const seen = new Map();
      const doubled = [];
      for (const n of notes) {
        const day = n.when.replace(/^(You|Ghost)\s*·\s*/, "");
        const k = `${day}|${n.txt}`;
        if (seen.has(k) && seen.get(k) !== n.when) doubled.push(`"${n.txt.slice(0, 60)}" (${seen.get(k)} and ${n.when})`);
        seen.set(k, n.when);
      }
      must(!doubled.length, `the same event shows twice: ${doubled.join("; ")}`);
      return `default "${card.sel}", rough start offered, chip "${card.chip}"; labels ${running.join(" = ")} running, ${paused.join(" = ")} paused; ${notes.length} notes, none doubled`;
    },
  },
  // #374: Watch a voyage has no text cut off with "..." and nothing hanging off the window.
  "voyage-fit": {
    path: "voyage.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      await page.waitForTimeout(3000);
      for (const [w, h] of [[1400, 900], [1280, 720], [1024, 700]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.waitForTimeout(1500);
        const bad = await page.evaluate(() => {
          const out = [];
          for (const e of document.querySelectorAll("body *")) {
            if (!e.offsetParent || e.closest("canvas, svg, select, option, #cine, .cinema")) continue;
            const cs = getComputedStyle(e);
            const r = e.getBoundingClientRect();
            if (!r.width || !r.height) continue;
            const text = (e.textContent || "").trim().slice(0, 40);
            if (cs.textOverflow === "ellipsis" && e.scrollWidth > e.clientWidth + 1) out.push(`cut off: "${text}"`);
            if (e.children.length === 0 && text && r.right > innerWidth + 1 && cs.position === "fixed") out.push(`off the right edge: "${text}"`);
          }
          return [...new Set(out)].slice(0, 6);
        });
        await page.screenshot({ path: `play-${BROWSER}-voyage-${w}.png` }).catch(() => {});
        must(!bad.length, `at ${w}x${h}: ${bad.join("; ")}`);
      }
      return "no cut-off text at 1400x900, 1280x720 or 1024x700";
    },
  },
  // #376: Practice off Annapolis (the triangle course at the wheel), the harbour prologue on the
  // cruiser from Annapolis (skip with Esc, then "Start the crossing"), and the orders drawer opens.
  "helm-376": {
    path: "helm.html?practice&quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#ss-course-opts").count())) throw new SkipCheck("this build has no practice courses on the Set sail card (M1 piece 3 not deployed)");
      const out = [];
      await page.waitForFunction(() => !document.getElementById("start").hidden && !document.getElementById("ss-course").hidden, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("Practice didn't open the Set sail card on its courses");
      });
      // On software graphics Practice's first frames can hold the page for over 15 s, so a click
      // waits there (Owen, 12 Nov); the helper waits for it to be idle and retries.
      await practiceTriangle(page);
      await page.keyboard.down("ArrowLeft"); await page.waitForTimeout(800); await page.keyboard.up("ArrowLeft");
      await page.screenshot({ path: `play-${BROWSER}-practice-triangle.png` }).catch(() => {});
      out.push("Practice: the triangle put me at the wheel");
      // The prologue: cruiser from Annapolis.
      await page.goto(SITE + "helm.html?quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
      await page.locator('input[name="boat"][value="stock_cruiser31"]').check();
      await page.waitForFunction(() => !document.querySelector("#portpick").hidden, null, { timeout: MIN });
      await page.selectOption("#port", "annapolis");
      const offered = await page.waitForFunction(() => !document.getElementById("prologuepick").hidden, null, { timeout: 30_000 }).then(() => true).catch(() => false);
      must(offered, 'the cruiser from Annapolis wasn\'t offered "Sail her out of the harbour yourself first"');
      await page.click("#go");
      await page.waitForFunction(() => window.__wheel?.on, null, { timeout: 2 * MIN }).catch(() => {
        throw new CheckFail("the harbour prologue didn't put you at the wheel");
      });
      await page.waitForTimeout(3000);
      await page.screenshot({ path: `play-${BROWSER}-prologue.png` }).catch(() => {});
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("prologue-end").hidden, null, { timeout: 30_000 }).catch(() => {
        throw new CheckFail("Esc in the prologue didn't bring up the 'Start the crossing' card");
      });
      const sum = await page.evaluate(() => document.getElementById("prologue-sum").textContent);
      await page.click("#prologue-go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "the crossing didn't start after the prologue");
      out.push(`prologue: "${sum}", then the crossing started`);
      // The orders drawer.
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      // The drawer slides in and out by itself at the start (and #406 shows one thing at a time),
      // so the tab can be moving; openOrders waits for it to settle (Owen, 12 Nov).
      await openOrders(page);
      const open = await page.waitForFunction(() => { const o = document.getElementById("orders"); return o.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 }).then(() => true).catch(() => false);
      must(open, "the Orders tab didn't open the orders drawer");
      out.push("orders drawer opens");
      return out.join("; ");
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
      await helmStart(page, async (p) => p.evaluate(() => document.querySelector('#ss-mode-opts .ss-pill:nth-child(2)').click()));
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
            await tickBoat(r);
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
        // The ways on: under the standing line (before #406), or the card's button row and quiet links (#406).
        links: [...document.querySelectorAll("#r-next .next a, #result .rc-btns a, #result .rc-links a")].map((a) => ({ text: a.textContent, href: a.getAttribute("href") })),
      }));
      must(next.head.trim(), "the standing line is empty");
      for (const want of [/boatyard/, /race/, /leaderboard/]) must(next.links.some((l) => want.test(l.href ?? "")), `no ${want.source} link among the ways on: ${JSON.stringify(next.links)}`);
      await page.screenshot({ path: `play-${BROWSER}-results-card.png` }).catch(() => {});
      // Follow the leaderboard link like a player: the board loads.
      const lb = next.links.find((l) => /leaderboard/.test(l.href));
      must(lb, "no Leaderboard link on the card");
      const link = page.locator(`#result a[href="${lb.href}"]`).first();
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
      // The button's accessible name: since #416 "our model" is said once for both Randolph boats,
      // beside them and in each button's aria-label, rather than on every button's face.
      const rc = page.locator('#bases button[data-base="revc"]');
      const label = ((await rc.getAttribute("aria-label").catch(() => null)) || (await rc.textContent().catch(() => "")) || "");
      if (!/C5/.test(label)) throw new SkipCheck(`the deployed Boatyard has no Rev C5 preset yet ("${label.trim()}")`);
      const pressed = await page.getAttribute('#bases button[data-base="revc"]', "aria-pressed");
      must(pressed === "true", "opening #base=revc didn't select the Rev C5 preset");
      must(/our model/i.test(label), `the preset isn't labelled as our model: "${label.trim()}" (${await page.evaluate(() => JSON.stringify([...document.querySelectorAll('[data-base="revc"]')].map((e) => [e.closest("[id]")?.id, e.getAttribute("aria-label"), e.textContent.trim()])))})`);
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
      // Sections and slots fold to one line (#416): open the ones holding this part first. Old builds: no-ops.
      const where = await opt.evaluate((el) => ({ group: el.closest(".slot[data-group]")?.getAttribute("data-group") ?? null, gopen: !!el.closest(".slot[data-group]")?.classList.contains("gopen"), slot: el.closest(".sl")?.getAttribute("data-slot") ?? null, sopen: !!el.closest(".sl")?.classList.contains("open") }));
      if (where.group && !where.gopen) await page.locator(`.slot[data-group="${where.group}"] h3`).click();
      if (where.slot && !where.sopen) await page.locator(`.sl-head[data-slot="${where.slot}"]`).click();
      await opt.scrollIntoViewIfNeeded().catch(() => {});
      await opt.click({ noWaitAfter: true, timeout: 30_000 }).catch(async (e) => {
        const why = await opt.evaluate((el) => { const r = el.getBoundingClientRect(); return { text: el.textContent.trim().slice(0, 60), box: [r.x, r.y, r.width, r.height].map(Math.round), hiddenBy: el.closest("[hidden], details:not([open])")?.outerHTML.slice(0, 120) ?? "", where: el.closest(".slot")?.outerHTML.slice(0, 160) ?? "" }; }).catch(() => ({}));
        throw new CheckFail(`couldn't click the part marked ${delta}: ${JSON.stringify({ where, ...why })} (${String(e).split("\n")[0]})`);
      });
      const after = await page.waitForFunction((b) => { const t = document.getElementById("s-odds").textContent.trim(); return t !== b && /\d+%/.test(t) && t; }, before, { timeout: 30_000 }).then((h) => h.jsonValue()).catch(() => "");
      must(after, `picking a part marked ${delta} left the odds at "${before}"`);
      await page.screenshot({ path: `play-${BROWSER}-odds.png` }).catch(() => {});
      return `odds ${before}, picked a part marked ${delta}, now ${after}`;
    },
  },
  // #309 (first-time items 10 and 23): the title menu shows on a first visit, "Just watch the sea"
  // brings the sea panel back (with "Sail this sea", #349), and every top-bar link opens its page with the bar.
  "title-nav": {
    path: "?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      if (!(await page.locator("#title").count())) throw new SkipCheck("this build has no title menu (#309 not deployed)");
      must(await page.locator("#title").isVisible(), "the title menu didn't show on a first visit");
      const menu = await page.evaluate(() => [...document.querySelectorAll("#title a, #title button")].filter((e) => e.offsetParent).map((e) => e.textContent.trim().split("\n")[0]));
      await page.screenshot({ path: `play-${BROWSER}-title.png` }).catch(() => {});
      // Since #437 "Just watch the sea" sits under More: open it first.
      if (!(await page.locator("#t-sea").isVisible()) && (await page.locator("#t-more > summary").count())) await page.click("#t-more > summary", { timeout: 10_000 }).catch(() => {});
      await page.click("#t-sea", { noWaitAfter: true, timeout: 10_000 }).catch(() => {
        throw new CheckFail(`couldn't click "Just watch the sea"`);
      });
      await page.waitForFunction(() => document.getElementById("title").hidden, null, { timeout: 10_000 }).catch(() => {
        throw new CheckFail(`"Just watch the sea" didn't close the menu`);
      });
      must(await page.locator("#panel").isVisible(), `"Just watch the sea" didn't bring the sea panel back`);
      const way = await page.locator("#sail").isVisible().catch(() => false);
      const links = await page.evaluate(() => [...document.querySelectorAll("#topbar a.nav")].map((a) => ({ href: a.href, text: a.textContent.trim() })));
      must(links.length >= 5, `the top bar has ${links.length} links: ${JSON.stringify(links)}`);
      const bad = [];
      // Each link in its own tab: leaving this page mid-load would abort its textures (console noise, not a fault).
      for (const l of links) {
        const tab = await page.context().newPage();
        const r = await tab.goto(l.href, { waitUntil: "load", timeout: 2 * MIN }).catch((e) => ({ status: () => String(e).split("\n")[0] }));
        const st = r?.status?.() ?? "no response";
        const bar = await tab.locator("#topbar a.nav").count().catch(() => 0);
        await tab.close().catch(() => {});
        if (st !== 200 || bar < 5) bad.push(`${l.text} (${l.href}): HTTP ${st}, ${bar} bar links`);
      }
      must(!bad.length, `top bar links that don't open a page with the bar: ${bad.join("; ")}`);
      return `menu: ${menu.join(" / ")}; sea panel back${way ? ' with "Sail this sea"' : ""}; ${links.length} bar links all open (${links.map((l) => l.text).join(", ")})`;
    },
  },
  // Not a pass/fail check: run by name only (`play.mjs look`, or the playtest dispatch's
  // "checks" input). Screenshots of the live pages at 1280x720 and High quality for
  // the Creative Director, whose sandbox can't open github.io. The thread sandboxes
  // can't fetch run artifacts either, so each JPEG is also printed to the log in base64
  // between LOOK-BEGIN/LOOK-END lines, to be decoded back into files from the job log.
  look: {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      const go = async (path, ready, settle = 4000) => {
        await page.goto(SITE + path, { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(ready, null, { timeout: 3 * MIN }).catch(() => {});
        await page.waitForTimeout(settle);
      };
      // 1. Title screen over the sea.
      await go("", () => window.__sea3d && window.__sea3d.frames > 30, 6000);
      await shot("01-index-title");
      // 2. Helm start card; 3. after Set sail, at about day 2, paused.
      await go("helm.html", () => window.__helm && window.__helm.frames > 30, 5000);
      await shot("02-helm-start-card");
      await page.click("#go").catch(() => {});
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      await page.waitForFunction(() => (window.__helm.status?.day ?? 0) >= 2 || window.__helm.clock === 0, null, { timeout: 4 * MIN }).catch(() => {});
      if (!(await page.locator("#decide").isVisible().catch(() => false))) await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForTimeout(4000);
      await shot("03-helm-sailing-day2");
      // 4. Practice sailing.
      await go("helm.html?practice", () => window.__helm && window.__helm.frames > 30, 6000);
      await shot("04-practice-sailing");
      // 5. Watch a voyage, default view; 6-8. cinematic, three frames 10 s apart.
      await go("voyage.html", () => window.__replay && (window.__replay.frames ?? 0) > 30, 8000);
      await shot("05-voyage-default");
      await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
      for (const n of ["06", "07", "08"]) {
        await page.waitForTimeout(n === "06" ? 4000 : 10_000);
        await shot(`${n}-voyage-cinematic`);
      }
      // 9. Boatyard, 10. race, 11. leaderboard.
      await go("boatyard.html", () => window.__yard?.ready && window.__yard.frames > 30, 5000);
      await shot("09-boatyard");
      await go("race.html", () => document.readyState === "complete", 5000);
      await shot("10-race");
      await go("leaderboard.html", () => window.__leaderboard?.ready, 3000);
      await shot("11-leaderboard");
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: the helm at night (#373), 1 Apr 2020 kayak, paused near 1 AM local on 2 Apr
  // (about day 0.75) and at day 1.5, each with the panels and in cinematic mode. Printed to the log like "look".
  "look-night": {
    manual: true,
    path: "helm.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await page.evaluate(() => { const d = document.getElementById("more"); if (d) d.open = true; });
      const day = page.locator("#launch");
      if (await day.count()) await day.selectOption("0").catch(() => {});
      await page.click("#go");
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      for (const target of [0.75, 1.5]) {
        await page.evaluate(() => { if (window.__helm.clock === 0) document.querySelector('#timebar .rate[data-rate="6"]')?.click(); });
        await page.evaluate(() => document.querySelector("#decidebtns button")?.click());
        await page.waitForFunction((t) => (window.__helm.hour ?? 0) / 24 >= t || window.__helm.clock === 0, target, { timeout: 4 * MIN }).catch(() => {});
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.waitForTimeout(5000);
        const when = await page.evaluate(() => `${document.getElementById("clock")?.textContent} ${document.getElementById("local")?.textContent}`.replace(/[^\w.:+-]+/g, "_"));
        await shot(`night-${target}-panels-${when}`.slice(0, 80));
        await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
        await page.waitForTimeout(6000);
        await shot(`night-${target}-cinematic`);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(1500);
      }
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: Elena's #376 set at 1280x720 and 1920x1080: Practice by day, the default helm screen
  // (sailing, drawer shut) and the orders drawer open. Printed to the log like "look".
  "look-376": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      for (const [w, h] of [[1280, 720], [1920, 1080]]) {
        await page.setViewportSize({ width: w, height: h });
        await page.goto(SITE + "helm.html?practice", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await page.evaluate(() => document.querySelector("#ss-course-opts .ss-pill")?.click()); // the triangle, on the Set sail card
        await page.click("#go", { timeout: 30_000 }).catch(() => {});
        await page.waitForFunction(() => window.__wheel?.on, null, { timeout: MIN }).catch(() => {});
        await page.waitForTimeout(8000);
        await shot(`${w}-practice-day`);
        await page.goto(SITE + "helm.html", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await page.click("#go").catch(() => {});
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
        // The clock runs by itself after Set sail (#339); pause it so the frame is the first screen
        // the player sees (morning on 23 Apr), not however far it ran on software graphics (Rosa).
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.click("#soundno", { timeout: 3000 }).catch(() => {});
        // The drawer opens by itself for 10 s at the start; the default screen is after it shuts.
        await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await shot(`${w}-helm-default`);
        await page.click("#orders-tab", { timeout: 15_000 }).catch(() => {});
        await page.waitForFunction(() => { const o = document.getElementById("orders"); return o?.classList.contains("open") && o.getBoundingClientRect().x >= 0; }, null, { timeout: 20_000 }).catch(() => {});
        await page.hover("#orders h2", { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1500);
        await shot(`${w}-helm-orders-open`);
      }
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // Manual: #381, Take the wheel in Practice (triangle) on both tacks: the boat should lean away
  // from the wind and the sail sit on the side away from it. Frames printed to the log; the
  // wheel panel's wind line says which side the wind is on.
  "look-heel": {
    manual: true,
    path: "helm.html?practice",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      // The wheel panel's wind line: "upwind, left" etc. (wheelSession.ts); older builds said "on the port side".
      const SIDE = /(?:upwind|reach|behind), (left|right)|off the bow on the (port|starboard)/;
      const wind = () => page.evaluate((src) => (document.body.innerText.match(new RegExp(src)) || [""])[0], SIDE.source);
      const left = (w) => /left|port/.test(w);
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await practiceTriangle(page);
      // Skip every lesson step (step 2 puts the sail out of trim on purpose), and let the
      // auto-trim keep the sail drawing so she sails through the turn instead of stalling head to wind.
      for (let i = 0; i < 4; i++) await page.click(".w-gskip", { timeout: 2000 }).catch(() => {});
      if (/\(off\)/.test(await page.evaluate(() => document.body.innerText.match(/auto-trim \((on|off)\)/i)?.[0] ?? ""))) await page.keyboard.press("t");
      await page.waitForTimeout(6000);
      const a = await wind();
      await shot("heel-tack-a");
      must(SIDE.test(a), `couldn't read which side the wind is on ("${a}")`);
      // Tack: turn toward the wind (left when it's on the left) until it comes over to the other side (up to 25 s).
      // On a runner's software graphics the boat's clock runs far slower than ours (a tack is ~12 s
      // of boat time), so turn at 10x until the wheel counts a tack and the wind line reads the other side, then back to 1x.
      const key = left(a) ? "ArrowLeft" : "ArrowRight";
      const tacks0 = await page.evaluate(() => window.__wheel?.wheel?.s?.tacks ?? 0);
      await page.click('.w-rate button[data-x="10"], button[data-x="10"]', { timeout: 5000 }).catch(() => page.keyboard.press("4"));
      await page.keyboard.down(key);
      await page.waitForFunction(([src, wasLeft, t0]) => {
        // Past the tack itself, keep turning until she's sailing on the new side (out of "too close").
        if ((window.__wheel?.wheel?.s?.tacks ?? 0) <= t0) return false;
        const m = document.body.innerText.match(new RegExp(src));
        return m && /left|port/.test(m[0]) !== wasLeft;
      }, [SIDE.source, left(a), tacks0], { timeout: 90_000 }).catch(() => {});
      await page.waitForTimeout(800);
      await page.keyboard.up(key);
      await page.waitForTimeout(4000);
      await page.click('button[data-x="1"]', { timeout: 5000 }).catch(() => page.keyboard.press("1"));
      await page.waitForTimeout(4000);
      const b = await wind();
      const tacks = (await page.evaluate(() => window.__wheel?.wheel?.s?.tacks ?? 0)) - tacks0;
      await shot("heel-tack-b");
      // A look check: the frames are what Elena judges. A missed tack is reported, not a failure,
      // since on software graphics it can be the runner's speed rather than the game.
      const tacked = SIDE.test(b) && left(a) !== left(b);
      return `tack A: "${a}"; tack B: "${b}"; ${tacked ? `tacked (${tacks} by the wheel's count)` : `NOT on the other tack (wheel counted ${tacks})`}; ${shots.join(", ")}`;
    },
  },
  // Manual: #379, close frames of the kayak's bow (no "V4") in the Boatyard (zoomed in, from
  // a few sides) and in the voyage replay's cinematic view. Printed to the log like "look".
  "look-bow": {
    manual: true,
    path: "boatyard.html",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__yard?.ready && window.__yard.frames > 30, null, { timeout: 3 * MIN });
      await page.waitForTimeout(3000);
      const c = await page.locator("canvas").first().boundingBox();
      const cx = c.x + c.width / 2, cy = c.y + c.height / 2;
      await page.mouse.move(cx, cy);
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(150); }
      await page.waitForTimeout(1500);
      await shot("bow-yard-1");
      for (const [n, dx] of [["2", 220], ["3", -440]]) {
        await page.mouse.move(cx, cy); await page.mouse.down(); await page.mouse.move(cx + dx, cy, { steps: 12 }); await page.mouse.up();
        await page.waitForTimeout(1500);
        await shot(`bow-yard-${n}`);
      }
      await page.goto(SITE + "voyage.html", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.frames ?? 0) > 30, null, { timeout: 3 * MIN }).catch(() => {});
      await page.click("#cinebtn", { noWaitAfter: true, timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await shot("bow-voyage-cinematic");
      return `${shots.length} looks: ${shots.join(", ")}`;
    },
  },
  // #385 (Felix): sound waits for a click, "No thanks" is remembered, N and the speaker button
  // agree, cinematic with sound on is clean, and a remembered "on" returns at the first click,
  // never on load. Nobody can hear on a runner: this checks state and errors, not the sound.
  "sound-helm": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.addInitScript(soundSpy);
      await calmReload(page);
      const out = [];
      const loaded = async () => {
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.waitForTimeout(3000);
      };
      const sailed = () => page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      const watchAsk = () => page.evaluate(() => {
        window.__askedSound = false;
        const a = document.getElementById("soundask");
        if (a) new MutationObserver(() => { if (!a.hidden) window.__askedSound = true; }).observe(a, { attributes: true });
      });
      // 1. First visit: nothing on load; "Set sail" asks once; "No thanks" is remembered.
      await loaded();
      let s = await soundState(page);
      must(s.contexts === 0, `an AudioContext existed on load, before any click (${s.contexts})`);
      must(!s.pressed, `the speaker button says on before any click`);
      await watchAsk();
      await page.click("#go", { timeout: 15_000 });
      await sailed();
      s = await soundState(page);
      must(s.contexts === 0, `clicking "Set sail" started sound without being asked (${s.contexts} AudioContext)`);
      const asked = await page.evaluate(() => !document.getElementById("soundask").hidden || window.__askedSound);
      must(asked, `"Sound on?" was never asked after Set sail`);
      const clicked = await page.click("#soundno", { noWaitAfter: true, timeout: 5_000 }).then(() => true, () => false);
      await page.waitForFunction(() => document.getElementById("soundask").hidden, null, { timeout: 25_000 });
      s = await soundState(page);
      if (clicked) must(s.stored === "off", `"No thanks" wasn't remembered (stored ${JSON.stringify(s.stored)})`);
      out.push(`load: no AudioContext, button off; "Sound on?" asked after Set sail, ${clicked ? '"No thanks" stored "off"' : "closed by itself"}`);
      // 2. Second visit after "No thanks": no question.
      await calmReload(page);
      await loaded();
      await watchAsk();
      await page.click("#go", { timeout: 15_000 });
      await sailed();
      await page.waitForTimeout(2000);
      const again = await page.evaluate(() => !document.getElementById("soundask").hidden || window.__askedSound);
      if (clicked) must(!again, `"Sound on?" was asked again after "No thanks"`);
      s = await soundState(page);
      must(s.contexts === 0, `sound started after "No thanks" without N or the button (${s.contexts} AudioContext)`);
      out.push(`reload after "No thanks": not asked again, still silent`);
      // 3. N while sailing: on, then off; the speaker button follows.
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.contexts === 1, `N didn't turn sound on: button pressed ${s.pressed}, ${s.contexts} AudioContext`);
      const on1 = `${s.icon} ${s.state}`;
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(!s.pressed && s.stored === "off", `N didn't turn sound off: button pressed ${s.pressed}, stored ${s.stored}`);
      const off1 = s.icon;
      await page.click("#soundbtn", { noWaitAfter: true, timeout: 10_000 });
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.stored === "on" && s.contexts === 1, `the speaker button didn't turn sound on: pressed ${s.pressed}, stored ${s.stored}, ${s.contexts} AudioContext`);
      out.push(`N on (${on1}), N off (${off1}), button on again; one AudioContext`);
      // 4. Cinematic with sound on (paused, so the clock check in cinematic() holds).
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForFunction(() => window.__helm.clock === 0 && !window.__helm.busy, null, { timeout: 2 * MIN }).catch(() => {});
      out.push(await cinematic(page, () => window.__helm.frames));
      // 5. Second visit after "on": silent on load, back at the first click, no question.
      await calmReload(page);
      await loaded();
      s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `a remembered "on" started sound on load (${s.contexts} AudioContext, button ${s.pressed})`);
      await watchAsk();
      await page.click("#go", { timeout: 15_000 });
      await page.waitForTimeout(1000);
      s = await soundState(page);
      must(s.contexts === 1 && s.pressed, `a remembered "on" didn't come back at the first click (${s.contexts} AudioContext, button ${s.pressed})`);
      await sailed();
      await page.waitForTimeout(2000);
      must(!(await page.evaluate(() => !document.getElementById("soundask").hidden || window.__askedSound)), `"Sound on?" was asked although sound was on`);
      out.push(`reload after "on": silent on load, on at the first click (${s.state}), not asked`);
      return out.join("; ");
    },
  },
  "sound-voyage": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15&quality=low",
    run: async (page) => {
      await page.addInitScript(soundSpy);
      await calmReload(page);
      const out = [];
      const loaded = async () => {
        await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
        must(!(await page.evaluate(() => window.__replay.error)), "the replay didn't load");
        await page.waitForTimeout(3000);
      };
      await loaded();
      let s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `sound before any click: ${s.contexts} AudioContext, button ${s.pressed}`);
      // A click on the sea is not "sound on".
      await page.mouse.click(700, 450);
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.contexts === 0, `a click on the sea started sound (${s.contexts} AudioContext)`);
      out.push("load and a click on the sea: no AudioContext, button off");
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.contexts === 1, `N didn't turn sound on: button pressed ${s.pressed}, ${s.contexts} AudioContext`);
      const on1 = `"${s.text}" ${s.state}`;
      await page.keyboard.press("n");
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(!s.pressed && s.stored === "off", `N didn't turn sound off: button pressed ${s.pressed}, stored ${s.stored}`);
      const off1 = `"${s.text}"`;
      await page.click("#soundbtn", { noWaitAfter: true, timeout: 10_000 });
      await page.waitForTimeout(800);
      s = await soundState(page);
      must(s.pressed && s.stored === "on", `the Sound button didn't turn sound on: pressed ${s.pressed}, stored ${s.stored}`);
      out.push(`N on (${on1}), N off (${off1}), button on again`);
      out.push(await cinematic(page, () => window.__replay.frames));
      await calmReload(page);
      await loaded();
      s = await soundState(page);
      must(s.contexts === 0 && !s.pressed, `a remembered "on" started sound on load (${s.contexts} AudioContext, button ${s.pressed})`);
      await page.mouse.click(700, 450);
      await page.waitForTimeout(1000);
      s = await soundState(page);
      must(s.contexts === 1 && s.pressed, `a remembered "on" didn't come back at the first click (${s.contexts} AudioContext, button ${s.pressed})`);
      out.push(`reload after "on": silent on load, on at the first click (${s.state})`);
      return out.join("; ");
    },
  },
  // Manual: #384 (Sam), the practice marks float: they ride the sea under them (height and tilt
  // change, a beat behind the water), sit at their draft rather than above or under it, and
  // don't blink in and out. Both browsers measure; Chromium also prints frames: the course
  // as the player sees it, then the first mark moved (by the test, in this tab only) to about
  // 35 m off the boat so its waterline can be judged up close.
  // Manual: #397 (Felix), story moments by state, not by ear: window.__sound.played logs one
  // {name, t} per moment. Nothing logs while sound is off; turning it on says hello once; a voyage
  // sailed to its end at 4 days a second logs each breakdown once, the horn at a finish and the
  // result card's settle once. Watch a voyage plays only the sea: no moments there.
  "sound-moments": {
    manual: true,
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => Array.isArray(window.__sound?.played)))) throw new SkipCheck("this build has no sound log (Felix's played-log patch not deployed)");
      const played = () => page.evaluate(() => window.__sound.played.map((p) => ({ ...p })));
      const out = [];
      await page.click("#go", { timeout: 15_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.waitForTimeout(2000);
      must((await played()).length === 0, `moments logged with sound off: ${JSON.stringify(await played())}`);
      // Sound on from the question (or N if it has gone).
      if (await page.locator("#soundyes").isVisible().catch(() => false)) await page.click("#soundyes", { noWaitAfter: true });
      else await page.keyboard.press("n");
      await page.waitForTimeout(1500);
      let p = await played();
      must(p.filter((x) => x.name === "hello").length === 1, `turning sound on should say hello once: ${JSON.stringify(p)}`);
      out.push("silent with sound off; hello once on turning it on");
      // Sail to the end at 4 days a second, taking the first choice at every decision.
      for (let i = 0; i < 40; i++) {
        if (await page.evaluate(() => window.__helm.status?.over)) break;
        if (await page.evaluate(() => !document.getElementById("decide").hidden && document.querySelectorAll("#decidebtns button").length)) {
          await page.locator("#decidebtns button").first().click({ noWaitAfter: true, timeout: 10_000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        if (await page.evaluate(() => window.__helm.clock === 0 && !window.__helm.status?.over)) await page.keyboard.press("4");
        await page.waitForFunction(() => window.__helm.clock === 0 || window.__helm.status?.over || window.__helm.error, null, { timeout: 4 * MIN }).catch(() => {});
        must(!(await page.evaluate(() => window.__helm.error)), "sailing failed");
      }
      const st = await page.evaluate(() => ({ over: window.__helm.status?.over, day: window.__helm.status?.day, outcome: window.__helm.status?.outcome ?? window.__helm.lastStop }));
      await page.waitForTimeout(8000); // the result card and its settle
      p = await played();
      const names = p.map((x) => x.name);
      const count = (n) => names.filter((x) => x === n || x.startsWith(n + ":")).length;
      const KNOWN = /^(hello|crash|horn|settle|flog|alarm|bell:[123]|breakdown:[a-z_]+)$/;
      const odd = names.filter((n) => !KNOWN.test(n));
      must(!odd.length, `unknown moments: ${odd.join(", ")}`);
      // "Once per event": the same moment twice within a second is a double fire.
      // t is the sound clock: in Firefox on the runner it never starts (no audio device), so every t is
      // the same and nothing can be told apart; at 4 days a second two real knockdowns can land within a
      // second of each other, so only a repeat within a quarter second counts.
      const frozen = p.length > 1 && p.every((x) => x.t === p[0].t);
      const doubles = frozen ? [] : p.filter((x, i) => i && p[i - 1].name === x.name && Math.abs(x.t - p[i - 1].t) < 0.25);
      if (frozen) out.push("sound clock frozen (no audio device): double-fire test not possible");
      must(!doubles.length, `fired twice for one event: ${doubles.map((d) => d.name).join(", ")}`);
      must(count("hello") === 1, `hello ${count("hello")} times`);
      if (st.over) must(count("settle") === 1, `the end of the voyage should settle once, got ${count("settle")}`);
      if (/arrived|finish/.test(String(st.outcome))) must(count("horn") === 1, `a finish should sound the horn once, got ${count("horn")}`);
      out.push(`voyage ${st.over ? "ended" : "not ended"} at day ${st.day?.toFixed?.(1)} (${st.outcome}); moments: ${names.join(", ") || "none"}`);
      // Watch a voyage: the sound object, no moments.
      await page.goto(SITE + "voyage.html?voyage=2020-04-15&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN });
      await page.keyboard.press("n");
      await page.waitForTimeout(5000);
      const vp = await page.evaluate(() => (window.__sound?.played ?? null));
      must(vp !== null, "Watch a voyage has no window.__sound");
      must(vp.every((x) => x.name === "hello"), `Watch a voyage logged story moments: ${JSON.stringify(vp)}`);
      out.push(`Watch a voyage: ${vp.length ? vp.map((x) => x.name).join(", ") : "no moments"}`);
      return out.join("; ");
    },
  },
  // Manual: #400 (Marco), ships at sea live. ?ship=container puts one under way 900 m off the
  // starboard bow, crossing ahead; window.__traffic.ships() says where. Checks she's there, under
  // way (speed > 0, so the bow wave shows), runs without errors, and prints frames as she crosses.
  "look-ships": {
    manual: true,
    path: "helm.html?ship=container",
    run: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        if (BROWSER !== "chromium") return;
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.evaluate(() => typeof window.__traffic?.ships === "function"))) throw new SkipCheck("this build has no traffic hook (Marco's traffic patch not deployed)");
      await page.click("#go", { timeout: 15_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      await page.click("#soundno", { timeout: 3000 }).catch(() => {});
      // Paused: traffic moves in boat time, and any fast-forward carries her off (Marco). The frame
      // shows her where she was put, 900 m off the starboard bow.
      await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
      await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
      const ships = () => page.evaluate(() => window.__traffic.ships().map((s) => ({ kind: s.kind, d: Math.round(s.distance ?? Math.hypot(s.x, s.z)), b: Math.round(s.bearing ?? 0), sp: s.speed, anch: s.anchored })));
      const s0 = await ships();
      const ours = s0.filter((s) => /container/.test(s.kind));
      must(ours.length, `?ship=container didn't put a container ship near us: ${JSON.stringify(s0)}`);
      must(ours.some((s) => !s.anch && s.sp > 0), `the container ship isn't under way (speed ${ours.map((s) => s.sp).join(", ")}), so there's no bow wave`);
      await page.waitForTimeout(4000);
      await shot("ships-container");
      const c0 = ours[0];
      // Close: the same ship started 200 m off (&near=, Marco).
      if (BROWSER === "chromium") {
        await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
        await page.goto(SITE + "helm.html?ship=container&near=200", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
        await page.click("#go", { timeout: 15_000 });
        await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
        await page.click("#soundno", { timeout: 3000 }).catch(() => {});
        await page.evaluate(() => { if (window.__helm.clock > 0) document.getElementById("t-pause")?.click(); });
        await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
        await page.waitForTimeout(4000);
        await shot("ships-container-200m");
      }
      return `container ship at ${c0.d} m on bearing ${c0.b}°, speed ${c0.sp}; ${s0.length} ships in all${shots.length ? `; frames ${shots.join(", ")}` : ""}`;
    },
  },
  // Manual: the opening of Elena's 60 s film for John (title, the helm's start, the first sailing),
  // frame by frame so it's smooth on a runner without a graphics card: the page's clock is held
  // and stepped 1/30 s per frame (Ada's proof clock, tools/proof/capture.mjs), captured over CDP
  // (page.screenshot hangs while the clock is held), and joined into an MP4 with ffmpeg. The MP4
  // prints to the log like the look frames. Ada renders the sea shots; the cut is joined after.
  "film-opening": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("filmed in Chromium only");
      const { execSync } = await import("node:child_process");
      const { mkdirSync, writeFileSync } = await import("node:fs");
      try { execSync("ffmpeg -version", { stdio: "ignore" }); } catch { execSync("sudo apt-get install -y -qq ffmpeg", { stdio: "ignore", timeout: 5 * MIN }); }
      const FPS = 30;
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.addInitScript(FILM_CLOCK);
      const cdp = await page.context().newCDPSession(page);
      mkdirSync("film", { recursive: true });
      let n = 0;
      const frame = async () => {
        await page.evaluate((ms) => window.__proofClock.step(ms), 1000 / FPS);
        const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 92 });
        writeFileSync(`film/${String(n++).padStart(5, "0")}.jpg`, Buffer.from(r.data, "base64"));
      };
      const film = async (secs) => {
        await page.evaluate(() => window.__proofClock.hold());
        await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 10 }); // the first one can be blank
        for (let i = 0; i < secs * FPS; i++) await frame();
        await page.evaluate(() => window.__proofClock.release());
      };
      const out = [];
      // High quality throughout, to match Ada's sea shots (Low keeps faint bands on the sea).
      // 1. The title (4 s).
      await page.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 5, null, { timeout: 2 * MIN });
      await page.waitForTimeout(3000);
      await film(4);
      out.push(`title ${n} frames`);
      // 2. The helm's start card (3 s), then Set sail on the real clock.
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});
      await page.goto(SITE + "helm.html?quality=high", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      await page.waitForTimeout(3000);
      const n1 = n;
      await film(3);
      out.push(`start card ${n - n1}`);
      await page.click("#go", { timeout: 30_000 });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN });
      must(!(await page.evaluate(() => window.__helm.error)), "Set sail failed");
      await page.click("#soundno", { timeout: 5000 }).catch(() => {});
      await page.waitForFunction(() => !document.querySelector("#orders.open"), null, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(2000);
      // 3. Sailing at the helm (13 s), the clock running by itself as a new player sees it.
      const n2 = n;
      await film(13);
      out.push(`sailing ${n - n2}`);
      execSync(`ffmpeg -y -loglevel error -framerate ${FPS} -i film/%05d.jpg -c:v libx264 -pix_fmt yuv420p -crf 24 -movflags +faststart film-opening.mp4`);
      const b64 = readFileSync("film-opening.mp4").toString("base64");
      console.log("LOOK-BEGIN film-opening.mp4");
      for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
      console.log("LOOK-END film-opening.mp4");
      return `${out.join(", ")} frames at ${FPS} fps: film-opening.mp4, ${(b64.length * 0.75 / 1e6).toFixed(1)} MB`;
    },
  },
  // Manual: the new sea up close (Maya, 12 Nov): at forces 5, 6 and 8 on High, in daylight, is the
  // wake a bright veined web ("cracked glass"), and are there flat pale foam slabs with hard edges
  // in the near water? Frames from the replay's proof hooks (force.wind/hs/sea/cloud, cam, setHour).
  "look-sea": {
    manual: true,
    path: "voyage.html?voyage=2020-04-15&quality=high",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      await page.setViewportSize({ width: 1280, height: 720 });
      const shots = [];
      const shot = async (name) => {
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 3 * MIN });
      if (!(await page.evaluate(() => "cam" in window.__replay && Array.isArray(window.__replay.force?.sea)))) throw new SkipCheck("this build has no proof hooks (force.sea, cam)");
      // Midday on day 2: the sun high, so foam and wake read in plain light.
      await page.evaluate(() => {
        const r = window.__replay;
        r.pause();
        let best = 30, el = -90;
        for (let h = 24; h < 48; h += 0.25) { const e = r.sunAt?.(h) ?? -90; if (e > el) [best, el] = [h, e]; }
        r.setHour(best);
      });
      const SEAS = { f5: [9.8, 2.5, 6.3, 0.45], f6: [12.9, 4.0, 8.0, 0.6], f8: [19.0, 6.0, 9.8, 0.9] };
      const VIEWS = { chase: { az: 180, dist: 9, h: 2.2, fov: 45, look: 0.3 }, over: { az: 180, dist: 2, h: 18, fov: 45 }, low: { az: 150, dist: 7, h: 0.4, fov: 35, look: 0.3 } };
      for (const [sea, [wind, hs, tp, cloud]] of Object.entries(SEAS)) {
        await page.evaluate(([wind, hs, tp, cloud]) => {
          const f = window.__replay.force;
          f.wind = wind; f.cloud = cloud; f.fog = 0; f.sea = [hs, tp, -1];
          window.__replay.setHour(window.__replay.hour); // re-seek so the forced sea is built now
        }, [wind, hs, tp, cloud]);
        await page.waitForTimeout(6000);
        for (const [view, cam] of Object.entries(VIEWS)) {
          await page.evaluate((cam) => { window.__replay.cam = cam; }, cam);
          await page.waitForTimeout(3000);
          await shot(`sea-${sea}-${view}`);
        }
      }
      return `${shots.length} frames: ${shots.join(", ")}`;
    },
  },
  // #442 (M1 piece 6): the title hero, your own boat at golden hour behind the menu (desktop) or
  // above it (phone). Elena: look at the hull's top edge at a pixel ratio of 2 or more.
  "look-title": {
    manual: true,
    path: "",
    run: async (page) => {
      if (BROWSER !== "chromium") throw new SkipCheck("looks are taken in Chromium only");
      const browser = page.context().browser();
      const shots = [];
      const out = [];
      const SIZES = [
        { name: "1920-dpr2", viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 },
        { name: "1280-dpr2", viewport: { width: 1280, height: 720 }, deviceScaleFactor: 2 },
        { name: "phone-390-dpr3", viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
      ];
      for (const s of SIZES) {
        const { name, ...opts } = s;
        const ctx = await browser.newContext({ ...opts, serviceWorkers: "block" });
        const p = await ctx.newPage();
        const errs = [];
        p.on("pageerror", (e) => errs.push(e.message));
        await p.goto(SITE + "?quality=high", { waitUntil: "load", timeout: 2 * MIN });
        await p.waitForFunction(() => window.__sea3d && window.__sea3d.frames > 30, null, { timeout: 3 * MIN }).catch(() => {});
        await p.waitForTimeout(8000);
        const info = await p.evaluate(() => ({
          title: !document.getElementById("title")?.hidden,
          heroClass: document.body.classList.contains("title"),
          menu: (() => { const r = document.querySelector("#title nav")?.getBoundingClientRect(); return r ? [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] : null; })(),
        }));
        const path = `look-title-${name}.jpg`;
        if (await jpeg(p, path)) {
          const b64 = readFileSync(path).toString("base64");
          console.log(`LOOK-BEGIN ${path}`);
          for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
          console.log(`LOOK-END ${path}`);
          shots.push(name);
        }
        out.push(`${name}: menu ${info.title ? "shown" : "NOT shown"} at ${JSON.stringify(info.menu)}${errs.length ? `, page errors: ${errs.slice(0, 2).join(" | ")}` : ""}`);
        await ctx.close().catch(() => {});
      }
      return `${out.join("; ")}; frames ${shots.join(", ")}`;
    },
  },
  // #443 (M1 piece 5): the Set sail card is the one place to pick. Pick a day…, a challenge,
  // More options (steering, breakdowns, battery as pills), then set sail; practice from the card too.
  "setsail-card": {
    path: "helm.html?quality=low",
    run: async (page) => {
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (!(await page.locator("#ss-when-opts").count())) throw new SkipCheck("this build has no Set sail card");
      await page.waitForFunction(() => document.querySelectorAll("#ss-when-opts .ss-pill").length >= 3, null, { timeout: MIN }).catch(() => {
        throw new CheckFail("the card's launch day pills didn't show");
      });
      const out = [];
      const pillTexts = (box) => page.evaluate((b) => [...document.querySelectorAll(`${b} .ss-pill`)].map((e) => ({ t: e.textContent.trim(), on: e.getAttribute("aria-pressed") === "true", vis: e.offsetParent !== null })), box);
      // The old start lists must not show anywhere.
      const old = await page.evaluate(() => ["#launch", "#challenge", "#modes", "#breakdowns", "#safe"].filter((s) => { const e = document.querySelector(s); return e && e.offsetParent !== null; }));
      must(!old.length, `the old pickers still show: ${old.join(", ")}`);
      // Pick a day…
      let days = await pillTexts("#ss-when-opts");
      const pick = days.findIndex((d) => /Pick a day/.test(d.t));
      must(pick >= 0, `no "Pick a day…" pill: ${days.map((d) => d.t).join(" / ")}`);
      await page.locator("#ss-when-opts .ss-pill").nth(pick).click({ timeout: 15_000 });
      days = await pillTexts("#ss-when-opts");
      must(days.length >= 5, `"Pick a day…" didn't open the other days: ${days.map((d) => d.t).join(" / ")}`);
      const dayIdx = days.findIndex((d) => /May/.test(d.t)) >= 0 ? days.findIndex((d) => /May/.test(d.t)) : days.length - 1;
      await page.locator("#ss-when-opts .ss-pill").nth(dayIdx).click({ timeout: 15_000 });
      const launch = await page.evaluate(() => document.getElementById("launch").value);
      days = await pillTexts("#ss-when-opts");
      must(days[dayIdx]?.on, `the picked day "${days[dayIdx]?.t}" isn't shown as picked`);
      out.push(`days ${days.map((d) => d.t).join(" / ")}; picked "${days[dayIdx].t}" (launch=${launch})`);
      // A challenge.
      const chShown = await page.evaluate(() => !document.getElementById("ss-ch").hidden);
      let chName = "";
      if (chShown) {
        const ch = await pillTexts("#ss-ch-opts");
        const i = ch.findIndex((c) => c.t !== "None" && !/More/.test(c.t));
        must(i > 0, `no challenge pills: ${ch.map((c) => c.t).join(" / ")}`);
        await page.locator("#ss-ch-opts .ss-pill").nth(i).click({ timeout: 15_000 });
        const after = await page.evaluate(() => ({ v: document.getElementById("challenge").value, why: document.getElementById("ss-why").textContent.trim(), whyShown: !document.getElementById("ss-why").hidden }));
        must(after.v, `picking "${ch[i].t}" didn't set a challenge`);
        must(after.whyShown && after.why, `picking "${ch[i].t}" showed no line saying why`);
        chName = after.v;
        out.push(`challenge "${ch[i].t}" (${after.v}): "${after.why.slice(0, 90)}"`);
        // More… shows the rest.
        const more = (await pillTexts("#ss-ch-opts")).findIndex((c) => /More/.test(c.t));
        if (more >= 0) {
          await page.locator("#ss-ch-opts .ss-pill").nth(more).click({ timeout: 15_000 });
          out.push(`More… opened ${(await pillTexts("#ss-ch-opts")).length} challenge pills`);
        }
      } else out.push("no challenge row (challenges not loaded)");
      // More options: steering, breakdowns, battery.
      await page.click("#more > summary", { timeout: 15_000 });
      const steer = await pillTexts("#ss-mode-opts");
      const toggles = await pillTexts("#ss-toggles");
      must(steer.length === 2 && steer.every((s) => s.vis), `How you steer should be two pills: ${JSON.stringify(steer)}`);
      must(toggles.length === 2 && toggles.every((s) => s.vis), `Breakdowns and Save the battery should be two pills: ${JSON.stringify(toggles)}`);
      await page.locator("#ss-mode-opts .ss-pill").nth(1).click({ timeout: 15_000 });
      const sat = await page.evaluate(() => ({ mode: document.querySelector('input[name="mode"]:checked')?.value, safe: document.getElementById("safe").checked, line: document.getElementById("ss-mode-line").textContent.trim() }));
      must(sat.mode === "base", `the second steering pill didn't pick satellite steering (${sat.mode})`);
      await page.locator("#ss-mode-opts .ss-pill").nth(0).click({ timeout: 15_000 });
      const bd0 = await page.evaluate(() => document.getElementById("breakdowns").checked);
      await page.locator("#ss-toggles .ss-pill").nth(0).click({ timeout: 15_000 });
      const bd1 = await page.evaluate(() => document.getElementById("breakdowns").checked);
      must(bd0 !== bd1, "the Breakdowns pill didn't switch breakdowns");
      await page.locator("#ss-toggles .ss-pill").nth(0).click({ timeout: 15_000 });
      out.push(`steer ${steer.map((s) => s.t).join(" / ")} (satellite turned Save the battery ${sat.safe ? "on" : "off"}); toggles ${(await pillTexts("#ss-toggles")).map((s) => s.t).join(" / ")}`);
      // Is Set sail still in view with More options open?
      const goSeen = await page.evaluate(() => { const r = document.getElementById("go").getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; });
      out.push(`Set sail ${goSeen ? "in view" : "OFF SCREEN"} with More options open`);
      await page.screenshot({ path: `play-${BROWSER}-setsail-card.png` }).catch(() => {});
      // Set sail on the crossing.
      await page.click("#go", { timeout: 30_000, noWaitAfter: true });
      await page.waitForFunction(() => (window.__helm.ready && !window.__helm.busy) || window.__helm.error, null, { timeout: 8 * MIN }).catch(() => {});
      const st = await page.evaluate(() => ({ err: window.__helm.error, ready: window.__helm.ready, ch: window.__helm.challenge, hidden: document.getElementById("start").hidden || getComputedStyle(document.getElementById("start")).display === "none" }));
      must(!st.err, `setting sail failed: ${st.err}`);
      must(st.ready, "the crossing didn't start within 8 min");
      must(st.hidden, "the Set sail card stayed up after Set sail");
      if (chName) must(st.ch === chName, `sailing challenge "${st.ch}", not the picked "${chName}"`);
      out.push(`crossing started${chName ? ` on challenge ${st.ch}` : ""}`);
      // Practice from the card.
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.goto(SITE + "helm.html?practice&quality=low", { waitUntil: "load", timeout: 2 * MIN });
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 2, null, { timeout: 2 * MIN });
      if (await page.locator("#ss-course-opts").count()) {
        await practiceTriangle(page);
        must(await page.evaluate(() => !!window.__wheel?.on), "Practice from the card didn't put me at the wheel");
        out.push("practice: triangle from the card, at the wheel");
      } else out.push("practice: no courses on the card");
      return out.join("; ");
    },
  },
  "look-marks": {
    manual: true,
    path: "helm.html?practice",
    run: async (page) => {
      await page.setViewportSize({ width: 1280, height: 720 });
      const look = BROWSER === "chromium";
      const shots = [];
      const shot = async (name) => {
        if (!look) return;
        const path = `look-${name}.jpg`;
        if (!(await jpeg(page, path))) return;
        const b64 = readFileSync(path).toString("base64");
        console.log(`LOOK-BEGIN ${path}`);
        for (let i = 0; i < b64.length; i += 4000) console.log(b64.slice(i, i + 4000));
        console.log(`LOOK-END ${path}`);
        shots.push(name);
      };
      await page.waitForFunction(() => window.__helm && window.__helm.frames > 30, null, { timeout: 3 * MIN });
      if (!(await page.evaluate(() => !!window.__buoys))) throw new SkipCheck("this build has no floating marks (#384 not deployed)");
      await practiceTriangle(page);
      await page.click(".w-gskip", { timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(5000);
      // Sample the marks for 12 s: height above the water's mean, tilt, and whether each is shown.
      const sample = () =>
        page.evaluate(async () => {
          const ms = window.__buoys.group.children;
          const rows = ms.map(() => ({ y: [], tilt: [], vis: [] }));
          for (let k = 0; k < 48; k++) {
            ms.forEach((m, i) => {
              rows[i].y.push(m.position.y);
              rows[i].tilt.push(Math.hypot(m.rotation.x, m.rotation.z) * 57.3);
              rows[i].vis.push(m.visible);
            });
            await new Promise((r) => setTimeout(r, 250));
          }
          return rows;
        });
      const rows = await sample();
      must(rows.length >= 2, `only ${rows.length} marks on the triangle`);
      const out = [];
      rows.forEach((r, i) => {
        const lo = Math.min(...r.y), hi = Math.max(...r.y);
        const flips = r.vis.slice(1).filter((v, k) => v !== r.vis[k]).length;
        must(flips === 0, `mark ${i + 1} blinked in and out (${flips} changes in 12 s)`);
        if (!r.vis[0]) return;
        // y is the body's bottom: about -0.35 m (its draft) plus the wave under it.
        must(lo > -4 && hi < 3.5, `mark ${i + 1} is off the water: its bottom went from ${lo.toFixed(2)} to ${hi.toFixed(2)} m`);
        must(hi - lo > 0.02, `mark ${i + 1} doesn't move with the sea (height range ${(hi - lo).toFixed(3)} m in 12 s)`);
        out.push(`mark ${i + 1}: bottom ${lo.toFixed(2)}..${hi.toFixed(2)} m, tilt ${Math.min(...r.tilt).toFixed(1)}-${Math.max(...r.tilt).toFixed(1)}°`);
      });
      must(out.length, "no mark was showing");
      await shot("marks-course");
      // Up close: move the first shown mark to about 35 m off the boat, somewhere in view.
      if (look) {
        const placed = await page.evaluate(async () => {
          const b = window.__buoys;
          const i = b.group.children.findIndex((m) => m.visible);
          const mk = b.marks[i];
          for (const deg of [0, 30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180]) {
            const p = b.group.children[i].position;
            const a = (deg * Math.PI) / 180;
            // Scene x east, z south; the chase camera looks along the boat, roughly toward the mark.
            const dir = Math.atan2(p.x, -p.z) + a;
            const want = { x: 35 * Math.sin(dir), z: -35 * Math.cos(dir) };
            mk.x += want.x - p.x;
            mk.y -= want.z - p.z;
            await new Promise((r) => setTimeout(r, 600));
            const tag = document.getElementById("markptr");
            if (tag && tag.dataset.edge === "") return deg;
          }
          return null;
        });
        await page.waitForTimeout(3000);
        await shot("marks-close");
        out.push(placed == null ? "couldn't put a mark in view up close" : `close frame with the mark ${placed}° off the line to it`);
      }
      // The Annapolis page the player reaches from Watch a voyage.
      if (look) {
        await page.goto(SITE + "voyage.html?place=annapolis", { waitUntil: "load", timeout: 2 * MIN });
        await page.waitForFunction(() => window.__replay && (window.__replay.ready || window.__replay.error), null, { timeout: 2 * MIN }).catch(() => {});
        await page.waitForTimeout(8000);
        await shot("marks-voyage-annapolis");
      }
      return `${out.join("; ")}${shots.length ? `; frames ${shots.join(", ")}` : ""}`;
    },
  },
  "my-boat": {
    path: "boatyard.html?quality=low",
    run: async (page) => {
      // 20 characters at most: the Boatyard caps a name at 20 so it fits on the stern (#414).
      const NAME = "<b>Nina</b> Rev C";
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
      must(helm.label.includes(NAME), `the helm's row doesn't show the name as typed: ${JSON.stringify(helm.label.trim())} (stored ${JSON.stringify(await page.evaluate(() => localStorage.getItem("boatsim.myboat.v1")?.slice(0, 160)))})`);
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

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(CHECKS).filter((n) => !CHECKS[n].manual);
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
