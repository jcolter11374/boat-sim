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

export interface BarLink {
  /** Which page this is, matched against the page's file name. */
  page: string;
  href: string;
  label: string;
  /** Shorter label for phones. */
  short: string;
  title: string;
}

/** The menu, in the order of the game loop. */
export const LINKS: BarLink[] = [
  { page: "index", href: "./", label: "Home", short: "Home", title: "The title screen, with the live sea behind it" },
  { page: "boatyard", href: "./boatyard.html", label: "Build", short: "Build", title: "Boatyard: design your boat" },
  { page: "helm", href: "./helm.html", label: "Take the helm", short: "Helm", title: "Sail it yourself: you give the orders as the days pass" },
  { page: "voyage", href: "./voyage.html", label: "Watch a voyage", short: "Watch", title: "Let the autopilot sail and watch it, sped up" },
  { page: "race", href: "./race.html", label: "Race", short: "Race", title: "Race two designs on the same weather" },
  { page: "leaderboard", href: "./leaderboard.html", label: "Leaderboard", short: "Board", title: "Which designs reach the finish most often" },
];

const CSS = `
#topbar { position: fixed; top: 0; left: 0; right: 0; height: var(--bar, 40px); z-index: 30; box-sizing: border-box;
  display: flex; align-items: center; gap: 2px; padding: 0 10px; overflow-x: auto; scrollbar-width: none;
  background: rgba(8,18,32,.82); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  border-bottom: 1px solid rgba(160,200,255,.18); box-shadow: 0 2px 14px rgba(0,0,0,.28);
  font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif; color: #e9f1fb; }
#topbar::-webkit-scrollbar { display: none; }
#topbar a { color: inherit; text-decoration: none; white-space: nowrap; }
#topbar .brand { font-weight: 750; letter-spacing: .3px; margin-right: 10px; display: flex; align-items: center; gap: 7px; }
#topbar .brand i { width: 14px; height: 14px; border-radius: 3px 3px 7px 7px; background: #ff8a2a; display: inline-block; }
#topbar .nav { padding: 7px 10px; border-radius: 8px; color: #b7c8dc; }
#topbar .nav:hover { color: #fff; background: rgba(138,180,255,.12); }
#topbar .nav[aria-current="page"] { color: #fff; background: rgba(255,138,42,.2); box-shadow: inset 0 -2px 0 #ff8a2a; }
#topbar .nav .s { display: none; }
#topbar .boat { margin-left: auto; padding: 5px 10px; border: 1px solid rgba(160,200,255,.25); border-radius: 999px;
  font-weight: 600; font-size: 12.5px; color: #dbe6f5; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
#topbar .boat:hover { border-color: #8ab4ff; }
#topbar .boat b { color: #ffb072; font-weight: 650; }
@media (max-width: 760px) {
  #topbar .nav .l { display: none; } #topbar .nav .s { display: inline; }
  #topbar .nav { padding: 7px 7px; } #topbar .brand span, #topbar .boat .p { display: none; } #topbar .boat { max-width: 130px; }
}
`;

/** Which page we're on, from the file name ("index" for the site root). */
export function pageName(pathname: string): string {
  const file = pathname.split("/").pop() ?? "";
  return file === "" ? "index" : file.replace(/\.html?$/, "");
}

/** The "my boat" chip's words and where it goes. The name is player data, so it is only ever set as text.
 *  With no boat saved you sail Our kayak (the helm and start card already treat it as yours), so
 *  the chip says so; "build one" only shows in the Boatyard, where it isn't a nag (Leo's audit A3). */
export function boatChip(boat: { name: string; href: string } | null, page = ""): { prefix: string; name: string; href: string; title: string } {
  if (!boat && page === "boatyard") return { prefix: "No boat of your own yet: ", name: "build one", href: "./boatyard.html", title: "Design a boat in the Boatyard" };
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
  style.textContent = CSS;
  doc.head.appendChild(style);

  const here = pageName(doc.location.pathname);
  const bar = doc.createElement("nav");
  bar.id = "topbar";
  bar.setAttribute("aria-label", "Game menu");
  bar.innerHTML =
    `<a class="brand" href="./" title="boat-sim: design a boat, then sail it across the Atlantic"><i></i><span>boat-sim</span></a>` +
    LINKS.slice(1)
      .map((l) => `<a class="nav" href="${l.href}" title="${l.title}"${l.page === here ? ' aria-current="page"' : ""}><span class="l">${l.label}</span><span class="s">${l.short}</span></a>`)
      .join("") +
    `<a class="boat" id="topbar-boat"></a>`;
  doc.body.prepend(bar);

  const chip = bar.querySelector<HTMLAnchorElement>("#topbar-boat")!;
  const draw = () => {
    const c = boatChip(currentBoat(), here);
    const p = doc.createElement("span");
    p.className = "p";
    p.textContent = c.prefix;
    const b = doc.createElement("b");
    b.textContent = c.name;
    chip.replaceChildren(p, b);
    chip.href = c.href;
    chip.title = c.title;
  };
  draw();
  onBoatChange(draw);
  return bar;
}

if (typeof document !== "undefined") mountTopbar();
