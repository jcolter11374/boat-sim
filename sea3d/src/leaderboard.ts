import { bestHeadline, groupSummary, launchSetWords, tierName, launchSetYears, sharedKayakBadges, versusWords } from "./boardwords";
import { type BuildName, loadNames, nameOf } from "./names";
import { standing, standingText } from "./results";
// Design leaderboard page: draws the board JSON the "Design leaderboard"
// workflow publishes (boatsim.mc.leaderboard). All statistics are worked out in
// Python (summary()); this page only lays them out. Every piece of data goes in
// with textContent, never innerHTML.

type Interval = [number, number];
interface VsReference {
  gap: number;
  ci95: Interval;
  gained: number;
  lost: number;
  p: number;
  clear: boolean;
  words: string;
}
interface Row {
  tier: number;
  design: string;
  label: string;
  note?: string;
  class: string;
  finish_rate: number;
  ci95: Interval;
  launches: number;
  finished: number;
  badges: string[];
  holdout?: { finish_rate: number; ci95: Interval; launches: number; flag: boolean };
  vs_reference?: VsReference;
}
interface Summary {
  fair: boolean;
  problems: string[];
  reference: string | null;
  reference_label: string | null;
  rows: Row[];
  holdout_flags: string[];
}
interface Board {
  board: { launch_set: string; holdout_set: string | null; headline: string; min_launches: number; sample?: boolean; made?: string; sha?: string };
  entries: { design: string; run?: { commit?: string; job?: string } }[];
  summary?: Summary;
}

const DEFAULT_URL = "./leaderboard/board.json";

/** ?board= may point at another file on this site (the smoke test's sample), nothing else. */
function boardUrl(): string {
  const q = new URLSearchParams(location.search).get("board");
  if (q && /^(\.\/)?[\w-]+(\/[\w-]+)*\.json$/.test(q)) return q;
  return DEFAULT_URL;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

function bar(rate: number, ci: Interval): HTMLElement {
  const b = el("div", "bar");
  const range = el("i");
  range.style.left = `${ci[0] * 100}%`;
  range.style.width = `${Math.max(ci[1] - ci[0], 0) * 100}%`;
  const mark = el("b");
  mark.style.left = `calc(${rate * 100}% - 1px)`;
  b.append(range, mark);
  b.title = `95% range ${pct(ci[0])} to ${pct(ci[1])}`;
  return b;
}

function chip(text: string): HTMLElement {
  const kind = /^our model of /.test(text) ? "model" : /cap|breaks|rule/i.test(text) ? "rule" : "";
  return el("span", `chip ${kind}`.trim(), text);
}

/** A group's one row: its tier, "Our kayak and 4 builds just as good ▸", the finish range. */
function groupRow(tier: number, groups: number, members: Row[], reference: string | null, open: boolean): HTMLElement {
  const tr = el("tr", "group tierstart");
  tr.dataset.tier = String(tier);
  tr.append(el("td", "tier", tierName(tier, groups)));
  const lead = members.find((m) => m.design === reference) ?? members[0];
  const btn = el("button", "grouptoggle");
  btn.type = "button";
  const names = [lead, ...members.filter((m) => m !== lead)].map((m) => m.label);
  const words = el("span", undefined, groupSummary(names, tier === 1));
  // Randolph's boats are tagged wherever their names show (Maya), folded rows too.
  if (members.some((m) => m.badges.some(isModelBadge))) words.append(" ", el("span", "modeltag", "our model"));
  const arrow = el("span", "arrow");
  btn.append(words, " ", arrow);
  const set = (on: boolean) => {
    btn.setAttribute("aria-expanded", String(on));
    arrow.textContent = on ? "▾" : "▸";
    for (const row of Array.from(document.querySelectorAll<HTMLElement>(`#rows tr.member[data-tier="${tier}"]`))) row.hidden = !on;
  };
  btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
  btn.setAttribute("aria-expanded", String(open));
  arrow.textContent = open ? "▾" : "▸";
  const td = el("td");
  td.append(btn);
  const rates = members.map((m) => m.finish_rate);
  const lo = Math.round(Math.min(...rates) * 100);
  const hi = Math.round(Math.max(...rates) * 100);
  tr.append(td, el("td", "muted", lo === hi ? `${lo}%` : `${lo} to ${hi}%`), el("td"), el("td", "stat"));
  return tr;
}

/** A small "i": the model and evidence notes behind a name (Leo: never in the name itself). */
function info(text: string): HTMLElement {
  const i = el("span", "info", "i");
  i.title = text;
  i.tabIndex = 0;
  i.setAttribute("role", "note");
  i.setAttribute("aria-label", text);
  return i;
}

const isModelBadge = (t: string) => /^our model of /.test(t);

function verdictCell(r: Row, s: Summary): HTMLElement {
  const td = el("td", "verdict");
  if (r.design === s.reference) {
    td.append(el("span", "muted", "The one we compare with"));
    return td;
  }
  const v = r.vs_reference;
  if (!v) {
    td.append(el("span", "muted", "Our kayak isn't on this leaderboard"));
    return td;
  }
  // Plain words first (#318); the numbers behind them show with "Show the statistics".
  const w = versusWords(v);
  const head = el("div", w.tone, w.short);
  head.append(" ", info(`${w.head}. ${w.detail}`));
  td.append(head, el("div", "muted stat-line", w.detail));
  return td;
}

function holdoutCell(r: Row): HTMLElement {
  const td = el("td", "stat");
  if (!r.holdout) {
    td.append(el("span", "muted", "not scored"));
    return td;
  }
  const h = r.holdout;
  const top = el("div", h.flag ? "warn" : "", `${pct(h.finish_rate)} of ${h.launches}`);
  td.append(top);
  if (h.flag) td.append(el("div", "warn", "Much worse than on the main launches: may be tuned to the test"));
  return td;
}

function draw(b: Board, names: Map<string, BuildName> = new Map()): void {
  // Player names from the Boatyard grid (names.ts): older boards carry the old labels.
  if (b.summary)
    for (const r of b.summary.rows) {
      const n = nameOf(names, r.design, r.label, r.note);
      r.label = n.label;
      r.note = n.note;
    }
  const s = b.summary;
  const facts = document.getElementById("facts")!;
  const banner = document.getElementById("banner")!;
  const run = b.entries[0]?.run ?? {};
  // About the leaderboard, in words, behind "About this leaderboard" (#318: the
  // ids were the first thing a player saw).
  const bits = [
    `Every build sails the same ${launchSetWords(b.board.launch_set)}.`,
    b.board.holdout_set ? `A hidden year (${launchSetYears(b.board.holdout_set)}) checks nobody tuned to the test.` : "No hidden year to check against.",
    `Simulator version ${(b.board.sha ?? run.commit ?? "?").slice(0, 7)}${b.board.made ? `, run ${b.board.made.slice(0, 10)}` : ""}; every build scored in one run on one machine.`,
  ];
  for (const t of bits) facts.append(el("div", undefined, t));

  if (b.board.sample) {
    banner.className = "glass banner bad";
    banner.append(el("b", undefined, "Sample data for testing the page. These are not results."));
  }
  if (!s) {
    banner.className = "glass banner bad";
    banner.append(el("div", undefined, "This board was built before the page existed; it needs rebuilding."));
    return;
  }
  if (!s.fair) {
    banner.className = "glass banner bad";
    banner.append(el("div", undefined, "Not fair to rank yet:"));
    const ul = el("ul");
    for (const p of s.problems) ul.append(el("li", undefined, p));
    banner.append(ul);
  }

  // A note every kayak row carries ("3.05 m hull: breaks the race's 2.4 m cap"), said once (#318 item 22).
  const shared = sharedKayakBadges(s.rows);
  const note = document.getElementById("shared")!;
  note.replaceChildren();
  // The length rule in a sentence (Milo, M10); any other shared note as it is.
  const lengthRule = (t: string) => /2\.4 m/.test(t);
  if (shared.some(lengthRule)) note.append(el("span", undefined, "Our kayak is 3.05 m, longer than the race's 2.4 m limit. We break that one rule on purpose."));
  const rest = shared.filter((t) => !lengthRule(t));
  if (rest.length) note.append(el("span", undefined, ` Every build of our kayak: ${rest.join("; ")}.`));

  const tbody = document.getElementById("rows")!;
  // leaderboard.html#<design> (from a Results card) marks that build's row.
  let mine = "";
  try {
    mine = decodeURIComponent(location.hash.slice(1));
  } catch {
    // a mangled link: mark nothing
  }
  // Each group is one row that opens in place (Milo M6); only the top group, and the
  // group with a marked build, start open. Groups are named, not numbered (M7).
  const groups = Math.max(0, ...s.rows.map((r) => r.tier));
  const open = new Set<number>([1, ...s.rows.filter((r) => mine && r.design === mine).map((r) => r.tier)]);
  let lastTier = 0;
  for (const r of s.rows) {
    if (r.tier !== lastTier) {
      const members = s.rows.filter((x) => x.tier === r.tier);
      if (members.length > 1) tbody.append(groupRow(r.tier, groups, members, s.reference, open.has(r.tier)));
    }
    const tr = el("tr");
    const single = s.rows.filter((x) => x.tier === r.tier).length === 1;
    if (r.tier !== lastTier && single) tr.classList.add("tierstart");
    if (r.design === s.reference) tr.classList.add("ref");
    tr.dataset.design = r.design;
    tr.dataset.tier = String(r.tier);
    tr.classList.add("member");
    tr.hidden = !single && !open.has(r.tier);
    tr.append(el("td", "tier", r.tier !== lastTier && single ? tierName(r.tier, groups) : ""));
    lastTier = r.tier;

    const name = el("td");
    const nm = el("div", "name", r.label);
    // Randolph's boats say so on screen, not only behind the "i" (Maya): a quiet tag.
    if (r.badges.some(isModelBadge)) nm.append(" ", el("span", "modeltag", "our model"));
    if (r.note) nm.append(" ", info(r.note));
    name.append(nm);
    const chips = el("div");
    for (const t of r.badges) if (!shared.includes(t) && !isModelBadge(t)) chips.append(chip(t));
    name.append(chips);
    tr.append(name);

    const fin = el("td");
    fin.append(el("span", "rate", pct(r.finish_rate)), el("span", "muted", ` ${r.finished} of ${r.launches}`), bar(r.finish_rate, r.ci95));
    tr.append(fin, verdictCell(r, s), holdoutCell(r));
    if (mine && r.design === mine) tr.classList.add("mine");
    tbody.append(tr);
  }
  tbody.querySelector("tr.mine")?.scrollIntoView({ block: "center" });
  drawYou(b, s, mine);
}

/** The first thing a player sees (#318 item 21): where their build stands, in the
 *  Results card's own words (results.ts); else who is in the top group. */
function drawYou(b: Board, s: Summary, mine: string): void {
  const box = document.getElementById("you")!;
  const head = el("div", "head");
  const sub = el("div", "muted");
  // The page shows a sample board under its own red banner, so word it here too.
  const shown = { ...b, board: { ...b.board, sample: false } };
  const st = mine ? standing(mine, shown, null) : null;
  if (st?.kind === "board") {
    const t = standingText(st);
    head.textContent = `Your build: ${t.head.slice(t.head.indexOf(": ") + 2)}`; // drop "On the board of ...: "
    sub.textContent = t.detail;
  } else {
    // Our kayak leads the sentence when it's in the top group ("Best: Our kayak and 4 others").
    const top = s.rows.filter((r) => r.tier === 1).sort((x, y) => Number(y.design === s.reference) - Number(x.design === s.reference));
    const groups = Math.max(0, ...s.rows.map((r) => r.tier));
    head.textContent = s.fair ? bestHeadline(top, groups) : "Not ranked yet: this leaderboard didn't pass its fairness check.";
    if (mine) sub.textContent = "Your build isn't on the leaderboard: it sails a fixed list of builds. The Boatyard gives the odds for others.";
    else {
      sub.textContent = "Builds in the same group can't be told apart with this many launches. ";
      const n = s.rows[0]?.launches ?? 0;
      const when = launchSetWords(b.board.launch_set).replace(/ launches every \d+ days, /, ", ");
      // One sentence from one source for both pages' "i" (Milo M4).
      sub.append(info(`Every build sails the same ${n} launches, ${when}, so the weather is identical for all. The Boatyard tests on a wider set of 100 launches, so its odds can differ by a few points.`));
    }
  }
  box.replaceChildren(head, sub);
  box.hidden = false;
}

/** "Show the statistics": the likely ranges, launch counts and the hidden-year check. */
function wireStats(): void {
  const box = document.getElementById("showstats") as HTMLInputElement | null;
  const board = document.getElementById("board")!;
  box?.addEventListener("change", () => board.classList.toggle("stats", box.checked));
}
wireStats();

declare global {
  interface Window {
    __leaderboard?: { ready: boolean; rows: number; error: string | null; sample: boolean };
  }
}

async function main(): Promise<void> {
  window.__leaderboard = { ready: false, rows: 0, error: null, sample: false };
  const url = boardUrl();
  try {
    const [r, names] = await Promise.all([fetch(url), loadNames()]);
    if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) throw new Error("NO_BOARD");
    const b = (await r.json()) as Board;
    draw(b, names);
    window.__leaderboard = { ready: true, rows: b.summary?.rows.length ?? 0, error: null, sample: !!b.board.sample };
  } catch (e) {
    const banner = document.getElementById("banner")!;
    banner.className = "glass banner";
    const msg = String((e as Error).message) === "NO_BOARD" ? "No board published yet. It appears here after the first full leaderboard run." : `Couldn't read the board: ${String(e)}`;
    banner.append(el("div", undefined, msg));
    window.__leaderboard = { ready: true, rows: 0, error: String((e as Error).message), sample: false };
  }
}

void main();
