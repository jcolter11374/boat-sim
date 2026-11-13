import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { LINKS, boatChip, isCurrent, pageName } from "../src/topbar";
import { pickedId, pickerEntries } from "../src/ui/boatPicker";
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
  assert.deepEqual([...new Set(LINKS.map((l) => l.page))].sort(), names);
  // One-game step 1: Set sail, Boatyard, Practice up front; Watch a voyage, Race it, Leaderboard under More.
  assert.deepEqual(LINKS.slice(1).filter((l) => !l.more).map((l) => l.label), ["Set sail", "Boatyard", "Practice"]);
  assert.deepEqual(LINKS.filter((l) => l.more).map((l) => l.label), ["Watch a voyage", "Race it", "Leaderboard"]);
  assert.ok(LINKS.every((l) => !/sped up/.test(l.title)), "T2: replays open in real time");
  for (const l of LINKS) assert.ok(l.href === "./" || pages.includes(l.href.slice(2).split("?")[0]), l.href);
});

test("page names come from the file name", () => {
  assert.equal(pageName("/boat-sim/"), "index");
  assert.equal(pageName("/boat-sim/index.html"), "index");
  assert.equal(pageName("/boat-sim/helm.html"), "helm");
  assert.equal(pageName("/race.html"), "race");
});

test("the boat chip: Our kayak by default on every page, my boat named safely", () => {
  for (const page of ["index", "helm", "voyage", "race", "leaderboard", "boatyard"]) {
    const d = boatChip(null, page);
    assert.equal(d.prefix + d.name, "My boat: Our kayak", page);
    assert.equal(d.href, "./boatyard.html");
  }
  assert.equal(boatChip(null).name, "Our kayak");
  assert.equal(boatChip(null, "practice").prefix + boatChip(null, "practice").name, "Practice boat: Cruiser 31");
  assert.equal(boatChip({ name: "Mine", href: "#" }, "practice").name, "Cruiser 31");
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

test("Set sail and Practice share helm.html; the bar lights the right one", () => {
  const sail = LINKS.find((l) => l.label === "Set sail")!;
  const practice = LINKS.find((l) => l.label === "Practice")!;
  assert.equal(isCurrent(sail, "helm", ""), true);
  assert.equal(isCurrent(practice, "helm", ""), false);
  assert.equal(isCurrent(practice, "helm", "?practice"), true);
  assert.equal(isCurrent(sail, "helm", "?practice"), false);
  assert.equal(isCurrent(sail, "voyage", ""), false);
});

test("the boat picker: Our kayak, our models and stock boats, your design, the Boatyard", () => {
  const none = pickerEntries(null);
  assert.equal(none[0].name, "Our kayak");
  // Every row has the same kind of second line: a plain description (Ines); Boatyard rows read as links.
  assert.ok(none.every((e) => e.fact && !/%/.test(e.fact)));
  assert.ok(none.filter((e) => e.href).every((e) => e.name.endsWith("→")));
  const names = none.map((e) => e.name);
  assert.ok(names.includes("Pearson 31-2 (our model)"));
  assert.ok(names.includes("Randolph Rev C5 (our model) →"));
  assert.ok(names.includes("Cruiser 31"), "metric names (Leo's glossary)");
  assert.ok(!none.some((e) => /drone|\bft\b/.test(e.name + e.fact)), "player words: robot boat, metric");
  assert.ok(!none.some((e) => e.id === "mine"));
  assert.equal(none.at(-1)!.href, "./boatyard.html");
  // Every Randolph boat says "(our model)" (B2).
  for (const e of none) if (/Randolph|Pearson/.test(e.name)) assert.match(e.name, /\(our model\)/);
  assert.ok(!none.some((e) => /\$|price|cost/i.test(e.name + e.fact)), "B7: no money");
  const design = { kind: "yard" as const, base: "revc", hash: "#base=revc&rudder=single", name: "Mine <b>", choices: {}, saved: "" };
  const withMine = pickerEntries(design);
  assert.equal(withMine.find((e) => e.id === "mine")!.name, "Mine <b>");
  assert.equal(pickedId(design), "mine");
  assert.equal(pickedId(null), "kayak");
  assert.equal(pickedId({ kind: "stock", base: "stock_cruiser31", hash: "", name: "x", choices: {}, saved: "" }), "stock_cruiser31");
  assert.equal(pickedId({ kind: "yard", base: "kayak", hash: "", name: "Our kayak", choices: {}, saved: "" }), "kayak");
});
