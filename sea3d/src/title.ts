/**
 * The title screen on index.html (one-game plan, step 1): Set sail, Boatyard and Practice
 * over the live sea, the rest under More. "Just watch the sea" swaps it for the sea controls; that choice lasts
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

  // "My boat: Our kayak · Change": the name is player data (textContent only); Change opens the picker.
  const name = document.getElementById("t-boatname")!;
  const draw = () => {
    name.textContent = currentBoat()?.name ?? "Our kayak";
  };
  draw();
  onBoatChange(draw);
  document.getElementById("t-change")?.addEventListener("click", () => void import("./ui/boatPicker").then((m) => m.openBoatPicker()));
}

if (typeof document !== "undefined") mountTitle();
