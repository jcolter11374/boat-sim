/**
 * The title screen on index.html (one-game plan, step 1): Set sail, Boatyard and Practice
 * over the live sea, the rest under More. "Just watch the sea" swaps it for the sea controls; that choice lasts
 * for the browser tab, and `?title=0` skips the menu (for links to the sea demo).
 */
import { currentBoat, onBoatChange } from "./ui/myboatAdapter";
import { continueLink, loadVoyage, offerWords } from "./helm/voyageSave";

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

  // "Continue your voyage" (M3): shown when a crossing is saved in this browser, as the one
  // orange button; Set sail steps down to an ordinary one while it is there. Drawn again when
  // the page comes back from the browser's Back button, when a voyage may just have been left.
  const offer = () => {
    const a = document.getElementById("t-continue") as HTMLAnchorElement | null;
    if (!a) return;
    const v = loadVoyage();
    a.hidden = !v;
    document.getElementById("t-setsail")?.classList.toggle("main", !v);
    if (!v) return;
    a.href = `./${continueLink(v)}`;
    document.getElementById("t-continue-sub")!.textContent = offerWords(v); // the boat's name is the player's text
  };
  offer();
  addEventListener("pageshow", offer);

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
