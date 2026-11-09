# sea3d: the 3D view of boat-sim

A web page that shows the boats on the sea in 3D. It runs in any modern
desktop browser; nothing to install.

- **Plan:** five phases. 0 setup, 1 both boats on a live sea, 2 voyage
  replay with time warp, 3 boatyard (build from parts), 4 launch, fail, tweak.
- **Rule:** the Python simulator in `src/boatsim/` is the referee. The 3D view
  may simplify but must never disagree with it.
- **Stack:** three.js + TypeScript, built with Vite. All MIT, all free.

## Run it

```
cd sea3d
npm ci
npm run dev        # live page at http://localhost:5173
npm run build      # static files in dist/
npm test           # after build: headless smoke test, screenshots in test-output/
npm run test:unit  # wave-motion gate: roll periods, righting curves, self-righting
```

`npm test` needs the `playwright` package and Chromium
(`npm install --no-save playwright && npx playwright install chromium`).

## Files

- `src/waves.ts`: the sea surface: wave trains drawn from a JONSWAP spectrum
  with directional spreading, sized so the significant wave height is exact.
  `Sea` follows changing conditions (`setSeaState(hs, tp, dirFrom)`, where
  dirFrom is the direction the waves come from, in degrees true) and eases
  between them without jumps. The boats float on this same function, so what
  you see and what moves the boats always agree.
- `src/water.ts`: the drawn sea (fine grid near the boats, coarse at the
  horizon), coloured by height with foam on the crests.
- `src/boats/specs.ts`: each boat's real measurements (length, beam, mass,
  ballast, centre of gravity, cruising speed). No graphics code.
- `src/boats/parts.ts`, `src/boats/model.ts`: the 3D models built from those
  measurements. The model origin is the centre of gravity, matching the
  motion model.
- `src/motion.ts`: heave, pitch and roll of each boat on that sea (display
  physics only; it never feeds the odds). Each boat's roll uses its full
  righting-arm curve, so knockdowns and self-righting look the way the
  stability numbers say they should.
- `src/standin.ts`: simple stand-in motion (copies the sea surface's tilt),
  kept as a fallback; the page says which motion is running.
- `src/wake.ts`: foam trail behind each boat (cosmetic).
- `src/main.ts`: the showroom page (`index.html`): both boats side by side,
  scene, sky, lights, camera shots, controls.
- `voyage.html`, `src/voyage.ts`: the voyage replay page (Phase 2). Plays a
  replay file from `public/voyages/` (written by `boatsim.runner.replay`):
  Atlantic chart with the track, race lines, target circle and events
  (`src/replay/chart.ts`), time warp, a dashboard, and a close-up of the
  kayak in each hour's logged sea. `src/replay/data.ts` reads the files and
  interpolates between logged hours; at a logged hour it shows exactly the
  logged value. `?data=<dir>` and `?voyage=<file>` pick the data.
  Test hook: `window.__replay.positionAt(hours)` gives `[lat, lon]`.
- `public/land.png`, `public/land.json`: the chart's coastline, made from the
  simulator's land mask by `scripts/land_png.py` (Natural Earth, public domain).
- `tests/smoke.mjs`: the CI check (both boats afloat with finite poses,
  wave heights per sea state, quality switch, screenshots; on the voyage
  page, every logged hour drawn at its logged position, playback, outcome
  card). Uses the real replays when present, else `tests/fixture-voyage.mjs`
  (made-up data, clearly labelled, never shipped).
- `tests/motion.test.ts`: the wave-motion gate.
- `tests/waves.test.ts`: the sea: exact Hs, spectrum and spread, no jumps.
