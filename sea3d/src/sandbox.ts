// The in-browser simulator's files: boatsim.zip, packed by sea3d.yml from the
// page's own commit (so the page and its simulator always match), and the 2020
// weather bundle, which sea3d.yml fetches from the sandbox-data release.

/** One file is there: a dev or preview server answers a missing file with its
 *  HTML page, not a 404, so HTML counts as missing. */
async function there(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}

/** True when the page was published with both simulator files. The zip is
 *  always packed now, but the weather bundle can be missing (no release yet,
 *  or a failed download), and the simulator can't sail without it. */
export async function sandboxThere(base: string): Promise<boolean> {
  const [zip, weather] = await Promise.all([there(new URL("boatsim.zip", base).href), there(new URL("forcing_2020.npz", base).href)]);
  return zip && weather;
}
