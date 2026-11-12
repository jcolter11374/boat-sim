/**
 * The shared top bar: one menu on every page, so the pages feel like one game
 * (Build -> Sail -> Results -> Tweak; plan in unified-game-proposal.md, step 2).
 *
 * Each page reserves the space itself with `:root { --bar: 40px }` in its own CSS,
 * so the panels sit in the right place before this script runs, and the page still
 * lays out if the script fails. This file only draws the bar.
 *
 * Cinematic mode hides every body child except the 3D view, so the bar hides with it.
 * `?bar=0` hides it too (for embeds and screenshots).
 */
import { currentBoat, onBoatChange } from "./ui/myboatAdapter";
import { MARK_SMALL, WORDMARK_CSS } from "./wordmark";

export interface BarLink {
  /** Which page this is, matched against the page's file name. */
  page: string;
  href: string;
  label: string;
  /** Shorter label for phones. */
  short: string;
  title: string;
}

/** The menu (one-game plan, step 1): Set sail, Boatyard and Practice, then the rest under More.
 *  `more` links sit in the More menu. Practice is the helm page with ?practice. */
export const LINKS: (BarLink & { more?: boolean; search?: string })[] = [
  { page: "index", href: "./", label: "Home", short: "Home", title: "The title screen, with the live sea behind it" },
  { page: "helm", href: "./helm.html", label: "Set sail", short: "Sail", title: "Cross the Atlantic in your boat, on real weather" },
  { page: "boatyard", href: "./boatyard.html", label: "Boatyard", short: "Build", title: "Build your own boat, part by part, and see if she'd make it" },
  { page: "helm", search: "practice", href: "./helm.html?practice", label: "Practice", short: "Practice", title: "Learn to steer on the Annapolis course" },
  { page: "voyage", more: true, href: "./voyage.html", label: "Watch a voyage", short: "Watch", title: "Let the autopilot sail, and watch her go." },
  { page: "race", more: true, href: "./race.html", label: "Race it", short: "Race", title: "Two boats, the same weather: who gets there first?" },
  { page: "leaderboard", more: true, href: "./leaderboard.html", label: "Leaderboard", short: "Board", title: "Which designs reach the finish most often" },
];
/** Credits, last in the More menu. */
const CREDITS = "https://github.com/jcolter11374/boat-sim/blob/main/THIRD_PARTY_NOTICES.md";

/** Is this link the page we're on? Practice and Set sail share helm.html. */
export function isCurrent(l: { page: string; search?: string }, here: string, search: string): boolean {
  if (l.page !== here) return false;
  const practice = new URLSearchParams(search).has("practice");
  return l.search === "practice" ? practice : !practice;
}

const CSS = `
#topbar { position: fixed; top: 0; left: 0; right: 0; height: var(--bar, 40px); z-index: 30; box-sizing: border-box;
  display: flex; align-items: center; gap: 2px; padding: 0 10px;
  background: rgba(8,18,32,.82); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(160,200,255,.18); box-shadow: 0 2px 14px rgba(0,0,0,.28);
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e9f1fb; }
#topbar a { color: inherit; text-decoration: none; white-space: nowrap; }
#topbar .brand { margin-right: 12px; display: flex; align-items: center; padding-bottom: 2px; }
#topbar .brand .bw-mark { font-size: 24px; color: #f2f7fd; }
#topbar .nav { padding: 7px 10px; border-radius: 8px; color: #b7c8dc; }
#topbar .nav:hover { color: #fff; background: rgba(138,180,255,.12); }
#topbar .nav[aria-current="page"] { color: #fff; background: rgba(255,138,42,.2); box-shadow: inset 0 -2px 0 #ff8a2a; }
#topbar .nav .s { display: none; }
#topbar .more { position: relative; }
#topbar .more summary { list-style: none; cursor: pointer; padding: 7px 10px; border-radius: 8px; color: #b7c8dc; white-space: nowrap; }
#topbar .more summary::-webkit-details-marker { display: none; }
#topbar .more summary::after { content: " \\25BE"; }
#topbar .more summary:hover, #topbar .more[open] summary { color: #fff; background: rgba(138,180,255,.12); }
#topbar .more.cur summary { color: #fff; box-shadow: inset 0 -2px 0 #ff8a2a; }
#topbar .more .menu { position: absolute; top: calc(100% + 6px); left: 0; min-width: 190px; padding: 6px; border-radius: 10px; display: flex; flex-direction: column; gap: 2px;
  background: rgba(8,18,32,.94); border: 1px solid rgba(160,200,255,.2); box-shadow: 0 8px 24px rgba(0,0,0,.35); }
#topbar .more .menu a { padding: 8px 10px; border-radius: 7px; color: #dbe6f5; }
#topbar .more .menu a:hover { background: rgba(138,180,255,.14); }
#topbar .more .menu a[aria-current="page"] { color: #fff; background: rgba(255,138,42,.2); }
/* The title screen: just the mark and the chip, so the shot breathes (Elena). */
body.title #topbar .nav, body.title #topbar .more { display: none; }
#topbar .boat { margin-left: auto; cursor: pointer; font-family: inherit; background: none; white-space: nowrap; padding: 5px 10px; border: 1px solid rgba(160,200,255,.25); border-radius: 999px;
  font-weight: 600; font-size: 12.5px; color: #dbe6f5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
#topbar .boat:hover { border-color: #8ab4ff; }
#topbar .boat b { color: #ffb072; font-weight: 650; }
@media (max-width: 760px) {
  #topbar .nav .l { display: none; } #topbar .nav .s { display: inline; }
  #topbar .nav, #topbar .more summary { padding: 7px 6px; }
  #topbar .more .menu { position: fixed; left: auto; right: 6px; top: calc(var(--bar, 40px) + 4px); } /* the bar is the containing block (backdrop-filter): its right edge */ #topbar .brand .bw-mark { font-size: 20px; } #topbar .boat .p { display: none; } #topbar .boat { max-width: 130px; }
}
@media (max-width: 480px) {
  #topbar { padding: 0 6px; font-size: 12.5px; } #topbar .brand { margin-right: 4px; } #topbar .brand .bw-mark { font-size: 17px; }
  #topbar .nav, #topbar .more summary { padding: 7px 4px; } #topbar .boat { max-width: 78px; padding: 5px 8px; }
  /* Phones: the chip is a boat and nothing cut off; its name is in the tooltip and on the picker (Ines). */
  #topbar .boat { max-width: none; padding: 4px 9px; } #topbar .boat b { display: none; } #topbar .boat::before { content: "\\26F5"; font-size: 15px; }
  body.title #topbar .boat b { display: inline; } body.title #topbar .boat::before { content: none; } /* the title's bar is bare: room for the name */
}
`;

/** Which page we're on, from the file name ("index" for the site root). */
export function pageName(pathname: string): string {
  const file = pathname.split("/").pop() ?? "";
  return file === "" ? "index" : file.replace(/\.html?$/, "");
}

/** The "my boat" chip's words and where it goes. The name is player data, so it is only ever set as text.
 *  With no boat saved you sail Our kayak (the helm and start card already treat it as yours), so
 *  the chip says so on every page, the Boatyard included (audit A3; Milo, 12 Nov: the Boatyard is
 *  where a new player first meets the chip, and "build one" there read as broken). */
export function boatChip(boat: { name: string; href: string } | null, page = ""): { prefix: string; name: string; href: string; title: string } {
  // Practice sailing always sails the club's cruiser, whatever boat is yours (Elena: no nag there).
  if (page === "practice") return { prefix: "Practice: ", name: "Cruiser 31", href: "./boatyard.html", title: "Practice sails Cruiser 31, a 9.5 m yacht; your own boat sails the voyages" };
  if (!boat) return { prefix: "My boat: ", name: "Our kayak", href: "./boatyard.html", title: "Our kayak, until you build your own in the Boatyard" };
  return { prefix: "My boat: ", name: boat.name, href: boat.href, title: "Open my boat in the Boatyard" };
}

export function mountTopbar(doc: Document = document): HTMLElement | null {
  if (new URLSearchParams(doc.location.search).get("bar") === "0") {
    doc.documentElement.style.setProperty("--bar", "0px");
    return null;
  }
  if (doc.getElementById("topbar")) return doc.getElementById("topbar");
  const style = doc.createElement("style");
  style.id = "topbar-css";
  style.textContent = WORDMARK_CSS + CSS;
  doc.head.appendChild(style);

  const here = pageName(doc.location.pathname);
  const chipPage = here === "helm" && new URLSearchParams(doc.location.search).has("practice") ? "practice" : here;
  const bar = doc.createElement("nav");
  bar.id = "topbar";
  bar.setAttribute("aria-label", "Game menu");
  const search = doc.location.search;
  const top = LINKS.slice(1).filter((l) => !l.more);
  const more = LINKS.filter((l) => l.more);
  const moreHere = more.some((l) => isCurrent(l, here, search));
  // Constant markup only: the labels and links are ours; the boat's name goes in as text below.
  bar.innerHTML =
    `<a class="brand" href="./" title="Bluewater: design a boat, then sail it across the Atlantic">${MARK_SMALL}</a>` +
    top
      .map((l) => `<a class="nav" href="${l.href}" title="${l.title}"${isCurrent(l, here, search) ? ' aria-current="page"' : ""}><span class="l">${l.label}</span><span class="s">${l.short}</span></a>`)
      .join("") +
    `<details class="more${moreHere ? " cur" : ""}"><summary>More</summary><div class="menu">` +
    more.map((l) => `<a href="${l.href}" title="${l.title}"${isCurrent(l, here, search) ? ' aria-current="page"' : ""}>${l.label}</a>`).join("") +
    `<a href="${CREDITS}" target="_blank" rel="noopener">Credits</a></div></details>` +
    (chipPage === "practice" ? `<a class="boat" id="topbar-boat"></a>` : `<button type="button" class="boat" id="topbar-boat" aria-haspopup="dialog"></button>`);
  doc.body.prepend(bar);

  const chip = bar.querySelector<HTMLElement>("#topbar-boat")!;
  // The chip opens the boat picker (practice always sails the club's cruiser, so there it stays a link).
  if (chip instanceof HTMLButtonElement) chip.addEventListener("click", () => void import("./ui/boatPicker").then((m) => m.openBoatPicker(doc)));
  // Close More when something else is clicked.
  const moreEl = bar.querySelector<HTMLDetailsElement>(".more")!;
  doc.addEventListener("click", (e) => {
    if (moreEl.open && !moreEl.contains(e.target as Node)) moreEl.open = false;
  });
  const draw = () => {
    const c = boatChip(currentBoat(), chipPage);
    const p = doc.createElement("span");
    p.className = "p";
    p.textContent = c.prefix;
    const b = doc.createElement("b");
    b.textContent = c.name;
    chip.replaceChildren(p, b);
    if (chip instanceof HTMLAnchorElement) chip.href = c.href;
    chip.title = chip instanceof HTMLButtonElement ? `${c.prefix}${c.name}: change your boat` : c.title;
    chip.setAttribute("aria-label", chip.title);
  };
  draw();
  onBoatChange(draw);
  return bar;
}

if (typeof document !== "undefined") mountTopbar();
