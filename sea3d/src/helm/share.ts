/** Copying the share link without ever leaving the player waiting.
 *
 * The clipboard can refuse (no permission, an older browser, a page that isn't
 * secure) or, in some browsers, sit on a permission prompt and never answer.
 * So the link is always shown as text the player can select first, and the copy
 * gets at most `waitMs`: if it hasn't finished by then, the shown link is the
 * answer (#293). */

export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/** True if the text reached the clipboard within waitMs; false if it was
 *  refused, there is no clipboard, or it took too long. Never rejects. */
export function copyText(text: string, clipboard: ClipboardLike | undefined | null, waitMs = 1500): Promise<boolean> {
  if (!clipboard || typeof clipboard.writeText !== "function") return Promise.resolve(false);
  let copy: Promise<boolean>;
  try {
    copy = clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  } catch {
    return Promise.resolve(false); // threw instead of rejecting
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), waitMs);
  });
  return Promise.race([copy, late]).finally(() => clearTimeout(timer));
}
