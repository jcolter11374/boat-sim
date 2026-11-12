// The Set sail card (one-game plan, step 1; Elena's approved wireframe, Leo's words in
// one-game-words.md §3). One card for every way to start: your boat, where (the crossing or
// the Annapolis practice course), the launch day, and an optional weather challenge, then one
// Set sail button. No speed choice here (John, T3): speed is a control you change at sea.
//
// The card draws pills over the helm's own controls, which stay the source of truth (the boat
// radios, #launch, #challenge), so begin() reads them as before. Annapolis goes through Rosa's
// startVoyage (window.__setsail.start), which reloads into practice with the choices.
import { implied, SET_SAIL, type SetSail } from "./setsail";
import { onMyBoatChange, type MyBoat } from "../myboat";

/** Leo's words for the card (one-game-words.md §3); SET_SAIL's keys are Rosa's contract. */
export const CARD_WORDS = {
  where: { ocean: ["Across the Atlantic to Portugal", "5,256 km"], annapolis: ["Annapolis practice course", "about 10 min"] },
  when: { calm: ["Calm", "23 Apr 2020"], rough: ["Rough", "1 Apr 2020"] },
} as const;

/** One plain line per challenge for the card (Ines, Leo's rules): what the weather does, no
 *  spoilers about how a boat fares, no "drop" or UTC. The launch date comes after it. */
export const CHALLENGE_LINE: Record<string, string> = {
  "gentle-june": "A kind June: the seas never top 3 m.",
  "spring-gale": "An early start into a late-season gale: 43 kn winds and seas to 6.7 m.",
  "sandys-shadow": "Hurricane Sandy comes up the coast a week after you set off.",
  dorian: "Hurricane Dorian brushes the North Carolina coast a few days after you set off, then races north.",
  "bermuda-double": "Two hurricanes in a week, one right over Bermuda and one just off it.",
  lorenzo: "Lorenzo, the strongest hurricane ever seen that far east, crosses the Azores as you near them.",
  ophelia: "Hurricane Ophelia turns up near the finish, then storms on toward Ireland.",
  "winter-train": "The winter of 2013-14: a dozen big storms in a row, with seas up to 18 m.",
  "bay-mouth": "Wind and current push hard toward the coast. Can you keep her clear?",
};

/** The card's line for a challenge: our plain line (or the story without spoilers), then "Launches <date>." */
export function challengeLine(id: string, story: string, date: string): string {
  const base = CHALLENGE_LINE[id] ?? story.split(/(?<=\.)\s+/).filter((x) => !/stock kayak|drift test|noon UTC|\bdrop\b/i.test(x)).join(" ");
  return `${base}${date ? ` Launches ${date}.` : ""}`.trim();
}

/** Annapolis on the card: on once the card shows the helm's real Cruiser 31 behind it (Elena's r4). */
export const ANNAPOLIS_ON_CARD = true;

export interface CardHooks {
  current: () => SetSail;
  start: (s: SetSail) => Promise<void>;
  challengesReady: Promise<unknown>;
  /** Put the boat this choice sails on the water behind the card. */
  preview?: (where: SetSail["where"]) => void;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** One row of pills; `on` says which key is pressed. Labels are ours (constant); data goes in as text. */
function pills(box: HTMLElement, items: { key: string; label: string; sub?: string }[], on: string, pick: (k: string) => void): void {
  box.replaceChildren(
    ...items.map((it) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ss-pill";
      b.setAttribute("aria-pressed", String(it.key === on));
      b.append(it.label);
      if (it.sub) b.append(Object.assign(document.createElement("small"), { textContent: it.sub }));
      b.addEventListener("click", () => pick(it.key));
      return b;
    }),
  );
}

export function mountSetSailCard(hooks: CardHooks): void {
  const card = document.getElementById("ss-card");
  if (!card) return;
  let where: SetSail["where"] = "ocean";
  let course: string = SET_SAIL.course[0].key;
  let breeze: string = "good";
  let allChallenges = false;
  const launch = $<HTMLSelectElement>("launch");
  const challenge = $<HTMLSelectElement>("challenge");
  const more = $<HTMLDetailsElement>("more");

  const checkedBoat = () => document.querySelector<HTMLInputElement>('input[name="boat"]:checked');
  const draw = () => {
    const s = { ...hooks.current(), where, challenge: where === "ocean" ? challenge.value : "" };
    const show = implied(s);
    hooks.preview?.(where);
    // Your boat: the ticked radio's name (the player's own text for a Boatyard design: textContent).
    $("ss-boatname").textContent = checkedBoat()?.parentElement?.querySelector("b")?.textContent ?? "Our kayak";
    // Practice always sails the club's yacht: say so, so nobody wonders where their boat went (Ines).
    $("ss-boat").hidden = !show.boatShown;
    $("ss-practiceboat").hidden = show.boatShown;
    pills($("ss-where-opts"), SET_SAIL.where.filter((o) => o.key === "ocean" || ANNAPOLIS_ON_CARD).map((o) => ({ key: o.key, label: CARD_WORDS.where[o.key][0], sub: CARD_WORDS.where[o.key][1] })), where, (k) => {
      where = k as SetSail["where"];
      draw();
    });
    // Annapolis: the course and the breeze instead of the boat, the day and the challenge.
    $("ss-course").hidden = !show.courseShown;
    more.hidden = show.courseShown; // the crossing's options (how you steer, breakdowns) don't apply to practice
    pills($("ss-course-opts"), SET_SAIL.course.map((o) => ({ key: o.key, label: o.label })), course, (k) => {
      course = k;
      draw();
    });
    pills($("ss-breeze-opts"), SET_SAIL.breeze.map((o) => ({ key: o.key, label: o.label, sub: o.sub })), breeze, (k) => {
      breeze = k;
      draw();
    });
    // Launch day: Calm, Rough, or another day from the full list.
    $("ss-when").hidden = !show.whenShown;
    const lv = launch.value;
    const named = lv === "2020-04-23" ? "calm" : lv === "0" ? "rough" : "other";
    const otherLabel = named === "other" ? (launch.selectedOptions[0]?.textContent ?? "Another day").replace(/:.*$/, "") : "Pick a day…";
    pills(
      $("ss-when-opts"),
      [
        { key: "calm", label: CARD_WORDS.when.calm[0], sub: CARD_WORDS.when.calm[1] },
        { key: "rough", label: CARD_WORDS.when.rough[0], sub: CARD_WORDS.when.rough[1] },
        { key: "other", label: otherLabel },
      ],
      named,
      (k) => {
        if (k === "other") {
          more.open = true;
          launch.focus();
          return;
        }
        launch.value = k === "calm" ? "2020-04-23" : "0";
        launch.dispatchEvent(new Event("change", { bubbles: true }));
        draw();
      },
    );
    // Weather challenge (optional): None, then each challenge; the one-line why under it.
    $("ss-ch").hidden = where !== "ocean" || challenge.options.length < 2;
    // None and the first three, then "More…" for the rest (Leo: "None · Gentle June · … · …"), so the card stays short.
    const all = Array.from(challenge.options).map((o) => ({ key: o.value, label: o.value ? o.textContent!.replace(/^(\d+\.|Bonus:)\s*/, "").replace(/\s*\(.*\)$/, "") : "None" }));
    const picked = all.findIndex((o) => o.key === challenge.value);
    const shown = allChallenges || picked > 3 ? all : [...all.slice(0, 4), { key: "\u2026", label: "More\u2026" }];
    pills($("ss-ch-opts"), shown, challenge.value, (k) => {
      if (k === "\u2026") {
        allChallenges = true;
        draw();
        return;
      }
      challenge.value = k;
      challenge.dispatchEvent(new Event("change", { bubbles: true }));
      draw();
    });
    const opt = challenge.selectedOptions[0];
    const date = opt?.textContent?.match(/\(([^)]*)\)\s*$/)?.[1] ?? "";
    $("ss-why").hidden = !challenge.value;
    $("ss-why").textContent = challenge.value ? challengeLine(challenge.value, $("chstory").textContent ?? "", date) : "";
  };

  // Set sail: the crossing starts as it always has (#go's own listener reads the controls);
  // Annapolis goes through startVoyage, which reloads into practice with these choices.
  $("go").addEventListener(
    "click",
    (e) => {
      if (where !== "annapolis") return;
      e.stopImmediatePropagation();
      void hooks.start({ ...hooks.current(), where: "annapolis", course: course as SetSail["course"], breeze: breeze as SetSail["breeze"], challenge: "" });
    },
    true,
  );
  // Change: the same as the top bar's "My boat" chip (it opens the boat picker); a new "my boat"
  // ticks its row here, and a design with no row reloads the page into it.
  $("ss-change").addEventListener("click", () => document.getElementById("topbar-boat")?.click());
  onMyBoatChange((b: MyBoat | null) => {
    const v = !b || (b.kind === "yard" && b.base === "kayak" && b.hash === "") ? "" : b.kind === "stock" ? b.base : "mine";
    const row = document.querySelector<HTMLInputElement>(`input[name="boat"][value="${v}"]`);
    if (!row || v === "mine") {
      location.reload();
      return;
    }
    row.checked = true;
    row.dispatchEvent(new Event("change", { bubbles: true }));
    draw();
  });
  launch.addEventListener("change", draw);
  challenge.addEventListener("change", () => setTimeout(draw)); // after the helm's own showChallenge
  document.getElementById("boats")?.addEventListener("change", draw);
  draw();
  void hooks.challengesReady.then(draw);
}
