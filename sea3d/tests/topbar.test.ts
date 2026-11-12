import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { LINKS, boatChip, pageName } from "../src/topbar";
import { shouldShowTitle } from "../src/title";

// The shared top bar and title screen (one-game plan, step 2).

const ROOT = new URL("../", import.meta.url).pathname;
const pages = readdirSync(ROOT).filter((f) => f.endsWith(".html"));

test("every page loads the top bar and reserves room for it", () => {
  assert.ok(pages.length >= 6);
  for (const f of pages) {
    const html = readFileSync(ROOT + f, "utf8");
    assert.match(html, /src="\.\/src\/topbar\.ts"/, `${f} doesn't load the top bar`);
    assert.match(html, /--bar:\s*40px/, `${f} doesn't reserve the bar's height`);
    // A panel pinned at top: 12px would sit under the bar.
    assert.doesNotMatch(html, /position:\s*fixed;\s*top:\s*12px/, `${f} has a panel under the bar`);
  }
});

test("the menu has every page, and every link points at a real page", () => {
  const names = pages.map((f) => f.replace(".html", "")).sort();
  assert.deepEqual(LINKS.map((l) => l.page).sort(), names);
  for (const l of LINKS) assert.ok(l.href === "./" || pages.includes(l.href.slice(2)), l.href);
});

test("page names come from the file name", () => {
  assert.equal(pageName("/boat-sim/"), "index");
  assert.equal(pageName("/boat-sim/index.html"), "index");
  assert.equal(pageName("/boat-sim/helm.html"), "helm");
  assert.equal(pageName("/race.html"), "race");
});

test("the boat chip: Our kayak by default, build one only in the Boatyard, my boat named safely", () => {
  for (const page of ["index", "helm", "voyage", "race", "leaderboard"]) {
    const d = boatChip(null, page);
    assert.equal(d.prefix + d.name, "My boat: Our kayak", page);
    assert.equal(d.href, "./boatyard.html");
  }
  assert.equal(boatChip(null).name, "Our kayak");
  assert.equal(boatChip(null, "boatyard").name, "build one");
  assert.equal(boatChip(null, "boatyard").href, "./boatyard.html");
  const c = boatChip({ name: 'Rev C <b>"x"</b> & co', href: "./boatyard.html#base=revc" });
  assert.equal(c.href, "./boatyard.html#base=revc");
  // the name is passed through untouched; mountTopbar only ever sets it as textContent
  assert.equal(c.name, 'Rev C <b>"x"</b> & co');
  assert.equal(c.prefix, "My boat: ");
});

test("the title screen shows unless dismissed or ?title=0", () => {
  assert.equal(shouldShowTitle("", false), true);
  assert.equal(shouldShowTitle("?quality=low", false), true);
  assert.equal(shouldShowTitle("?title=0", false), false);
  assert.equal(shouldShowTitle("", true), false);
});
