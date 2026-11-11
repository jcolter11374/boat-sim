// The in-browser simulator's files (boatsim.zip and the 2020 weather bundle),
// published by sea3d.yml into public/sandbox/ from the sandbox-data release.

/** True when the page was published with the simulator files. A dev or preview
 *  server answers a missing file with its HTML page, not a 404, so HTML counts
 *  as missing. */
export async function sandboxThere(base: string): Promise<boolean> {
  try {
    const r = await fetch(new URL("boatsim.zip", base).href, { method: "HEAD" });
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch {
    return false;
  }
}
