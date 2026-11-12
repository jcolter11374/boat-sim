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

/** The catalog as a player reads it: every option's name and description tidied. */
export function tidyCatalog(c: Catalog): Catalog {
  return {
    ...c,
    slots: c.slots.map((s) => ({
      ...s,
      opts: s.opts.map((o) => ({ ...o, n: optionName(o.n), d: o.d ? playerWords(o.d) : o.d, ...(o.more ? { more: playerWords(o.more) } : {}) })),
    })),
  };
}
