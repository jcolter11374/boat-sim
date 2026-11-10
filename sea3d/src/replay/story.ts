// "Pick your launch day": the story beats of one voyage, in plain English.
//
// Everything here comes from the replay file (the simulator's log). A beat is
// a moment worth stopping for: launch, the race start, the first knockdown of
// each storm, each part that breaks, the radio going quiet, halfway, the last
// 500 km. No sailing words: John and anyone he shows it to should follow it.

import { commsAt, distanceKm, failedPart, lastHour, partText, positionAt, type Replay } from "./data";
import type { Tone } from "./data";

export interface Beat {
  h: number; // voyage hour
  kind: string;
  title: string;
  text: string;
  tone: Tone;
}

/** True for our model of the Randolph boat (a sailboat), false for our kayak. */
export const isSailboat = (rep: Replay) => /randolph/i.test(rep.boat);

/** Who is sailing, in words. The Randolph boat is always "our model". */
export const boatName = (rep: Replay) => (isSailboat(rep) ? "Our model of the Randolph boat" : "Our kayak");

/** Storms closer together than this count as the same storm. */
const STORM_GAP_H = 48;
/** At most this many storm beats, so a stormy voyage still moves along. */
const MAX_STORMS = 3;
/** The radio has to stay quiet this long before it's worth a beat. */
const QUIET_H = 24;

/** km from the target circle's edge (0 inside it). */
function kmToGo(rep: Replay, hour: number): number {
  const p = positionAt(rep, hour);
  if (!Number.isFinite(p[0])) return NaN;
  return Math.max(distanceKm(p, rep.course.target) - rep.course.target_radius_m / 1000, 0);
}

const fmtKm = (km: number) => Math.round(km).toLocaleString("en-GB");

export function storyBeats(rep: Replay): Beat[] {
  const beats: Beat[] = [];
  const sail = isSailboat(rep);
  const start = kmToGo(rep, 0);
  beats.push({
    h: 0,
    kind: "launch",
    title: "Launched!",
    text:
      `${boatName(rep)} is in the water, ${Number.isFinite(start) ? fmtKm(start) + " km" : "a long way"} from the finish off Portugal. ` +
      "From here it's on its own: nobody can go out and rescue it.",
    tone: "info",
  });

  // From the log's events.
  const parts = new Set<string>();
  let lastStorm = -Infinity;
  let storms = 0;
  for (const e of rep.events) {
    if (e.kind === "start_line") {
      beats.push({
        h: e.h,
        kind: e.kind,
        title: "The race is on",
        text: "It crossed the race's starting line out at sea. From now on the clock is running.",
        tone: "good",
      });
    } else if (e.kind === "capsize") {
      const fresh = e.h - lastStorm > STORM_GAP_H;
      lastStorm = e.h;
      if (!fresh || storms >= MAX_STORMS) continue;
      storms++;
      const m = /Hs ([\d.]+) m/.exec(e.detail);
      const waves = m ? `Waves ${Math.round(Number(m[1]))} m high` : "Big waves";
      beats.push({
        h: e.h,
        kind: "storm",
        title: storms === 1 ? "Storm!" : "Another storm",
        text: `${waves} are knocking the boat flat. It's built to roll back upright, but every knock can break something.`,
        tone: "warn",
      });
    } else if (e.kind === "part_failed") {
      const { part } = failedPart(e);
      // Both hull leak events read the same, so they count once.
      const key = part.startsWith("leak") ? "leak" : part;
      if (parts.has(key)) continue;
      parts.add(key);
      beats.push({ h: e.h, kind: "broke", title: "Something broke", text: partText(e, rep.boat), tone: "warn" });
    }
  }

  // The radio going quiet, from the hourly comms columns (first time each way).
  let quietFrom = -1;
  let quietKind: "beacon" | "silent" | null = null;
  const said = new Set<string>();
  for (let i = 0; i < rep.h.length; i++) {
    const c = commsAt(rep, rep.h[i]);
    const quiet = c === "beacon" || c === "silent" ? c : null;
    if (quiet && quietKind !== quiet) {
      quietFrom = rep.h[i];
      quietKind = quiet;
    } else if (!quiet) {
      quietKind = null;
    }
    if (quietKind && !said.has(quietKind) && rep.h[i] - quietFrom >= QUIET_H) {
      said.add(quietKind);
      beats.push(
        quietKind === "beacon"
          ? {
              h: quietFrom,
              kind: "quiet",
              title: "Gone quiet",
              text: `The satellite radio isn't getting through. The small backup ${sail ? "tracker" : "beacon"} still sends its position every few hours, so we can follow it.`,
              tone: "warn",
            }
          : {
              h: quietFrom,
              kind: "silent",
              title: "Total silence",
              text: "Nothing from the boat at all. If it stays silent for more than 10 days, the race rules count it out.",
              tone: "warn",
            },
      );
    }
  }

  // Halfway and the last stretch, by distance to the finish.
  if (Number.isFinite(start) && start > 0) {
    let half = false;
    let near = false;
    for (const h of rep.h) {
      const km = kmToGo(rep, h);
      if (!Number.isFinite(km)) continue;
      if (!half && km <= start / 2) {
        half = true;
        beats.push({ h, kind: "halfway", title: "Halfway there!", text: `${fmtKm(km)} km to go.`, tone: "good" });
      }
      if (!near && km <= 500 && start > 1000) {
        near = true;
        beats.push({
          h,
          kind: "near",
          title: "The last stretch",
          text: "Less than 500 km to the finish. The coast of Portugal is not far beyond it.",
          tone: "good",
        });
      }
    }
  }
  // The log's last row can come a little before its last events: pull those
  // beats back so the player (which stops at the last row) still shows them.
  const end = lastHour(rep);
  for (const b of beats) b.h = Math.min(b.h, end);
  // Keep the launch first even if an event shares hour 0.
  beats.sort((a, b) => a.h - b.h || (a.kind === "launch" ? -1 : b.kind === "launch" ? 1 : 0));
  // Parts that break in the same hour (one cause) make one beat.
  const out: Beat[] = [];
  for (const b of beats) {
    const prev = out[out.length - 1];
    if (prev && prev.kind === "broke" && b.kind === "broke" && b.h - prev.h < 1) {
      prev.title = "Several things broke";
      prev.text += " " + b.text;
    } else out.push(b);
  }
  return out;
}

/** The guess against what happened. guess: true = "it will finish". */
export function guessVerdict(rep: Replay, guess: boolean): { right: boolean; title: string; text: string } {
  const finished = rep.outcome === "arrived";
  const right = guess === finished;
  const title = right ? "You called it!" : "Not this time";
  const said = guess ? "you said it would make it" : "you said it wouldn't make it";
  const did = finished ? "and it did" : "and it didn't";
  const butDid = finished ? "but it did" : "but it didn't";
  return { right, title, text: `${said[0].toUpperCase()}${said.slice(1)}, ${right ? did : butDid}.` };
}

/** One line for the postcard and the result card: what happened, in words. */
export function outcomeLine(rep: Replay): string {
  const d = Math.round(rep.days);
  switch (rep.outcome) {
    case "arrived":
      return `Made it to the finish off Portugal in ${d} days.`;
    case "timeout":
      return `Still at sea after ${d} days, when the simulation stopped.`;
    case "disqualified":
      return `Counted out after ${d} days: silent for too long.`;
    case "aground":
      return `Washed up on a shore after ${d} days.`;
    case "lost": {
      const last = [...rep.events].reverse().find((e) => e.kind === "lost");
      const why = /fishermen/i.test(last?.detail ?? "")
        ? "picked up or snagged by a fishing boat"
        : /electronics/i.test(last?.detail ?? "")
          ? "its computers died"
          : "lost at sea";
      return `Lost after ${d} days: ${why}.`;
    }
    default:
      return `Voyage over after ${d} days.`;
  }
}
