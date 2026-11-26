# The harbour behind the Set sail card is off for now (24 Nov 2026)

John, 24 Nov 2026, of the live Set sail screen with the Annapolis harbour behind it (#662): "it looks
terrible." His picture (Beneteau First 31.7, a 1911 x 898 window) shows the town as flat coloured boxes
that seem to stand in the water, a pale slab for the shore, the pier as a thick dark outline, and the
boat cut off in the bottom right corner.

## What changed

One line in `sea3d/src/helm.ts`: the dock scene is made only with `?dock=1`. Before, it was made
unless `?dock=0`. So the Set sail card opens on the open sea at the drop point, as it did before
#662, and Set sail starts there with no casting off.

Nothing is deleted. `helm.html?dock=1` shows the harbour and the casting off exactly as before, for
working on it. The arrival at a dock in Portugal (#668), which comes after the finish, is not touched.

## Why off, not fixed in place

The first screen of the game is the top priority (CLAUDE.md, 15 Nov), and what is wrong is not one
bug: the framing depends on the boat's size and the window's shape, the ground under the town is not
drawn as ground, and the buildings are plain boxes. It comes back when John has seen pictures of it
from his own PC and likes them.

## Checked

- Unit tests: 690 pass before and after.
- `sea3d/tools/qa/dock-launch.mjs` now asks for `dock=1` itself.
- The speed guard's `sailPrograms` baseline stays at 125 (raised for the harbour in #662, with John's
  yes). With the harbour off the count is back near 100, so the limit is loose until it returns.

Not measured: the load time saved by not loading the harbour (no graphics card in the cloud).
