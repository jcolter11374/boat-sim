# Boats and their specs

Every boat exists twice: once as a **design file** the simulator sails, and
once as a **3D model** the game draws. The design file is the referee; the
model must match its numbers.

## The design files (`configs/`)

One YAML file per boat, loaded by `boatsim.config.load_design`:

| File | Boat |
| --- | --- |
| `v4_kayak.yaml` | Our kayak: the 3.05 m solar-electric kayak drone this whole project is about |
| `randolph_rev_b.yaml`, `randolph_rev_c.yaml`, `randolph_rev_e1.yaml` | Our model of the Randolph team's wing-sail drone (from their published MIT files) |
| `stock_*.yaml` | Stock boats from real published specs: cruiser, Pearson 31-2, 14 ft dinghy (Sunfish), 16 ft beach cat, sail drone, ocean rowing boat |
| `joke_*.yaml` | The joke fleet (bathtub, canoe, flamingo, pedalo, robot kayak, wheelie bin), with honest physics |
| `polars/*.json` | Speed tables for the sailing yachts, written by the VPP (below) |

Rules for these files (from [CONTRIBUTING.md](../../CONTRIBUTING.md)):

- SI units: metres, kilograms, watts, seconds.
- **Any number that is not from a datasheet, a dataset or a measurement gets a
  `# GUESS` comment**, so calibration can find it later.
- The kayak file is the baseline for the Boatyard: every Boatyard option is a
  change *from* it, and the default choices patch nothing.

## Which physics a boat gets

`boatsim.vessel.make_vessel(design)` looks at the file and picks one model:

| If the design has... | Model | File |
| --- | --- | --- |
| a `vpp:` block | Keelboat sailed from a polar | `vessel/keelboat.py` |
| an `odd:` section under `stock:` | Odd boat (muscle power, swamping, kites...) | `vessel/oddboats.py` |
| neither | The kayak model (also the Randolph boats, with a `sail:` block for the wing) | `vessel/kayak.py` |

A **polar** is a table of boat speed by wind speed and wind angle. The
yachts' polars are made offline by our small velocity prediction program:

```bash
python -m boatsim.vessel.vpp configs/stock_cruiser31.yaml          # writes the polar
python -m boatsim.vessel.vpp configs/stock_cruiser31.yaml --trim   # plus the hand-trim table
```

## The 3D side (`sea3d/src/boats/`)

| File | What |
| --- | --- |
| `specs.ts` | Each boat's measurements for drawing (length, beam, mass, ballast, centre of gravity, cruise speed) and display names. No graphics code |
| `../motion.ts` | Hull stability numbers (`KAYAK_V4`, `RANDOLPH_REVB`, `CRUISER31`...) for the display wave motion |
| `model.ts`, `parts.ts` | Boats drawn in code from those numbers (fallback when no Blender model) |
| `stock.ts` | Stock boats in 3D, rigs posed from the replay's logged sails |
| `gear.ts` | Moving parts driven by the log: propellers, rudder, wing, comms light, broken parts |
| `paint.ts`, `paintApply.ts` | Paint jobs. Looks only, never reaches the simulator |
| `about.ts` | "About this boat" text and its sources |

The model origin is the centre of gravity, with +x towards the bow, +y up and
+z to starboard (the right side facing forward), matching `motion.ts`.

**Detailed models** come from headless Blender scripts in `sea3d/blender/`
(`build_kayak.py`, `build_randolph.py`, `build_stock.py`, shared parts in
`common.py`). CI builds them into `public/models/*.glb` (cached on the
scripts' hash); they are not kept in git. Without them the pages draw boats in
code; `?models=simple` forces that.
The Randolph boat's fittings are the Randolph team's own published shapes, thinned
(`sea3d/blender/randolph_fittings.json`, made by `sea3d/scripts/randolph_fittings.py`).

**Pictures of a boat from a cloud browser** need `?gl=full` on the page address, or every edge is
a staircase (no graphics card there, so the pages draw small with smoothing off).
`sea3d/tools/qa/boat-look.mjs` takes close-ups that way; see
[docs/qa/boat-look-2026-11.md](../qa/boat-look-2026-11.md).

## Adding or changing a boat

1. Add or edit the YAML in `configs/`, marking guesses. Add a test in
   `tests/` like `test_vessel_pearson31_2.py`.
2. For a yacht, generate its polar with the VPP command above.
3. Add its drawing numbers to `sea3d/src/boats/specs.ts` and `motion.ts`, and
   check they agree with the YAML (length, beam, mass, ballast).
4. If a page offers it, add it to `sea3d/sandbox-needs.json`, so the deploy
   fails if the in-browser simulator can't sail it (see
   [../sandbox.md](../sandbox.md)).
5. For a Boatyard base or parts, see [boatyard.md](boatyard.md).
