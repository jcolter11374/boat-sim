// Which option Esc picks on a "Your call" card, and how the card says so (#654).
//
// Esc used to look for the word "autopilot" in a button's text and, finding none, press the LAST
// button. On the big-waves card the last button is "Slow down to 10% power", and "Hold course
// (same as the ghost)" has no "autopilot" in it, so Esc slowed the boat to 10% for the rest of the
// crossing (live play-through, 21 Nov 2026: 1,456 km behind the ghost at day 53). On the
// navigator's check "Take 095° (about what the autopilot does)" matched the word and Esc turned
// the boat off the autopilot.
//
// The rule now, from what each option does and not from its words:
//   1. the option that puts her on (or leaves her on) the autopilot, as the ghost sails;
//   2. else the option that changes nothing (hold course, keep your power, carry on);
//   3. else the first option. Never "whichever is last".
// The card's foot names the option by number, so Esc is never a guess.
//
// Pure rules, no page: tests/escChoice.test.ts.

/** What an option does, as far as Esc cares. */
export interface EscOption {
  /** It hands her to the autopilot, or leaves her on it. */
  auto: boolean;
  /** It changes nothing: the order and power she has now stand. */
  keep: boolean;
}

export type EscWhy = "auto" | "keep" | "first";

/** The option Esc picks (index, or -1 on an empty card) and why. */
export function escPick(options: EscOption[]): { index: number; why: EscWhy } {
  const auto = options.findIndex((o) => o.auto);
  if (auto >= 0) return { index: auto, why: "auto" };
  const keep = options.findIndex((o) => o.keep);
  if (keep >= 0) return { index: keep, why: "keep" };
  return { index: options.length ? 0 : -1, why: "first" };
}

/** The card's last line: "Keys 1-2, or Esc for the autopilot (1)." */
export function escFoot(count: number, pick: { index: number; why: EscWhy }): string {
  if (pick.index < 0) return "";
  const n = pick.index + 1;
  const esc = pick.why === "auto" ? `Esc for the autopilot (${n})` : pick.why === "keep" ? `Esc to carry on as you are (${n})` : `Esc for ${n}`;
  return `Keys 1-${count}, or ${esc}.`;
}
