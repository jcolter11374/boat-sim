# Title screen load on a real graphics card, 15 Nov 2026

Goal (John, 15 Nov 2026): for now the priority is a **fast title screen with no stutter**. The
ocean-crossing realism stays in, but it is not the focus at the moment.

Measured on John's PC: GTX 1660 Ti, Chrome 157 via ANGLE on Direct3D 11, 1600x900 window, quality
High. The site measured was the live site, https://jcolter11374.github.io/boat-sim/, at main
`4b3126fd` (PR #640). The cloud runners have no graphics card, so they cannot see any of this. These
numbers come only from a real card.

No code has been changed yet. This note records the starting point, so later fixes can be measured
against it.

## What a first-time visitor sees

| Time after opening | What happens |
|---|---|
| 0.1 s | The title card shows, over a blurred gradient placeholder ([picture](screens/title-load-2026-11-15/at-1.5s.png)) |
| 0.7 s | The detailed kayak has loaded; `startWhenBuilt` (`sea3d/src/warmup.ts`) hands **43 shader programs** to the driver at once |
| 1.75 s | **0.85 s freeze** of the whole page. No page script runs during it: the browser's graphics process is busy building the shaders. |
| 1.75 to 5.0 s | Nothing is drawn. The page waits for every program to report it is ready. |
| 5.0 to 5.3 s | `drawEach` draws each object once (a few draws per frame) |
| ~5.3 s | The animation loop starts and the scene pops in ([picture](screens/title-load-2026-11-15/at-6.5s.png)). It then hitches for 167, 67, 50 and 150 ms over the next 1.3 s as the first real frames finish setting up shaders. |

On a **reload** (the browser has cached the built shaders), it is nearly clean: one 184 ms pause
while the page's script first runs, before anything moves, then 67 and 50 ms hitches near 0.5 s.

`?perf` totals over 16 s of fresh load: 801 frames, median 16.7 ms, 6 frames over 50 ms, 4 over
100 ms, worst 867 ms. Reload: 3 over 50 ms, 1 over 100 ms, worst 184 ms.

## What it means

- The warm-up system (`startWhenBuilt`, PRs #618, #638, #640) does what it was built for: no
  shader is built in the middle of moving frames. The cost is that **everything** is built before
  the first frame, and on Direct3D the 43 programs take about 4 s even on a decent card.
- The 0.85 s freeze happens while the card shows only the placeholder, so it shows up as a
  stuck page (no hover, no clicks) rather than a jerk in the sea.
- Returning visitors are mostly fine. The problem is the first visit, which is the one that
  counts.

## Next steps (proposed, not done)

1. **A real picture straight away.** Put a still of the title scene behind the card, then
   cross-fade to the live sea when it is ready. This hides the wait on every computer, slow ones
   included. The helm already does something like this (`helm/still.ts`).
2. **A shorter wait.** Build only what the opening shot needs (sea, sky, the kayak) before the
   first frame. Bring in the far ship, sailboat, shore and clouds afterwards with `addWhenBuilt`.

Each fix should be re-measured with the scripts below and added to this note as a before/after.

## 21 Nov 2026: the step down to Low locked the page for 6.7 s

Measured on John's PC (GTX 1660 Ti, Direct3D 11) through the Claude app's built-in browser, on the
live site at main `264bc4e` (after #643 and #644), with `?perf`.

- **What happened.** The browser pane was in the background, so it drew at about 20 frames a
  second. After two slow 3 s windows the title stepped itself down from High to Low (#644), as it
  is meant to on a slow computer. The step itself built **35 shaders inside one frame**, and that
  frame took **6.7 s**. Chrome's long-frame entry shows 6.66 s of it inside the frame's own script.
  Nothing on the page answered during it.
- **Why.** Low draws without the glow pass, so nearly every material needs another shader. They
  were all built by the first frame after the change, one after another, each waited for.
- **Who sees it.** Anyone whose computer is slow enough to be stepped down, which is who the step
  is for, and anyone who picks another look from the menu. Whether John sees it in ordinary Chrome
  is not known: there the title draws at 60 a second on his card and should not step down.
- **Fix (this PR).** `changeLook` in `sea3d/src/main.ts`: the drawing is held on its last picture,
  the new shaders are built as at the start (`startWhenBuilt`, a few a frame, the page answering
  meanwhile), and the drawing carries on when they are ready. The sea's clock is held too, so it
  carries on from where it stood.
- **Numbers.** `sea3d/tools/real-gpu/lookchange.mjs` with `SOFT=1` (cloud, software graphics, where
  one High frame alone takes about 1.4 s; only good for comparing): longest time the page could
  not answer **2.7 s before, 1.1 to 1.4 s after** (two runs each); the drawing carried on after 3.3 s
  before, 4.7 s after. **Not yet measured on a real card.** There the browser builds shaders off
  the page's thread, so the lock should nearly go; run `lookchange.mjs` without `SOFT` to check.
- **Same run, warm reload at High:** 1,066 frames in 24 s, worst 217 ms at about 2 s after the
  first frame, 4 frames over 60 ms, no step down. The pane was in the background, so treat the
  frame rate as rough.

## How to measure (on a PC with a graphics card)

The scripts are in `sea3d/tools/real-gpu/`. Each one opens a visible copy of the installed Google
Chrome (`channel: "chrome"`), so it uses the real graphics card. Install with
`npm install --no-save playwright` in `sea3d/`. `SITE=` picks the page (the live site by default;
use `http://localhost:4173/` after `npm run build && npx vite preview`).

- `perfrun.mjs`: loads the page with `?perf` (the frame recorder in `src/perfLog.ts`), once fresh
  and once as a reload, and saves both reports (`OUT-cold.json`, `OUT-warm.json`).
- `loadline.mjs`: a timeline of the fresh load: every frame over 40 ms, and the draw calls and
  shader programs built in each frame. This is where the table above comes from.
- `shots5.mjs`: screenshots at 0.6, 1.5, 3, 4.8 and 6.5 s.
- `lookchange.mjs`: changes the title from High to Low and prints how long the page was locked.

A local build without the Blender boats draws the code-built boats instead, which have different
shaders. To match the live site, copy the live site's `models/*.glb` into `sea3d/public/models/`
first.
