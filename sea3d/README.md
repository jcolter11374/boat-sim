# sea3d: the 3D view of boat-sim

A web page that shows the boats on the sea in 3D. It runs in any modern
desktop browser; nothing to install.

- **Plan:** five phases. 0 setup (this), 1 both boats on a live sea, 2 voyage
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
npm test           # after build: headless smoke test, screenshot in test-output/
npm run test:unit  # wave-motion gate: roll periods, righting curves, self-righting
```

`npm test` needs the `playwright` package and Chromium
(`npm install --no-save playwright && npx playwright install chromium`).

## Files

- `src/waves.ts`: the sea surface (sum of wave trains, sized so the
  significant wave height matches the sea state). Phase 1 floats the boats on
  this same function.
- `src/motion.ts`: heave, pitch and roll of each boat on that sea (display
  physics only; it never feeds the odds). Each boat's roll uses its full
  righting-arm curve, so knockdowns and self-righting look the way the
  stability numbers say they should.
- `src/main.ts`: scene, camera, controls, sea mesh.
- `tests/smoke.mjs`: the CI check.
- `tests/motion.test.ts`: the wave-motion gate.
