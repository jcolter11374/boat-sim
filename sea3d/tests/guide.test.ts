import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GUIDE_KEY, PLAYED_KEYS, START_HERE, TIPS, TIP_MS, goalWords, isNewcomer, markSeen, setSailLink, tipWords, wasSeen } from "../src/helm/guide.ts";

// A first crossing, guided (John, 24 Nov 2026: "New players will have no idea what to do").

const box = (start: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(start));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m };
};
const read = (f: string) => readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8").replace(/\r\n/g, "\n");

test("a browser with nothing saved is a newcomer; any sign of play is not", () => {
  assert.equal(isNewcomer(box()), true);
  // Settings alone (sound, picture quality) are not play.
  assert.equal(isNewcomer(box({ "boatsim-sound": "on", "boatsim.helm.quality": "low" })), true);
  for (const k of PLAYED_KEYS) assert.equal(isNewcomer(box({ [k]: "{}" })), false, k);
});

test("with storage off or broken nobody is a newcomer: the ordinary game, not the tips on every visit", () => {
  assert.equal(isNewcomer(null), false);
  const broken = { getItem: () => { throw new Error("no"); }, setItem: () => {}, removeItem: () => {} };
  assert.equal(isNewcomer(broken), false);
});

test("a newcomer's Set sail goes straight to sea; anyone else's opens the card", () => {
  assert.equal(setSailLink(true), "helm.html?sail");
  assert.equal(setSailLink(false), "helm.html");
});

test("each tip is remembered, so it comes once; a tip shown means she is no longer new", () => {
  const s = box();
  assert.equal(wasSeen("goal", s), false);
  markSeen("goal", s);
  markSeen("call", s);
  markSeen("goal", s);
  assert.deepEqual(JSON.parse(s.m.get(GUIDE_KEY)!), { v: 1, seen: ["goal", "call"] });
  assert.equal(wasSeen("goal", s), true);
  assert.equal(wasSeen("steer", s), false);
  assert.equal(isNewcomer(s), false);
  // Rubbish in the key reads as nothing seen, and is written over.
  const bad = box({ [GUIDE_KEY]: "{not json" });
  assert.equal(wasSeen("goal", bad), false);
  markSeen("time", bad);
  assert.equal(wasSeen("time", bad), true);
  assert.doesNotThrow(() => markSeen("time", null));
});

test("the goal says what the game is, where to, and who the ghost is", () => {
  const g = goalWords(5255.6);
  assert.equal(g.head, "Get your boat across the Atlantic.");
  assert.match(g.body, /^It is 5,256 km to the finish line off Portugal/);
  assert.match(g.body, /A second boat, the ghost, makes the same crossing on autopilot\./);
  assert.match(g.body, /get there before it\.$/);
});

test("the steering tip names only the keys this boat and this screen have", () => {
  assert.match(tipWords("steer", { power: true, touch: false }).body, /← or → to turn her and ↑ or ↓ for more or less motor power\. Space pauses\./);
  const wing = tipWords("steer", { power: false, touch: false }).body;
  assert.match(wing, /← or → to turn her\. Space pauses\./);
  assert.doesNotMatch(wing, /power/);
  const phone = tipWords("steer", { power: true, touch: true }).body;
  assert.doesNotMatch(phone, /Press|Space|←/);
  assert.match(phone, /Open Orders/);
});

test("plain words: no tip is long, and none uses a sailor's word unexplained", () => {
  const all = [goalWords(5256), ...TIPS.filter((t) => t !== "goal").map((t) => tipWords(t as "time" | "call" | "steer"))];
  for (const t of all) {
    assert.ok(t.head.length <= 40, t.head);
    assert.ok(t.body.length <= 240, `${t.head}: ${t.body.length} characters`);
    assert.doesNotMatch(`${t.head} ${t.body}`, /\b(knots?|heading|helm|leeward|windward|tack|reef|trim)\b/i);
    assert.doesNotMatch(`${t.head} ${t.body}`, /—/, "no long dashes");
  }
  // The decision's tip waits for the decision; the others go by themselves.
  assert.equal(TIP_MS.call, 0);
  for (const t of ["goal", "time", "steer"] as const) assert.ok(TIP_MS[t] >= 12_000);
});

test("the title's early copy in index.html has the same rule and words", () => {
  const html = read("../index.html");
  const inline = html.split("<script>")[1]?.split("</script>")[0] ?? "";
  const list = inline.match(/var played = (\[[^\]]+\]);/)?.[1];
  assert.ok(list, "the inline list of played keys");
  assert.deepEqual(JSON.parse(list!), PLAYED_KEYS);
  assert.ok(inline.includes(`"${START_HERE}"`), "the Start here line");
  assert.ok(inline.includes(`"./${setSailLink(true)}"`), "the link straight to sea");
  assert.match(html, /#title nav #t-setsail\.first small \{ display: block;/);
});

test("the sailing page has the tip card, and helm.ts keeps the drawer shut on a first crossing", () => {
  const html = read("../helm.html");
  assert.match(html, /<div id="tip" role="status" aria-live="polite" hidden>/);
  assert.match(html, /body\.orders-open #tip[^{]*\{ display: none; \}/);
  const src = read("../src/helm.ts");
  assert.match(src, /guided = NEWCOMER;/);
  assert.match(src, /\.then\(guided \? \(\) => showTip\("time"\) : opening\)/);
});
