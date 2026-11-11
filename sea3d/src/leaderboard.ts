export {};
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
  board: { launch_set: string; holdout_set: string | null; headline: string; min_launches: number; sample?: boolean };
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
const pts = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(Math.round(x * 100))}`;

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

function verdictCell(r: Row, s: Summary): HTMLElement {
  const td = el("td", "verdict");
  if (r.design === s.reference) {
    td.append(el("span", "muted", "The plan: the kayak as it stands"));
    return td;
  }
  const v = r.vs_reference;
  if (!v) {
    td.append(el("span", "muted", "No plan kayak on this board"));
    return td;
  }
  const head = el("div");
  if (v.clear) {
    head.className = v.gap > 0 ? "good" : "bad";
    head.textContent = `${v.gap > 0 ? "Better" : "Worse"}: ${pts(v.gap)} points (95% ${pts(v.ci95[0])} to ${pts(v.ci95[1])})`;
  } else {
    head.textContent = `Too close to call: ${pts(v.gap)} points, could be luck`;
  }
  const detail = el(
    "div",
    "muted",
    `Finished ${v.gained} launch${v.gained === 1 ? "" : "es"} the plan didn't; missed ${v.lost} it made.`,
  );
  td.append(head, detail);
  return td;
}

function holdoutCell(r: Row): HTMLElement {
  const td = el("td");
  if (!r.holdout) {
    td.append(el("span", "muted", "not scored"));
    return td;
  }
  const h = r.holdout;
  const top = el("div", h.flag ? "warn" : "", `${pct(h.finish_rate)} of ${h.launches}`);
  td.append(top);
  if (h.flag) td.append(el("div", "warn", "Much worse than on the public launches: may be tuned to the test"));
  return td;
}

function draw(b: Board): void {
  const s = b.summary;
  const facts = document.getElementById("facts")!;
  const banner = document.getElementById("banner")!;
  const run = b.entries[0]?.run ?? {};
  const bits = [
    `Launches: ${b.board.launch_set}`,
    b.board.holdout_set ? `Hidden: ${b.board.holdout_set}` : "No hidden launches",
    `Simulator ${(run.commit ?? "?").slice(0, 7)}`,
    "All designs scored in one run on one machine",
  ];
  for (const t of bits) facts.append(el("span", undefined, t));

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

  const tbody = document.getElementById("rows")!;
  let lastTier = 0;
  for (const r of s.rows) {
    const tr = el("tr");
    if (r.tier !== lastTier) tr.classList.add("tierstart");
    if (r.design === s.reference) tr.classList.add("ref");
    tr.dataset.design = r.design;
    tr.dataset.tier = String(r.tier);
    tr.append(el("td", "tier", r.tier !== lastTier ? String(r.tier) : ""));
    lastTier = r.tier;

    const name = el("td");
    name.append(el("div", "name", r.label));
    const chips = el("div");
    for (const t of r.badges) chips.append(chip(t));
    name.append(chips);
    tr.append(name);

    const fin = el("td");
    fin.append(el("span", "rate", pct(r.finish_rate)), el("span", "muted", ` ${r.finished} of ${r.launches}`), bar(r.finish_rate, r.ci95));
    tr.append(fin, verdictCell(r, s), holdoutCell(r));
    tbody.append(tr);
  }
}

declare global {
  interface Window {
    __leaderboard?: { ready: boolean; rows: number; error: string | null; sample: boolean };
  }
}

async function main(): Promise<void> {
  window.__leaderboard = { ready: false, rows: 0, error: null, sample: false };
  const url = boardUrl();
  try {
    const r = await fetch(url);
    if (!r.ok || /text\/html/.test(r.headers.get("content-type") ?? "")) throw new Error("NO_BOARD");
    const b = (await r.json()) as Board;
    draw(b);
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
