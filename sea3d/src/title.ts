/**
 * The title screen on index.html (one-game plan, step 1): Set sail, Boatyard and Practice
 * over the live sea, the rest under More. "Just watch the sea" swaps it for the sea controls; that choice lasts
 * for the browser tab, and `?title=0` skips the menu (for links to the sea demo).
 */
import { currentBoat, onBoatChange } from "./ui/myboatAdapter";
import { continueLink, loadVoyage, offerWords } from "./helm/voyageSave";
import { START_HERE, isNewcomer, setSailLink } from "./helm/guide";

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

  // "Just watch the sea" (John, 14 Nov 2026): the title's own shot with the menu away, not the old
  // two-boat demo (that stays at ?title=0). A quiet Menu link and the speaker sit in the corner and
  // fade when the pointer rests; Menu or Esc brings the menu back.
  let idle = 0;
  const wake = () => {
    document.body.classList.remove("idle");
    clearTimeout(idle);
    if (document.body.classList.contains("sea-only")) idle = window.setTimeout(() => document.body.classList.add("idle"), 3000);
  };
  const watch = (on: boolean) => {
    document.body.classList.toggle("sea-only", on);
    if (on) (document.getElementById("t-back") as HTMLElement | null)?.focus({ preventScroll: true });
    else (document.querySelector("#t-continue:not([hidden]), #t-setsail") as HTMLElement | null)?.focus({ preventScroll: true });
    wake();
  };
  document.getElementById("t-sea")?.addEventListener("click", () => {
    (document.getElementById("t-more") as HTMLDetailsElement | null)?.removeAttribute("open");
    watch(true);
  });
  document.getElementById("t-back")?.addEventListener("click", () => watch(false));
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("sea-only")) watch(false);
    else wake();
  });
  addEventListener("pointermove", wake, { passive: true });
  addEventListener("pointerdown", wake, { passive: true });

  // "Continue your voyage" (M3): shown when a crossing is saved in this browser, as the one
  // orange button; Set sail steps down to an ordinary one while it is there. Drawn again when
  // the page comes back from the browser's Back button, when a voyage may just have been left.
  const offer = () => {
    const a = document.getElementById("t-continue") as HTMLAnchorElement | null;
    if (!a) return;
    const v = loadVoyage();
    a.hidden = !v;
    el.classList.toggle("has-voyage", !!v); // a phone drops the intro line: a returning player has read it (Elena)
    const set = document.getElementById("t-setsail") as HTMLAnchorElement | null;
    set?.classList.toggle("main", !v);
    // Someone who has never played goes straight to sea, with one line that says so (helm/guide.ts);
    // anyone else gets the Set sail card and its choices, as before.
    const first = isNewcomer();
    if (set) {
      set.href = `./${setSailLink(first)}`;
      set.classList.toggle("first", first);
      const line = set.querySelector("small");
      if (line && first) line.textContent = START_HERE;
    }
    if (!v) return;
    a.href = `./${continueLink(v)}`;
    document.getElementById("t-continue-sub")!.textContent = offerWords(v); // the boat's name is the player's text
  };
  offer();
  addEventListener("pageshow", offer);

  // "My boat: Our kayak · Change": the name is player data (textContent only); Change opens the picker.
  const name = document.getElementById("t-boatname")!;
  const note = document.getElementById("t-boatnote");
  const draw = () => {
    const b = currentBoat();
    name.textContent = b?.name ?? "Our kayak";
    // A renamed design on the Randolph boat: what it's built on, in a small muted note (B2, Elena).
    if (note) {
      note.textContent = b?.note ?? "";
      note.hidden = !b?.note;
    }
  };
  draw();
  onBoatChange(draw);
  document.getElementById("t-change")?.addEventListener("click", () => void import("./ui/boatPicker").then((m) => m.openBoatPicker()));
}

if (typeof document !== "undefined") mountTitle();
