// The Boatyard in a player's words (audit item 10; Milo and Ines, 12 Nov). The data
// files keep the team's own shorthand ("GUESS" marks an estimate in the code and
// in Theo's slot table); this is what a player reads.
import type { Catalog } from "./design";

/** An option's name without "(as built)": the "As built" badge already says it. */
export function optionName(n: string): string {
  return n
    .replace(/\s*\(as built\)/gi, "")
    .replace(/,\s*as built\)/gi, ")")
    .trim();
}

/** A description or basis line with the team's shorthand turned into plain words. */
export function playerWords(s: string): string {
  return s
    .replace(/\bthe v4 kayak as modelled\b/gi, "As on our kayak.")
    .replace(/\bGUESSes\b/g, "estimates")
    .replace(/\(GUESS\)/g, "(our estimate)")
    .replace(/\ba GUESS\b/g, "our estimate")
    .replace(/\bGUESS\b/g, "estimate")
    .replace(/^As on our kayak\.\.$/, "As on our kayak.");
}

/** A part's description as a sentence (Milo): the badge already says "Planned", the
 *  team's notes start in lower case and join with semicolons. */
export function sentence(s: string): string {
  let t = playerWords(s)
    .replace(/^Planned\.\s*/, "")
    .replace(/\bRandolph's Rev B\b/g, "the Randolph team's Rev B")
    .replace(/; (no motors|motors hold)/g, (_, w: string) => `. ${w[0].toUpperCase()}${w.slice(1)}`)
    .trim();
  if (!t) return t;
  t = t[0].toUpperCase() + t.slice(1);
  return /[.!?)]$/.test(t) ? t : `${t}.`;
}

/** One line for a row, the detail behind its "i" (Ines, 12 Nov): the kayak's wing options. */
const ROW_COPY: Record<string, { d: string; more: string }> = {
  "drive/wing-sail": { d: "A rigid wing and no motors, so it tacks upwind.", more: "Scaled from the Randolph team's Rev B. Size, weight and breakage are our estimates." },
  "drive/hybrid": { d: "A rigid wing, with the motors holding course upwind.", more: "Scaled from the Randolph team's Rev B. Size, weight and breakage are our estimates." },
};

/** The catalog as a player reads it: every option's name and description tidied. */
export function tidyCatalog(c: Catalog): Catalog {
  return {
    ...c,
    slots: c.slots.map((s) => ({
      ...s,
      opts: s.opts.map((o) => {
        const row = ROW_COPY[`${s.id}/${o.id}`];
        const more = row?.more ?? (o.more ? playerWords(o.more) : undefined);
        return { ...o, n: optionName(o.n), d: row?.d ?? (o.d ? sentence(o.d) : o.d), ...(more ? { more } : {}) };
      }),
    })),
  };
}
