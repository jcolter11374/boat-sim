// Build names a player reads (Leo, quality audit item 9). The names themselves are
// made in one place, the simulator's catalog.CHANGE_NAMES (src/boatsim/sandbox/catalog.py),
// and ship in boatyard/index.json ("label", and "note" for the "i"). Boards published
// before the names changed carry old labels, so the leaderboard takes the grid's name
// for any build the grid has. internalWords() is what the tests use to make sure no
// internal string ("solar-300", "Drive:", "GUESS", "(our model)") reaches the screen.

export interface BuildName {
  label: string;
  note?: string;
}

export interface GridIndex {
  slots?: Record<string, string[]>;
  builds: { id: string; label: string; note?: string }[];
}

/** id -> name from the Boatyard grid's index.json. */
export function namesFrom(index: GridIndex): Map<string, BuildName> {
  return new Map(index.builds.map((b) => [b.id, { label: b.label, ...(b.note ? { note: b.note } : {}) }]));
}

/** The grid's names, or an empty map when the index can't be read (the board's own labels stand). */
export async function loadNames(url = "./boatyard/index.json"): Promise<Map<string, BuildName>> {
  try {
    const r = await fetch(url);
    if (!r.ok) return new Map();
    return namesFrom((await r.json()) as GridIndex);
  } catch {
    return new Map();
  }
}

/** A build's name: the grid's when it has one, else the label it came with. */
export function nameOf(names: Map<string, BuildName>, id: string, label: string, note?: string): BuildName {
  return names.get(id) ?? { label, ...(note ? { note } : {}) };
}

const JARGON = [/\bGUESS/, /\bROUGH\b/, /\bOUR PICK\b/, /\(our model\)/, /\bas modell?ed\b/, /\bas published\b/, /\b\w[\w ]*: [a-z0-9]+-[a-z0-9-]+/, /\bW cruise\b/];

/** The internal words in a piece of on-screen text: option ids from the grid's slots
 *  (any with a hyphen or a digit, e.g. "solar-300", "one-box", "two-100ah"), and jargon. */
export function internalWords(text: string, slots: Record<string, string[]> = {}): string[] {
  const out: string[] = [];
  for (const ids of Object.values(slots))
    for (const id of ids) if (/[-\d]/.test(id) && new RegExp(`(^|[^\\w-])${id.replace(/[-]/g, "\\-")}($|[^\\w-])`).test(text)) out.push(id);
  for (const j of JARGON) {
    const m = j.exec(text);
    if (m) out.push(m[0]);
  }
  return out;
}
