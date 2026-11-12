/**
 * The title screen on index.html (one-game plan, step 2): the game menu over the
 * live sea. "Just watch the sea" swaps it for the sea controls; that choice lasts
 * for the browser tab, and `?title=0` skips the menu (for links to the sea demo).
 */
import { currentBoat, onBoatChange } from "./ui/myboatAdapter";

const KEY = "boatsim.title.dismissed";

export function shouldShowTitle(search: string, dismissed: boolean): boolean {
  return new URLSearchParams(search).get("title") !== "0" && !dismissed;
}

function dismissedBefore(): boolean {
  try { return sessionStorage.getItem(KEY) === "1"; } catch { return false; }
}

export function mountTitle(): void {
  const el = document.getElementById("title");
  if (!el) return;
  const show = (on: boolean) => {
    el.hidden = !on;
    document.body.classList.toggle("title", on);
  };
  show(shouldShowTitle(location.search, dismissedBefore()));

  document.getElementById("t-sea")?.addEventListener("click", () => {
    try { sessionStorage.setItem(KEY, "1"); } catch { /* private mode: fine, it just shows again */ }
    show(false);
  });

  const mine = document.getElementById("t-mine")!;
  const build = document.getElementById("t-build")!;
  const draw = () => {
    const boat = currentBoat();
    mine.hidden = !boat;
    build.classList.toggle("main", !boat);
    if (boat) {
      document.getElementById("t-boatname")!.textContent = boat.name;
      (document.getElementById("t-edit") as HTMLAnchorElement).href = boat.href;
    }
  };
  draw();
  onBoatChange(draw);
}

if (typeof document !== "undefined") mountTitle();
