# Physics: the referee and the display

There are two kinds of physics in the repo, and keeping them apart is the
most important rule in the codebase:

| | Simulator physics | Display physics |
| --- | --- | --- |
| Where | `src/boatsim/` (Python) | `sea3d/src/` (TypeScript) |
| Decides | speed, battery, damage, finishing, odds | how the boat bobs, leans and splashes on screen |
| Feeds results? | Yes, it is the referee | **Never** |

## Simulator physics (`src/boatsim/vessel/`)

The voyage steps every 10 minutes (`runner/simulate.py`). Each step the
vessel model works out where the boat goes. For the kayak (`kayak.py`):

1. **Drive power:** what the autopilot asked for, limited by working
   thrusters and what the battery can give.
2. **Speed:** where thrust plus the wind's push balances drag. The boat
   reaches steady speed in well under a minute, so one balance per step is
   enough.
3. **Leeway** (sideways slip): where the wind's side force balances the keel.
4. **Drift:** add the ocean current and the waves' Stokes drift (the small
   forward push waves give floating things), then move the boat.

| File | What it models |
| --- | --- |
| `hull.py` | Water drag (ITTC-1957 friction line, form factor, wave-making), wind on the hull, rough-water added drag, fouling (weed and barnacles growing on the hull) |
| `propulsion.py` | Thrust per watt from the T200 thrusters (momentum theory times one fitted efficiency) |
| `power.py` | Solar panels (sunlight, roll, heat, salt) and the LiFePO4 battery |
| `sail.py` | The Randolph boats' free-turning wing sail |
| `vpp.py`, `keelboat.py` | Velocity prediction program and polar-driven yachts with reefing, tacking and heel limits |
| `oddboats.py` | Joke fleet: crew paddling power with fatigue, swamping, kites |
| `hazards.py` | Odds per hour of knockdowns from breaking waves, their damage, and ship strikes |
| `wearout.py` | Failure rate that rises with days at sea, fitted to the real crossing record |
| `coast.py` | Distance to land, for hazards that only happen near a coast |
| `calibrate.py` | Turns tow-test readings into config numbers ([../tow-test.md](../tow-test.md)) |

Hazards are **odds per hour** from sea state and traffic, not 3D wave
simulation. Their sizes are mostly `# GUESS`, tuned to the design's failure
analysis; `mc/sensitivity.py` varies them to see which guesses matter.

The **finish rule** lives in `runner/arrival.py` and **land** in
`runner/land.py` (a 2 km land mask from Natural Earth, kept in git at
`data/land/land_mask_v1.npz`). Running aground anywhere ends the voyage.

The **autopilot** (`autonomy/`) steers to waypoints (`guidance.py`), saves the
battery (`safemode.py`), sails (`sailing.py`), and is versioned as numbered
policies (`policy.py`), so two runs can be checked to be on the same rules.

### Determinism

Same design, same launch, same seed: same voyage, bit for bit. Each part has
its own random stream. `python -m boatsim.runner.replay verify <file>`
re-runs a committed replay and fails if anything differs.

## Display physics (`sea3d/src/`)

| File | What |
| --- | --- |
| `waves.ts` | The big waves: Gerstner wave trains from a JONSWAP spectrum (a standard shape for how wave energy spreads over wave lengths), sized so the significant wave height is exact. `MixedSea` adds up to two swells |
| `seaFFT.ts`, `seaFFT.worker.ts` | Short wind waves via an FFT ocean (Tessendorf 2001), off the main thread |
| `seaSurface.ts` | One height and normal for the drawn sea, shared by JavaScript and shaders, so boats sit exactly on what you see |
| `motion.ts` | Heave, pitch and roll of each boat as damped oscillators driven by the sea under the hull, with each hull's full righting curve, so knockdowns and self-righting look right |
| `standin.ts` | Simple fallback motion (copies the sea's tilt) |
| `seastate.ts` | Reads baked ERA5 wave systems so the drawn sea matches the logged sea |

Rule of thumb: the simulator tells the page the conditions (wind, wave
height and direction, speed, events) through a replay or the worker; the
display code makes it *look* like that. If the picture and the log disagree,
the picture is wrong.

Tests: `npm run test:unit` in `sea3d/` is the wave-motion gate (roll periods,
righting curves, self-righting, exact wave height).
