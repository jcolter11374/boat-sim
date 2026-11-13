#!/usr/bin/env node
// Merge the shards' manifests into one proof page (index.html) and a contact sheet
// (contact-sheet.png: every still and every clip's middle frame, labelled).
//   node tools/proof/sheet.mjs <proof dir> [--title "branch name"] [--commit sha]
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOTS = JSON.parse(readFileSync(join(HERE, "shots.json"), "utf8"));
const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : d);
const DIR = resolve(argv[0] ?? "proofs");
const TITLE = opt("title", "proofs");
const COMMIT = opt("commit", "");

const manifests = readdirSync(DIR).filter((f) => /^manifest-.*\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")));
if (!manifests.length) throw new Error(`no manifest-*.json in ${DIR}`);
const units = manifests.flatMap((m) => m.units).sort((a, b) => a.id.localeCompare(b.id));
const m0 = manifests[0];
const MODELS = m0.models ?? { commit: "", from: "unknown (made before model stamps)" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const label = (u) => `${SHOTS.boats[u.boat]?.label ?? u.boat} · ${SHOTS.seas[u.sea]?.label ?? u.sea} · ${SHOTS.times[u.time]?.label ?? u.time}`;
const failed = units.filter((u) => !u.files.length);
const notes = units.filter((u) => u.errors?.some((e) => !/^404 \/models\//.test(e)));

const cards = (u, thumbs) =>
  u.files
    .map((f) =>
      f.kind === "still"
        ? `<figure><a href="${esc(f.file)}"><img src="${esc(f.file)}" loading="lazy"></a><figcaption>${esc(SHOTS.views[f.view]?.label ?? f.view)}</figcaption></figure>`
        : thumbs
          ? `<figure><img src="${esc(f.poster)}"><figcaption>&#9654; ${esc(SHOTS.clips[f.clip]?.label ?? f.clip)}, ${f.seconds} s (middle frame)</figcaption></figure>`
          : `<figure><video src="${esc(f.file)}" poster="${esc(f.poster)}" controls loop muted playsinline preload="none"></video><figcaption>${esc(SHOTS.clips[f.clip]?.label ?? f.clip)}, ${f.seconds} s at ${f.fps} fps · <a href="${esc(f.file)}">mp4</a></figcaption></figure>`,
    )
    .join("");
const page = (thumbs) => `<!doctype html><meta charset="utf-8"><title>Proofs: ${esc(TITLE)}</title>
<style>
body { margin: 0; padding: 24px; background: #0d1117; color: #e6edf3; font: 14px system-ui, sans-serif; }
h1 { font-size: 22px; margin: 0 0 4px; } h2 { font-size: 15px; margin: 22px 0 8px; color: #9fb3c8; font-weight: 600; }
.meta { color: #8b949e; margin-bottom: 12px; } .warn { color: #f0b429; }
.row { display: grid; grid-template-columns: repeat(auto-fill, minmax(${thumbs ? 290 : 420}px, 1fr)); gap: 10px; }
figure { margin: 0; } img, video { width: 100%; display: block; border-radius: 4px; background: #000; aspect-ratio: 16 / 9; object-fit: cover; }
.stamp { position: absolute; top: 18px; right: 24px; text-align: right; font: 600 13px ui-monospace, monospace; color: #ffd166; background: #1c2128; border: 1px solid #ffd16655; border-radius: 6px; padding: 6px 10px; }
body { position: relative; }
figcaption { color: #9fb3c8; font-size: 12px; padding: 3px 0; } a { color: #79c0ff; }
</style>
<div class="stamp">boat models: ${esc(MODELS.commit || "?")} ${esc(MODELS.date ?? "")}<br><span style="font-weight:400">${esc(MODELS.from)}${MODELS.branch ? " · " + esc(MODELS.branch) : ""}</span>${COMMIT ? `<br><span style="font-weight:400">site: ${esc(COMMIT.slice(0, 7))}</span>` : ""}</div>
<h1>Proofs: ${esc(TITLE)}</h1>
<div class="meta">Set <b>${esc(m0.set)}</b> · ${esc(m0.size)} · ${esc(m0.quality)} quality on software graphics (SwiftShader) · ${units.reduce((n, u) => n + u.files.length, 0)} files${COMMIT ? ` · commit ${esc(COMMIT.slice(0, 7))}` : ""} · made by tools/proof</div>
${failed.length ? `<div class="warn">Failed: ${failed.map((u) => esc(u.id) + " (" + esc(u.errors[0] ?? "") + ")").join("; ")}</div>` : ""}
${!thumbs && notes.length ? `<div class="warn">The page reported: ${notes.map((u) => esc(u.id) + ": " + esc(u.errors.filter((e) => !/^404 \/models\//.test(e)).slice(0, 2).join(" | "))).join("; ")}</div>` : ""}
${units
  .filter((u) => u.files.length)
  .map((u) => `<h2>${esc(label(u))}${u.clip ? "" : ""}${Number.isFinite(u.sunEl) ? ` <span class="meta">(sun ${u.sunEl.toFixed(0)}°)</span>` : ""}</h2><div class="row">${cards(u, thumbs)}</div>`)
  .join("\n")}`;

writeFileSync(join(DIR, "index.html"), page(false));
writeFileSync(join(DIR, ".contact.html"), page(true));
console.log(`index.html: ${units.length} units, ${failed.length} failed`);

// The contact sheet as one PNG (needs playwright; skipped without it).
let pw = null;
for (const t of [join(HERE, "package.json"), join(HERE, "../../sea3d/package.json"), join(execSync("npm root -g", { encoding: "utf8" }).trim(), "x.json")]) {
  try {
    pw = createRequire(t)("playwright");
    break;
  } catch {
    /* next */
  }
}
if (pw && !argv.includes("--no-png")) {
  const b = await pw.chromium.launch();
  const p = await b.newPage({ viewport: { width: 2200, height: 900 } });
  await p.goto("file://" + join(DIR, ".contact.html"));
  await p.waitForLoadState("load");
  await p.screenshot({ path: join(DIR, "contact-sheet.png"), fullPage: true });
  await b.close();
  console.log("contact-sheet.png");
}
if (existsSync(join(DIR, ".contact.html"))) execSync(`rm -f "${join(DIR, ".contact.html")}"`);
if (failed.length) process.exitCode = 1;
