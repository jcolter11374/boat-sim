# Boatyard sandbox: the simulator in the browser

The yard page runs the real simulator in the browser (Pyodide: CPython compiled
to WebAssembly, with numpy and pyyaml). Any build from Sam's parts catalog runs
on one season of thinned weather, six launches, with replays. Finish odds need
100 voyages over ten years, which is too much for a browser, so those come from
the precomputed grid (docs/boatyard.md). The page shows the nearest grid build's
odds beside a sandbox run.

Label sandbox results **"sandbox, 2020 weather"**. They are not the headline
odds: the weather is thinned (below), so the voyages are close to, but not the
same as, the full-resolution runs.

Show this sentence on the page wherever sandbox results appear: **"Browser runs
can end differently from the same build run on our servers; the odds shown come
from the server grid."** (See "The exactness gate" below for why.)

## What the page downloads

From the `sandbox-data` release (workflow "Sandbox data", publish ticked):

| File | Size | What |
|---|---|---|
| `forcing_2020.npz` | 18 MB | The season's forcing bundle (below) |
| `boatsim.zip` | ~0.25 MB | `src/boatsim`, the design files and the land mask |
| `reference.json` | small | Reference voyages run in Node + Pyodide |

Plus the Pyodide runtime with numpy and pyyaml (~13 MB, from the Pyodide CDN).
Everything is cached after the first visit.

### The forcing bundle (`boatsim.sandbox.forcing`)

1 April to 20 November (the last launch, 15 June, plus 150 days and a little
forecast look-ahead), over 28 to 50 N, 78 to 8 W.

| Field | Full runs | Sandbox |
|---|---|---|
| Wind, waves, cloud (ERA5) | 0.25 deg, hourly | 1 deg, 6-hourly |
| Air temperature | hourly | daily mean |
| Sunlight | hourly | daily clearness x a clear-sky sun model |
| Currents (GLORYS12) | 1/12 deg, daily | 0.25 deg, daily (the Gulf Stream is ~100 km wide) |
| Ship density | as is | as is |

Sunlight hourly at sea would be far too big, so the bundle carries each day's
clearness (ERA5 sunlight over clear-sky sunlight, summed over the day) and the
browser multiplies it by the clear-sky model at the boat's time and place.

## Data sources and attribution

The sandbox files (`forcing_<year>.npz`, and the land mask inside `boatsim.zip`)
redistribute modified data from these sources:

- **ERA5** wind, waves, cloud, air temperature and sunlight (Hersbach et al.
  2020, via Google's ARCO-ERA5). Contains modified Copernicus Climate Change
  Service information 2020. Neither the European Commission nor ECMWF is
  responsible for any use that may be made of the Copernicus information or
  data it contains.
- **GLORYS12** surface currents (Copernicus Marine product
  GLOBAL_MULTIYEAR_PHY_001_030, https://doi.org/10.48670/moi-00021).
  E.U. Copernicus Marine Service Information.
- **Ship density**: EMODnet Human Activities Vessel Density Map (originator
  Cogea Srl) and the World Bank Global Shipping Traffic Density (dataset
  0037580). Both are CC BY 4.0, and we changed them (THIRD_PARTY_NOTICES.md).
- **Land mask**: Made with Natural Earth. Free vector and raster map data @
  naturalearthdata.com.

We thinned and quantised all of these (see the bundle table above). The page
should show these lines, or link to them, wherever it offers the sandbox.

## Running a build (`boatsim.sandbox.run`)

A design is Sam's catalog slot id -> option id, plus `cruise_w` (10 to 30 W).
Missing slots take the catalog default; the all-default build is
`configs/v4_kayak.yaml` untouched.

```python
from boatsim.sandbox.run import open_bundle, launches, run_voyage, launch

env = open_bundle(open("forcing_2020.npz", "rb").read())  # bytes or a path
launches(env)  # [(datetime(2020, 4, 1, 12), 2020006), ...]: 1st/15th Apr-Jun
run_voyage({"thr": "one-t200", "cruise_w": 15}, env, *launches(env)[0])
# -> {"result": {...outcome, days, end_lat, loss_cause...}, "replay": {...}}
launch(design, env)  # all six in a row (a worker pool can call run_voyage instead)
# -> {"build", "effects", "results", "replays", "odds_build", "exact", "note"}
```

- Seeds are the voyage replays' (year x 1000 + the launch's place in the year),
  so the default build replays the same dice as `sea3d/public/voyages/`.
- `replay` is the boatyard's slim replay (6-hourly rows, notable events only).
- `odds_build` is the nearest grid build; `exact` is true when it is this build.
- `effects` gives each slot's option, what it does in the simulator (`wired`,
  `no effect yet` or `fixed`), its badge (`est`: estimated) and `basis` (why).
  Show "no effect yet" options greyed with that label, not hidden.

One voyage takes 20 to 80 s in Pyodide on a laptop; run one per Web Worker.

## The exactness gate

The "Sandbox data" workflow runs the reference builds twice on the same bundle:

1. in CPython, and
2. in Node + Pyodide (`tools/pyodide/reference.mjs`, from `boatsim.zip`).

Across the two runtimes, results are **not** guaranteed to match. numpy's maths
libraries differ in the last bit between them, and over 60 to 150 days at sea a
last-bit difference can tip a voyage: a different replan, a breaker that does or
doesn't roll the boat. In the first run with currents, 8 of 12 voyages agreed on
outcome, days and events, with end positions within 1e-8 deg, and 4 diverged.
So the workflow reports CPython vs Pyodide (`python -m boatsim.sandbox compare`)
but doesn't fail on it, and it checks that a second Pyodide run is identical.
The Pyodide run is the same WebAssembly the browser runs, so a browser run must
match `reference.json` **exactly**:

```
python -m boatsim.sandbox compare reference.json browser.json --exact
```

The gate is pinned to Pyodide 0.27.7 with numpy 2.0.2 (the page and
`tools/pyodide` must use the same). Bumping Pyodide will break it, as it
should: the fix is to bump both together and regenerate `reference.json` with
the workflow, never to loosen the comparison.

The workflow also runs two diagnostics. **Control**: CPython with the drop
moved 1e-9 deg (about 0.1 mm), compared with CPython; if that flips about as many
voyages as CPython vs Pyodide, the differences are the simulation's own
sensitivity and not something Pyodide-specific. **Diverge**
(`python -m boatsim.sandbox diverge a.json b.json`, with `reference --trace`):
for each voyage that ends differently, the hour where the tracks first part and
the events either run had in the day before. The run summary also puts the kayak's
sandbox endings next to the full-resolution server replays of the same launches.

Result (10 Nov 2026, 2020 bundle, kayak and one-box builds, 12 voyages): the
0.1 mm control changed 5 voyages and Pyodide changed 4, the same ones (the
kayak's 1 April launch goes aground at 75.75 days, or arrives at 90.05 nudged
and 116.76 in Pyodide). In every case the tracks drift apart slowly, by about
0.001 deg somewhere between day 2 and day 68, with no event marking the split.
That is chaos: storm-season voyages amplify any last-digit difference, whether
it comes from a nudge or from a different maths library. It is not a Pyodide bug.

One real bug turned up and is fixed: forecast-error patterns were keyed on
`datetime.timestamp()` of a naive time, which reads it in the machine's local
timezone. In a browser that is the visitor's timezone, so New York and UTC
visitors got different voyages. Naive times are now read as UTC (no change on
servers, which run UTC).

## Catalog mapping (`boatsim.sandbox.catalog`)

Every option is a change from the kayak as it stands. "No effect yet" options
change nothing until the physics for them lands; they stay visible.

| Slot | Options | Sim | Effect |
|---|---|---|---|
| Thrusters | two-t200, one-t200 | thruster count, 50 W burst each | wired |
| Solar | solar-200/250/300 | `power.solar_wp` | wired (300: est) |
| Batteries | one-50ah 640, two-50ah 1280, two-100ah 2560 Wh | `power.battery_wh` | wired (2560: est) |
| Charge controllers | one, two | weight only (failure not modelled yet) | wired |
| Autopilot | two-box, one-box | `electronics_boxes`, hotel load | wired (est) |
| Satellite modem | rockblock-9603n | none | fixed |
| Backup beacon | smartone-solar, none | `comms.beacon` | wired |
| AIS | emtrak-b921, dy-ait1500, none | hotel load; none: ships avoid as with a dead AIS | wired (est) |
| Radar reflector | two models | none | no effect yet |
| Navigation light | hella-naviled-360 | none | fixed |
| Keel bulb | 50 kg new or scrap, 40 kg | weight; 40 kg: `p_inverted_stuck` x (50/40)^2, GUESS | wired (40 kg: est) |
| Antifouling | micron-csc, none | `hull.fouling_frac_per_day` (none: x2, GUESS) | wired (est) |
| Drive | solar-electric, wing-sail, hybrid | wing: a `sail:` block (vessel/sail.py) scaled up from Rev B; wing-sail: no thrusters, cruise 0 W | wired (est) |
| Hull material | polyethylene, fibreglass, carbon, plywood-epoxy, aluminium | weight; `leak_per_day`, `p_lost_given_strike`; aluminium also fouling | wired (est) |
| Hull shape | kayak, cat, semisub, board | the shape's own mass, drag, windage and hazards; cat: no rudder, not self-righting | wired (est) |
| Spares | three sets | none | no effect yet (trials only) |

**Drive.** The wing (all GUESSes, `catalog.KAYAK_WING`): 1.0 m^2, 2.0 m span,
centre of effort 1.3 m up, heel limit 250 N m (the 50 kg bulb rights the kayak far
harder than Rev B's 17 N m), +6 kg, +5 Wh/day for the tail servo, the tail servo's
failure rate added to steering (Randolph's 0.002/day), and a sixth of Rev B's
published rig-damage rate per knockdown (they say theirs is too high, #153).
*Wing-sail* has no motors: it tacks upwind like Rev B, and the thruster and
cruise-power choices don't apply. *Hybrid* keeps both thrusters: while the motors
push, it holds its course even dead upwind, and the wing adds whatever drive it
can at that heading (`vessel/kayak.py`). Lose the wing and it is the kayak again,
less the wing's drag.

**Hull material.** The as-built hull is rotomoulded polyethylene, foam-filled.
Every other material keeps the foam. GUESSes, no fleet data per material:

| Material | Weight vs PE | Leaks vs PE | Ship strike ends it | Other |
|---|---|---|---|---|
| Fibreglass | -6 kg | x1.2 | 0.85 | |
| Carbon | -11 kg | x1.5 | 0.9 | |
| Plywood and epoxy | -4 kg | x1.5 | 0.85 | |
| Aluminium | -2 kg | x0.7 | 0.7 | fouls 1.5x (no copper antifouling) |

**Hull shape.** Sizes agreed with Iris so the 3D models match. Each shape
carries today's kit, and every drag, windage and hazard number is a GUESS scaled
from the kayak by area and shape (`catalog.SHAPES`). Each shape's drag is for its
own weight, so only the other options' weight goes through the mass link.

| Shape | Size, mass | What changes | Catch |
|---|---|---|---|
| Kayak (default) | 3.05 x 0.79 m, 123 kg | nothing | |
| Cat (two hulls) | 3.0 x 1.6 m, 140 kg | low drag per hull, more leeway (no keel), very stiff; a ~1.9 m breaker to roll it | no rudder, so it steers on the two motors and needs both; not self-righting: half the rolls leave it upside down for good (new hazard field `p_capsize_stays_over`, GUESS 0.5) |
| Semisub (rides low) | 3.2 x 0.5 m, 175 kg, 35 kg lead | little windage, waves wash over rather than lift it | deck panels awash give 60 % solar; hatches under water leak 1.5x |
| Board (surfboard) | 3.0 x 0.85 m, 105 kg, 25 kg bulb | light, same fin as the kayak | a flat bottom slams in waves; half the bulb, so 4x more often stuck upside down |

The cat's 0.5 drives its odds, so the odds grid also runs it at 0.2 and 0.8
(`mc.boatyard.CAT_STAYS_OVER`). A design never snaps to those two; they are
there to show how much the answer hangs on that one number.

Two quirks: the semisub sets its own leak rate, which replaces the hull
material's leak setting if both are picked (the material's weight and strike
numbers still apply). The cat's missing rudder comes from a new design flag,
`propulsion.rudder: false`, which starts the voyage with the rudder marked broken,
so it steers by differential thrust only.

The hotel load is the design's 85 Wh/day with the default autopilot (31 Wh)
and AIS (36 Wh) swapped for the chosen ones' catalog figures.

**Weight.** Every option's catalog `kg` (against the default) is added to
`hull.mass_kg`. The mass link in `vessel/hull.py` turns weight into drag: the
boat sinks by the extra mass over (water density x waterplane area, GUESS 1.5 m^2
for the kayak), the wetted area grows by that band around the waterline, and
wave-making grows with displacement. At the design weight
(`hull.displacement_ref_kg`) nothing changes, so the kayak and Rev B baselines
are exactly as before. The big batteries (+10 kg) add about 3 % calm-water drag;
the 40 kg bulb takes about 3 % off but makes a knockdown that leaves the boat
upside down more likely.
