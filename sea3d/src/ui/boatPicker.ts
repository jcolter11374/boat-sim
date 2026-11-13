/**
 * "Your boat": the one boat picker, opened from the "My boat" chip in the top bar and
 * from the title screen (one-game plan, step 1; Leo's words in one-game-words.md §4).
 *
 * Picking a boat only sets "my boat" (src/myboat.ts); every page then sails it. A boat
 * that needs the Boatyard to build it first (the Randolph Rev C5, a new design) is a link
 * there instead. Names a player typed are only ever set as text.
 */
import { clearMyBoat, loadMyBoat, saveMyBoat, type MyBoat } from "../myboat";
import { PLAYABLE_STOCK, STOCK, isStock, playerName, type StockKey } from "../boats/specs";
import { ABOUT } from "../boats/about";

export interface PickerEntry {
  /** "kayak", a stock id, "mine" (the saved design) or "yard:<base>" (a Boatyard link). */
  id: string;
  group: "Ours" | "Stock boats" | "The Randolph team's boats" | "Your designs";
  name: string;
  /** One plain fact line. */
  fact: string;
  /** Set when picking it means going to the Boatyard instead. */
  href?: string;
}

/** One plain fact for each boat you can sail from the picker. */
const STOCK_FACT: Partial<Record<StockKey, string>> = {
  stock_pearson31_2: "the Randolph team's own boat",
  stock_cruiser31: "a 9.5 m sailing yacht with a keel and a small engine",
};

const nameOf = playerName;

/** The picker's rows, in order, for the boat saved now (or none). */
export function pickerEntries(mine: MyBoat | null): PickerEntry[] {
  const out: PickerEntry[] = [{ id: "kayak", group: "Ours", name: "Our kayak", fact: "a 3 m solar robot boat: two small electric motors, no sail" }];
  // The Pearson first: it's the Randolph team's boat, and STOCK already says "(our model ...)".
  const stock = [...PLAYABLE_STOCK].sort((a, b) => (a === "stock_pearson31_2" ? -1 : b === "stock_pearson31_2" ? 1 : 0));
  for (const k of stock) {
    const name = nameOf(k);
    out.push({ id: k, group: "Stock boats", name, fact: STOCK_FACT[k] ?? "a ready-made boat, sailed as it comes" });
  }
  out.push({ id: "yard:revc", group: "The Randolph team's boats", name: "Randolph Rev C5 (our model) →", fact: "the Randolph team's wing-sail robot boat, built in the Boatyard", href: "./boatyard.html#base=revc" });
  if (mine && mine.kind === "yard" && !(mine.base === "kayak" && mine.hash === ""))
    out.push({ id: "mine", group: "Your designs", name: mine.name, fact: "your boat from the Boatyard" });
  out.push({ id: "yard:new", group: "Your designs", name: "Build a new one in the Boatyard →", fact: "pick a hull, sails or motors, batteries and electronics", href: "./boatyard.html" });
  return out;
}

/** Which row stands for the boat saved now. */
export function pickedId(mine: MyBoat | null): string {
  if (!mine || (mine.kind === "yard" && mine.base === "kayak" && mine.hash === "")) return "kayak";
  return mine.kind === "stock" ? mine.base : "mine";
}

/** Make the picked row "my boat". Boatyard rows are links, so they never get here. */
export function choose(id: string): void {
  if (id === "mine") return; // already saved
  if (id === "kayak") {
    clearMyBoat(); // no boat saved = Our kayak, everywhere
    return;
  }
  const k = id as StockKey;
  if (STOCK[k]) saveMyBoat({ kind: "stock", base: k, hash: "", name: nameOf(k), choices: { base: k } });
}

const CSS = `
#boatpick { position: fixed; inset: 0; z-index: 40; display: flex; align-items: center; justify-content: center; background: rgba(4,10,18,.45); }
#boatpick[hidden] { display: none; }
#boatpick .card { width: min(420px, calc(100vw - 24px)); max-height: calc(100vh - 80px); overflow-y: auto; box-sizing: border-box; padding: 18px 20px 16px;
  border-radius: 14px; color: #e9f1fb; background: rgba(8,18,32,.86); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border: 1px solid rgba(160,200,255,.2); box-shadow: 0 10px 34px rgba(0,0,0,.4); font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; }
#boatpick h2 { margin: 0 0 8px; font: 800 26px/1.1 "Fraunces", Georgia, serif; }
#boatpick .gh { margin: 12px 0 4px; font-size: 11px; letter-spacing: .6px; text-transform: uppercase; color: #9fb3c8; }
#boatpick label, #boatpick a.row { display: block; padding: 7px 10px; margin: 3px 0; border-radius: 9px; border: 1px solid rgba(160,200,255,.18); cursor: pointer; color: inherit; text-decoration: none; }
#boatpick label:hover, #boatpick a.row:hover { border-color: #8ab4ff; }
#boatpick label:has(input:checked) { border-color: #ff8a2a; background: rgba(255,138,42,.16); }
#boatpick input { margin: 0 8px 0 0; accent-color: #ff8a2a; }
#boatpick small { display: block; color: #9fb3c8; font-size: 12px; margin: 1px 0 0 22px; }
#boatpick a.row small { margin-left: 0; }
#boatpick details.about { margin: -1px 0 6px 32px; font-size: 12px; color: #c9d6e4; }
#boatpick details.about summary { cursor: pointer; color: #8ab4ff; font-weight: 600; }
#boatpick details.about[open] { padding: 4px 0 2px; }
#boatpick details.about dl { display: grid; grid-template-columns: max-content 1fr; gap: 2px 10px; margin: 6px 0; }
#boatpick details.about dt { color: #9fb3c8; }
#boatpick details.about dd { margin: 0; }
#boatpick details.about p { margin: 6px 0; }
#boatpick details.about .src, #boatpick details.about .src a { color: #9fb3c8; font-size: 11px; }
#boatpick .foot { display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
#boatpick .go { font: 700 15px system-ui, sans-serif; padding: 9px 20px; border-radius: 10px; border: 1px solid #ff8a2a; background: #ff8a2a; color: #1a0d02; cursor: pointer; }
#boatpick .x { background: none; border: 0; color: #9fb3c8; font: 600 13px system-ui, sans-serif; cursor: pointer; }
`;

let root: HTMLElement | null = null;

/** Another use of the same picker (the Set sail card's "The other boat"): its own title, rows and button. Nothing is saved as "my boat". */
export interface PickerUse {
  title: string;
  button: string;
  entries: PickerEntry[];
  picked: string;
  choose: (id: string) => void;
}

/** Open the picker (builds it the first time). */
export function openBoatPicker(doc: Document = document, use?: PickerUse): void {
  // Fold any open More menu first (Ines).
  doc.querySelectorAll<HTMLDetailsElement>("details[open]").forEach((d) => (d.open = false));
  if (!root) {
    const style = doc.createElement("style");
    style.textContent = CSS;
    doc.head.appendChild(style);
    root = doc.createElement("div");
    root.id = "boatpick";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-labelledby", "boatpick-h");
    root.addEventListener("click", (e) => e.target === root && close());
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && root && !root.hidden) {
        e.stopPropagation();
        close();
      }
    }, true);
    doc.body.appendChild(root);
  }
  const mine = loadMyBoat();
  const card = doc.createElement("div");
  card.className = "card";
  const h = Object.assign(doc.createElement("h2"), { id: "boatpick-h", textContent: use?.title ?? "Your boat" });
  card.append(h);
  let group = "";
  const picked = use?.picked ?? pickedId(mine);
  for (const e of use?.entries ?? pickerEntries(mine)) {
    if (e.group !== group) {
      group = e.group;
      card.append(Object.assign(doc.createElement("div"), { className: "gh", textContent: group }));
    }
    const fact = e.fact ? Object.assign(doc.createElement("small"), { textContent: e.fact }) : null;
    if (e.href) {
      const a = Object.assign(doc.createElement("a"), { className: "row", href: e.href, textContent: e.name });
      if (fact) a.append(fact);
      card.append(a);
      continue;
    }
    const label = doc.createElement("label");
    const input = Object.assign(doc.createElement("input"), { type: "radio", name: "boatpick", value: e.id, checked: e.id === picked });
    label.append(input, Object.assign(doc.createElement("b"), { textContent: e.name }));
    if (fact) label.append(fact);
    card.append(label);
    if (isStock(e.id)) card.append(aboutBox(doc, e.id));
  }
  const foot = doc.createElement("div");
  foot.className = "foot";
  const x = Object.assign(doc.createElement("button"), { type: "button", className: "x", textContent: "Close" });
  x.addEventListener("click", close);
  const go = Object.assign(doc.createElement("button"), { type: "button", className: "go", textContent: use?.button ?? "Sail this boat" });
  go.addEventListener("click", () => {
    const v = card.querySelector<HTMLInputElement>('input[name="boatpick"]:checked')?.value;
    if (v) (use?.choose ?? choose)(v);
    close();
  });
  foot.append(x, go);
  card.append(foot);
  root.replaceChildren(card);
  root.hidden = false;
  card.querySelector<HTMLInputElement>("input:checked")?.focus();
  (window as unknown as { __boatpick?: unknown }).__boatpick = { open: true };
}

/** "Specs and history" under a stock boat's row (John, 13 Nov): folded until asked for. Text only. */
export function aboutBox(doc: Document, key: StockKey): HTMLDetailsElement {
  const a = ABOUT[key];
  const box = Object.assign(doc.createElement("details"), { className: "about" });
  box.dataset.boat = key;
  box.append(Object.assign(doc.createElement("summary"), { textContent: "Specs and history" }));
  const dl = doc.createElement("dl");
  for (const [k, v] of a.specs) dl.append(Object.assign(doc.createElement("dt"), { textContent: k }), Object.assign(doc.createElement("dd"), { textContent: v }));
  const p = (t: string) => Object.assign(doc.createElement("p"), { textContent: t });
  box.append(p(`Based on ${a.basedOn}. Our own model: not the maker's boat, and no connection to them.`), dl, p(a.history));
  if (a.ours) box.append(p(a.ours));
  const src = Object.assign(doc.createElement("p"), { className: "src", textContent: "Sources: " });
  a.sources.forEach((s, i) => {
    if (i) src.append("; ");
    src.append(Object.assign(doc.createElement("a"), { href: s.url, textContent: s.name, target: "_blank", rel: "noopener" }));
  });
  box.append(src);
  return box;
}

function close(): void {
  if (root) root.hidden = true;
  (window as unknown as { __boatpick?: unknown }).__boatpick = { open: false };
}
