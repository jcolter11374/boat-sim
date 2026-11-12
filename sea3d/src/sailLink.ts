/**
 * The Sea page's way into the game: "Sail this sea" opens Take the helm in
 * weather like the sea on screen, and "Build a boat" opens the Boatyard.
 *
 * The helm sails real past weather, so "this sea" maps the Sea page's three sea
 * states to the helm's own weather (Leo, 11 Nov): Calm opens the "Gentle June"
 * challenge (seas never top 3 m), Gale opens "Spring gale" (6.7 m seas), and
 * Moderate opens the usual 2020 launch. The helm preselects the challenge from
 * `?challenge=<id>`; the player still checks the start card and sets sail.
 */

/** The helm challenge for each sea state on the Sea page; null = the usual launch. */
export const SEA_CHALLENGE: Record<string, string | null> = {
  calm: "gentle-june",
  moderate: null,
  gale: "spring-gale",
};

/**
 * Where "Sail this sea" goes for a sea state (relative to the site root). A
 * quality other than the default High carries over, so a player on Low (or the
 * tests, on software graphics) arrives at the helm on the same setting.
 */
export function helmHref(sea: string, quality = "high"): string {
  const q = new URLSearchParams();
  const id = SEA_CHALLENGE[sea] ?? null;
  if (id) q.set("challenge", id);
  if (quality && quality !== "high") q.set("quality", quality);
  const s = q.toString();
  return s ? `./helm.html?${s}` : "./helm.html";
}

/**
 * The challenge a helm link asks for, if it is one the picker offers. A shared
 * game carries its own weather, so it never takes one.
 */
export function askedChallenge(search: string, offered: string[], shared: boolean): string | null {
  if (shared) return null;
  const id = new URLSearchParams(search).get("challenge");
  return id && offered.includes(id) ? id : null;
}

/** Keep the Sea page's "Sail this sea" link in step with its sea-state picker. */
export function mountSailLink(doc: Document = document): void {
  const a = doc.getElementById("sail") as HTMLAnchorElement | null;
  const sel = doc.getElementById("sea") as HTMLSelectElement | null;
  const quality = doc.getElementById("quality") as HTMLSelectElement | null;
  if (!a || !sel) return;
  const draw = () => {
    a.href = helmHref(sel.value, quality?.value);
  };
  draw();
  sel.addEventListener("change", draw);
  quality?.addEventListener("change", draw);
  // The page itself can drop Ultra to High when it's too slow, without a change event.
  a.addEventListener("click", draw);
}
