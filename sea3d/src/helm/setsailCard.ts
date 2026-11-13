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
import type { IndexEntry } from "../replay/data";
import { WHO_WORDS, watchDay, watchDays, type Who } from "./whoSteers";

/** Leo's words for the card (one-game-words.md §3); SET_SAIL's keys are Rosa's contract. */
export const CARD_WORDS = {
  where: { ocean: ["Across the Atlantic to Portugal", "5,256 km"], annapolis: ["Annapolis practice course", ""] },
  when: { calm: ["Calm", "23 Apr 2020"], rough: ["Rough", "1 Apr 2020"] },
  /** Annapolis (M1 piece 3, Leo): one plain line for the picked course, and the wind as the strip says it. */
  course: {
    triangle: "Three marks 800 m apart: into the wind, across, and back (about 15 min).",
    light: "About 7 km down the Bay, finishing east of the lighthouse.",
    drill: "Short spells: a reach, a beat and a run.",
  } as Record<string, string>,
  wind: { light: ["Light", "8 kn"], good: ["Steady", "12 kn"], fresh: ["Strong", "18 kn"] } as Record<string, readonly [string, string]>,
  /** More options (Elena, Leo): how you steer, with one line for the picked way. */
  steer: [
    ["hands_on", "Hands on", "Your orders reach her at once, and you always see where she is."],
    ["base", "From home, by satellite", "One order a day, as a real robot boat is steered. It arrives about a day later, and you see only her last report."],
  ] as [string, string, string][],
  /** On/off choices: the box they drive, the pill, and the line shown while it's on. */
  toggles: [
    ["breakdowns", "Breakdowns", "Parts can fail at sea, with the same luck for you and the autopilot."],
    ["safe", "Save the battery", "She slows down when her battery runs low, as the autopilot does."],
  ] as [string, string, string][],
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
  /** Your best time on a course in a wind ("14:32"), or null before a first finish. */
  best?: (course: string, breeze: string) => string | null;
  /** Who steers (M2, R2): the pick the page opens on, the voyages the autopilot has sailed, and how to go and watch one. */
  who?: { who: Who; day: string };
  voyages?: Promise<IndexEntry[]>;
  watch?: (file: string) => void;
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
  // Open on the page's own choices: a practice page (?practice, ?where=annapolis) opens with
  // Annapolis picked and the course and breeze it last sailed (M1 piece 3).
  const at = hooks.current();
  let where: SetSail["where"] = at.where;
  let course: string = at.course || SET_SAIL.course[0].key;
  let breeze: string = at.breeze;
  let allChallenges = false;
  let allDays = false;
  // Who steers: you (as always), or the autopilot all the way. The row shows once we know she has voyages to watch.
  let who: Who = hooks.who?.who ?? "you";
  let day = hooks.who?.day ?? "";
  let sailed: IndexEntry[] = [];
  /** The voyage Set sail opens with the autopilot steering; null with you steering, or when she hasn't sailed that day. */
  let voyage: string | null = null;
  const launch = $<HTMLSelectElement>("launch");
  const challenge = $<HTMLSelectElement>("challenge");
  const more = $<HTMLDetailsElement>("more");

  const checkedBoat = () => document.querySelector<HTMLInputElement>('input[name="boat"]:checked');
  const draw = () => {
    const s = { ...hooks.current(), where, challenge: where === "ocean" ? challenge.value : "" };
    const show = implied(s);
    hooks.preview?.(where);
    // The top bar's chip names the boat you'll sail: the practice boat while Annapolis is picked.
    document.dispatchEvent(new CustomEvent("bluewater:chip", { detail: { practice: where !== "ocean" } }));
    // Your boat: the ticked radio's name (the player's own text for a Boatyard design: textContent).
    $("ss-boatname").textContent = checkedBoat()?.parentElement?.querySelector("b")?.textContent ?? "Our kayak";
    // Practice always sails the club's yacht: say so, so nobody wonders where their boat went (Ines).
    $("ss-boat").hidden = !show.boatShown;
    $("ss-practiceboat").hidden = show.boatShown;
    pills($("ss-where-opts"), SET_SAIL.where.filter((o) => o.key === "ocean" || ANNAPOLIS_ON_CARD).map((o) => ({ key: o.key, label: CARD_WORDS.where[o.key][0], sub: CARD_WORDS.where[o.key][1] || undefined })), where, (k) => {
      where = k as SetSail["where"];
      draw();
    });
    // Who steers: only for the crossing (practice is always you), and only when there are voyages to watch here.
    const whoShown = where === "ocean" && !!hooks.watch && sailed.length > 0;
    const auto = whoShown && who === "autopilot";
    $("ss-who").hidden = !whoShown;
    pills($("ss-who-opts"), (["you", "autopilot"] as const).map((k) => ({ key: k, label: WHO_WORDS[k].pill })), auto ? "autopilot" : "you", (k) => {
      who = k as Who;
      draw();
    });
    $("ss-who-line").textContent = WHO_WORDS[auto ? "autopilot" : "you"].line;
    $("ss-after").textContent = WHO_WORDS[auto ? "autopilot" : "you"].after;
    // Annapolis: the course and the breeze instead of the boat, the day and the challenge.
    $("ss-course").hidden = !show.courseShown;
    // The crossing's options (how you steer, breakdowns, the battery) don't apply to practice, or to a voyage the autopilot steers.
    more.hidden = show.courseShown || auto;
    pills($("ss-course-opts"), SET_SAIL.course.map((o) => ({ key: o.key, label: o.label })), course, (k) => {
      course = k;
      draw();
    });
    const best = hooks.best?.(course, breeze);
    $("ss-course-line").textContent = `${CARD_WORDS.course[course] ?? ""}${best ? ` Your best: ${best}.` : ""}`;
    pills($("ss-breeze-opts"), SET_SAIL.breeze.map((o) => ({ key: o.key, label: CARD_WORDS.wind[o.key]?.[0] ?? o.label, sub: CARD_WORDS.wind[o.key]?.[1] ?? o.sub })), breeze, (k) => {
      breeze = k;
      draw();
    });
    // Launch day: Calm, Rough, or another day from the full list.
    $("ss-when").hidden = !show.whenShown;
    // With the autopilot: the days she has sailed, as plain dates (no hint of how each ends: finding out is the point).
    const days = auto ? watchDays(sailed, checkedBoat()?.value ?? "") : [];
    const on = auto ? watchDay(days, day) : null;
    voyage = on?.file ?? null;
    $("ss-when-line").hidden = !auto || !!on;
    $("ss-when-line").textContent = auto && !on ? WHO_WORDS.none : "";
    $("go").toggleAttribute("aria-disabled", auto && !on);
    const lv = launch.value;
    const named = lv === "2020-04-23" ? "calm" : lv === "0" ? "rough" : lv;
    // "Pick a day…" opens the other launch days as pills of their own, like the challenges' "More…"
    // (M1 piece 5: the card is the one place to pick; the old list stays hidden as the card's source).
    const others = Array.from(launch.options)
      .filter((o) => o.value !== "2020-04-23" && o.value !== "0")
      .map((o) => ({ key: o.value, label: (o.textContent ?? "").replace(/:.*$/, "").replace(/ 2020$/, "").replace(/(\d+) (\w{3})\w*/, "$1 $2") }));
    const showDays = allDays || (named !== "calm" && named !== "rough");
    if (auto)
      pills($("ss-when-opts"), days.map((d) => ({ key: d.day, label: `${d.label} ${d.year}` })), on?.day ?? "", (k) => {
        day = k;
        draw();
      });
    else pills(
      $("ss-when-opts"),
      [
        { key: "calm", label: CARD_WORDS.when.calm[0], sub: CARD_WORDS.when.calm[1] },
        { key: "rough", label: CARD_WORDS.when.rough[0], sub: CARD_WORDS.when.rough[1] },
        ...(showDays ? others : [{ key: "\u2026", label: "Pick a day\u2026" }]),
      ],
      named,
      (k) => {
        if (k === "\u2026") {
          allDays = true;
          draw();
          return;
        }
        launch.value = k === "calm" ? "2020-04-23" : k === "rough" ? "0" : k;
        launch.dispatchEvent(new Event("change", { bubbles: true }));
        draw();
      },
    );
    // Weather challenge (optional): None, then each challenge; the one-line why under it.
    $("ss-ch").hidden = where !== "ocean" || auto || challenge.options.length < 2;
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
    // More options: how you steer, and two on/off pills, over the helm's own radios and boxes (Elena).
    const mode = document.querySelector<HTMLInputElement>('input[name="mode"]:checked')?.value ?? "hands_on";
    pills($("ss-mode-opts"), CARD_WORDS.steer.map(([key, label]) => ({ key, label })), mode, (k) => {
      const r = document.querySelector<HTMLInputElement>(`input[name="mode"][value="${k}"]`);
      if (r) {
        r.checked = true;
        r.dispatchEvent(new Event("change", { bubbles: true })); // the helm turns Save the battery on for satellite steering
      }
      draw();
    });
    $("ss-mode-line").textContent = CARD_WORDS.steer.find(([key]) => key === mode)?.[2] ?? "";
    const box = $("ss-toggles");
    box.replaceChildren();
    for (const [id, label, line] of CARD_WORDS.toggles) {
      const cb = $<HTMLInputElement>(id);
      const one = document.createElement("div");
      pills(one, [{ key: "x", label, sub: cb.checked ? "On" : "Off" }], cb.checked ? "x" : "", () => {
        cb.checked = !cb.checked;
        cb.dispatchEvent(new Event("change", { bubbles: true }));
        draw();
      });
      const b = one.firstElementChild as HTMLElement;
      b.title = line;
      box.append(b);
    }
    $("ss-toggle-line").textContent = CARD_WORDS.toggles.map(([id, , line]) => ($<HTMLInputElement>(id).checked ? line : "")).filter(Boolean).join(" ");
  };

  // Set sail: the crossing starts as it always has (#go's own listener reads the controls);
  // Annapolis goes through startVoyage, which reloads into practice with these choices.
  $("go").addEventListener(
    "click",
    (e) => {
      // With the autopilot steering, Set sail opens her voyage of that day on this same screen.
      if (where === "ocean" && who === "autopilot" && hooks.watch && sailed.length > 0) {
        e.stopImmediatePropagation();
        if (voyage) hooks.watch(voyage);
        return;
      }
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
  // More options scrolls inside the card when it would run off the window (Elena). On a phone, where
  // the card sits low and little is left, the whole card scrolls instead, More options brought into view.
  const fitMore = () => {
    const body = $("more-body");
    const card = $("ss-card");
    body.style.maxHeight = "";
    card.style.overflowY = "";
    if (!more.open) return;
    const left = window.innerHeight - 16 - body.getBoundingClientRect().top - (parseFloat(getComputedStyle(card).paddingBottom) || 0);
    if (left >= 160) body.style.maxHeight = `${Math.floor(left)}px`;
    else {
      card.style.overflowY = "auto";
      more.scrollIntoView({ block: "start" });
    }
  };
  more.addEventListener("toggle", fitMore);
  window.addEventListener("resize", fitMore);
  launch.addEventListener("change", draw);
  challenge.addEventListener("change", () => setTimeout(draw)); // after the helm's own showChallenge
  document.getElementById("boats")?.addEventListener("change", draw);
  draw();
  void hooks.challengesReady.then(draw);
  void hooks.voyages?.then((v) => {
    sailed = v;
    draw();
  });
}
