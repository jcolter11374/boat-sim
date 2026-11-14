// "My boat": the one boat the player is working on, remembered in this browser
// and carried to every page (Boatyard, helm, race, voyage). Step 1 of the
// one-game plan (/mnt/project-files/simulator/unified-game-proposal.md).
//
//   import { loadMyBoat, saveMyBoat, clearMyBoat, onMyBoatChange, myBoatYardLink } from "./myboat";
//   saveMyBoat({ kind: "yard", base: "revc", hash: "#base=revc&rudder=single", name: "Rev C, one rudder", choices });
//   const b = loadMyBoat();            // null if none saved (or the saved one is unreadable)
//   const off = onMyBoatChange((b) => ...);   // this tab and other tabs; call off() to stop
//   myBoatYardLink(b);                 // "boatyard.html#base=revc&rudder=single", reopens it in the Boatyard
//
// Stored in localStorage under one key, as JSON with a version number. Nothing
// leaves the browser (no accounts, no server: the project stays free). If the
// browser won't store anything (private mode, storage off, quota full), the
// boat is kept in memory for this page instead, so nothing throws.

/** Where a boat comes from. "yard": a Boatyard design (our kayak or our model of
 *  the Randolph Rev B / Rev C, with the player's part picks). "stock": a stock
 *  boat as it comes (configs/stock_*.yaml), e.g. the 31 ft cruiser. */
export type MyBoatKind = "yard" | "stock";

export interface MyBoat {
  kind: MyBoatKind;
  /** The boat it starts from: "kayak", "revb" or "revc" for a Boatyard design;
   *  the stock boat's id for a stock boat (e.g. "stock_cruiser31"). */
  base: string;
  /** The Boatyard share hash that rebuilds the design ("" = the planned kayak,
   *  "#base=revc&rudder=single", ...). Empty for a stock boat. */
  hash: string;
  /** The player's name for it, or a plain description. */
  name: string;
  /** What the simulator needs to sail it (the Boatyard's simChoices, or
   *  {base: "stock_cruiser31"}), so pages that sail it needn't load the catalog. */
  choices: Record<string, string | number>;
  /** When it was saved (ISO time). Filled in by saveMyBoat. */
  saved: string;
}

/** The storage key. The trailing version changes only if the format can't be read the old way. */
export const MYBOAT_KEY = "boatsim.myboat.v1";
/** The event this tab fires on window when the boat changes (other tabs get the browser's "storage" event). */
export const MYBOAT_EVENT = "boatsim-myboat";

/** The bits of the Web Storage API used here (window.localStorage, or a stand-in in tests). */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let memory: string | null = null; // the fallback when the browser won't store anything

function store(): StorageLike | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null; // some browsers throw just for touching localStorage with storage off
  }
}

function read(s: StorageLike | null): string | null {
  if (s) {
    try {
      const v = s.getItem(MYBOAT_KEY);
      if (v !== null) return v;
    } catch {
      // unreadable: use the in-memory copy
    }
  }
  return memory;
}

/** A saved boat if `raw` is one this version can use, else null. */
export function parseMyBoat(raw: string | null): MyBoat | null {
  if (!raw) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object") return null;
  const b = o as Record<string, unknown>;
  if (b.v !== 1) return null;
  if (b.kind !== "yard" && b.kind !== "stock") return null;
  if (typeof b.base !== "string" || !b.base) return null;
  if (
    typeof b.hash !== "string" ||
    typeof b.name !== "string" ||
    typeof b.saved !== "string"
  )
    return null;
  const choices = b.choices;
  if (!choices || typeof choices !== "object" || Array.isArray(choices))
    return null;
  for (const v of Object.values(choices))
    if (typeof v !== "string" && typeof v !== "number") return null;
  return {
    kind: b.kind,
    base: b.base,
    hash: b.hash,
    name: b.name,
    choices: { ...(choices as Record<string, string | number>) },
    saved: b.saved,
  };
}

/** The player's boat, or null if none is saved. */
export function loadMyBoat(s: StorageLike | null = store()): MyBoat | null {
  return parseMyBoat(read(s));
}

function announce(b: MyBoat | null): void {
  if (typeof window === "undefined" || typeof CustomEvent === "undefined")
    return;
  window.dispatchEvent(
    new CustomEvent<MyBoat | null>(MYBOAT_EVENT, { detail: b }),
  );
}

/** Remember this boat as the player's (replacing any other) and tell the page. Returns what was saved. */
export function saveMyBoat(
  b: Omit<MyBoat, "saved"> & { saved?: string },
  s: StorageLike | null = store(),
  now: Date = new Date(),
): MyBoat {
  const boat: MyBoat = {
    kind: b.kind,
    base: b.base,
    hash: b.hash,
    name: b.name,
    choices: { ...b.choices },
    saved: b.saved ?? now.toISOString(),
  };
  const raw = JSON.stringify({ v: 1, ...boat });
  memory = raw;
  if (s) {
    try {
      s.setItem(MYBOAT_KEY, raw);
    } catch {
      // full or switched off: the in-memory copy carries it for this page
    }
  }
  announce(boat);
  return boat;
}

/** Forget the player's boat. */
export function clearMyBoat(s: StorageLike | null = store()): void {
  memory = null;
  if (s) {
    try {
      s.removeItem(MYBOAT_KEY);
    } catch {
      // nothing to do
    }
  }
  announce(null);
}

/** Call `cb` whenever the player's boat changes, from this tab or another one.
 *  Returns a function that stops listening. */
export function onMyBoatChange(cb: (b: MyBoat | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const here = (e: Event) =>
    cb((e as CustomEvent<MyBoat | null>).detail ?? null);
  const other = (e: StorageEvent) => {
    if (e.key === MYBOAT_KEY || e.key === null) cb(parseMyBoat(e.newValue)); // key null: storage cleared
  };
  window.addEventListener(MYBOAT_EVENT, here);
  window.addEventListener("storage", other);
  return () => {
    window.removeEventListener(MYBOAT_EVENT, here);
    window.removeEventListener("storage", other);
  };
}

/** The Boatyard page that reopens this boat, relative to the site root
 *  ("boatyard.html#base=revc&rudder=single"). A stock boat opens the Boatyard as it is. */
export function myBoatYardLink(b: MyBoat): string {
  return b.kind === "yard" ? `boatyard.html${b.hash}` : "boatyard.html";
}

/** Our models of the Randolph team's boats, unchanged in the Boatyard: picked straight from the boat
 * picker, saved as a Boatyard design on that base so every page sails it (John, 13 Nov: every built
 * boat in Set sail). The Rev B is their earlier boat as built; the Rev C5 their current design. */
export const RANDOLPH_AS_BUILT = {
  revb: { kind: "yard", base: "revb", hash: "#base=revb", name: "Randolph Rev B (our model)", choices: { base: "revb" } },
  revc: { kind: "yard", base: "revc", hash: "#base=revc", name: "Randolph Rev C5 (our model)", choices: { base: "revc" } },
} as const;
export type RandolphKey = keyof typeof RANDOLPH_AS_BUILT;
/** Which Randolph boat this is, unchanged, or null for anything else (a changed design included). */
export function randolphAsBuilt(b: MyBoat | null): RandolphKey | null {
  if (!b || b.kind !== "yard") return null;
  for (const k of Object.keys(RANDOLPH_AS_BUILT) as RandolphKey[]) if (b.base === k && b.hash === RANDOLPH_AS_BUILT[k].hash) return k;
  return null;
}
