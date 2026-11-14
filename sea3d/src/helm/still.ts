// The title's last picture of the sea, shown behind the helm page while it loads (Elena, 14 Nov:
// Set sail from the title gave about 9 s of plain navy page on a slow computer before the helm's sea).
// The title saves a small copy of its picture as it leaves; helm.html's first inline script puts it
// behind the page before anything else has loaded, and the helm takes it away at its own first frame.

/** Where the picture waits for the next page, for one use. helm.html reads the same key. */
export const STILL_KEY = "boatsim.helm.still";
/** A picture older than this is from some other visit, not the one just left. */
export const STILL_MAX_AGE_MS = 120_000;
/** Wide enough to read as the same scene behind the card, small enough to save at once (about 30 KB). */
const STILL_WIDTH = 640;

/** What the helm page needs: the picture, and where on the window it was (the title's menu covers its left side). */
export interface Still {
  src: string;
  /** Left edge, width and height as fractions of the window. */
  x: number;
  w: number;
  h: number;
  /** The link it left by: the plain Set sail card fills in at full size. */
  kind: "setsail" | "continue";
  at: number;
}

/** Save the canvas's current picture for the helm page (the title draws with preserveDrawingBuffer, so it can be read at any time). */
export function saveStill(canvas: HTMLCanvasElement, kind: Still["kind"]): void {
  try {
    const r = canvas.getBoundingClientRect();
    if (!canvas.width || !canvas.height || !r.width || !r.height) return;
    const small = document.createElement("canvas");
    small.width = Math.min(STILL_WIDTH, canvas.width);
    small.height = Math.round((small.width * canvas.height) / canvas.width);
    const g = small.getContext("2d");
    if (!g) return;
    g.drawImage(canvas, 0, 0, small.width, small.height);
    const still: Still = { src: small.toDataURL("image/jpeg", 0.72), x: r.left / innerWidth, w: r.width / innerWidth, h: r.height / innerHeight, kind, at: Date.now() };
    sessionStorage.setItem(STILL_KEY, JSON.stringify(still));
  } catch {
    /* private mode or a full store: the helm page opens on its plain navy, as before */
  }
}
