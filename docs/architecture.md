# How Bluewater fits together

This is the map for a new developer: what the pieces are, how data moves
between them, and where to look for each thing. The guides in
[docs/guides/](guides/) go one level deeper on each system.

## The one idea to hold on to

**The Python simulator is the referee.** Everything that decides what happens
to a boat (speed, battery, breakdowns, knockdowns, finishing or not) is worked
out by the Python package in `src/boatsim/`. The game in `sea3d/` draws what
the simulator says and never disagrees with it. The 3D view has its own wave
and motion code, but that is *display physics*: it makes the boat bob and lean
believably and never feeds a result back.

The simulator reaches the browser in three ways:

```
                      ┌───────────────────────────────────────────┐
  real weather        │  src/boatsim/  (Python, the referee)      │
  ERA5, GLORYS ──────▶│  vessel · oceandata · autonomy · comms    │
  (streamed)          │  basestation · runner · mc · sandbox      │
                      └──────┬──────────────┬──────────────┬──────┘
                             │              │              │
          1. offline runs in │ 2. packed as │ 3. data bakes│
          GitHub Actions     │ boatsim.zip, │ for the 3D   │
          (replays, odds,    │ run in the   │ look (swell, │
          leaderboard)       │ browser by   │ land, today's│
                             │ Pyodide      │ weather)     │
                             ▼              ▼              ▼
                      ┌───────────────────────────────────────────┐
                      │  sea3d/  (TypeScript + three.js, Vite)    │
                      │  title · helm (sailing screen) · boatyard │
                      │  voyage · race · leaderboard              │
                      └───────────────────────────────────────────┘
                                  GitHub Pages (live site)
```

1. **Offline runs.** GitHub Actions workflows run the simulator on full
   resolution weather and write JSON the pages read: voyage replays
   (`sea3d/public/voyages/`), the Boatyard odds grid
   (`sea3d/public/boatyard/`), the design leaderboard, and weather challenges.
2. **In the browser.** The site build packs `src/boatsim` into
   `boatsim.zip`. Pages that let you sail (the helm, the race, Boatyard test
   runs) start a Web Worker that loads Pyodide (Python compiled to
   WebAssembly) and runs the real simulator on a thinned 2020 weather bundle.
   The page and its simulator are always built from the same commit, and the
   deploy checks that (see [docs/sandbox.md](sandbox.md)).
3. **Data bakes for looks.** Swell systems, land heights and photos, and
   today's forecast are baked by workflows into GitHub releases and copied
   into the site at build time. These change the picture, not the result.

## The game's pages

The game is one path: **Title, Your boat, Set sail, Sailing, Results, go
again** (the full design is summarised in [game-design.md](game-design.md)).
Under the hood that path is spread over six HTML pages, each a Vite entry in
`sea3d/vite.config.ts`. Every page also loads `src/topbar.ts`, the shared top
bar.

| Page | Entry script | What it is |
| --- | --- | --- |
| `index.html` | `src/title.ts`, `src/main.ts` | Title screen over the live sea. `main.ts` is the sea and boats; `title.ts` is the menu on top |
| `helm.html` | `src/helm.ts` + `src/helm/` | The Set sail card and **the one sailing screen**: ocean crossing, practice courses, weather challenges, Watch a voyage and Race it all play here. The simulator runs in `src/helm/worker.ts` |
| `boatyard.html` | `src/boatyard.ts` + `src/yard/` | Build your boat from parts, hulls and paint; chance-to-finish gauge; "Test it" goes to Set sail. Test runs use `src/yard/sim.worker.ts` |
| `voyage.html` | `src/voyage.ts` + `src/replay/` | Replay of a pre-simulated voyage from `public/voyages/` with chart and time warp |
| `race.html` | `src/race.ts` + `src/race/` | Two boats on the same launch; simulator in `src/race/worker.ts` |
| `leaderboard.html` | `src/leaderboard.ts` | Draws the board the "Design leaderboard" workflow publishes |

Shared state between pages lives in the browser only: "my boat" is kept in
`localStorage` by `src/myboat.ts`, and a long crossing is saved by
`src/helm/voyageSave.ts`. There are no accounts and no server.

### Inside the sailing screen

`src/helm.ts` is the largest file in the game. It wires together:

- `helm/setsail.ts`, `helm/setsailCard.ts`: the Set sail card's choices (where,
  when, optional challenge), carried in the URL.
- `helm/game.ts` and `helm/worker.ts`: the page side and the worker side of a
  game. The worker runs `boatsim.sandbox.helm.Game`; the page sends orders
  (heading, power, sails) and "run for N hours", one request at a time.
- `helm/ghost.ts`, `helm/rival.ts`: the autopilot sailing the same weather
  beside you.
- `helm/hud.ts`, `helm/timebar.ts`, `helm/compass.ts`, `helm/readings.ts`: the
  instruments. Real time (1x) is always first on the speed bar.
- `helm/course.ts`, `helm/buoys.ts`: the Annapolis practice courses.
- `helm/ending.ts`, `results.ts`, `helm/highlights.ts`: the results card.
- `helm/storm.ts`, `helm/challenges.ts`: weather challenges.
- `helm/autoQuality.ts`: picks the picture quality for the computer.

## The simulator's packages

Each package exposes a `Protocol` (an interface) in its `base.py`. The runner
only talks to those interfaces, so any piece can be swapped.

| Package | What it does |
| --- | --- |
| `types.py`, `config.py`, `geo.py` | Shared data types (`EnvState`, `BoatState`, `Command`, `Event`, `Outcome`), the YAML design loader, sphere maths. Everyone depends on these |
| `vessel/` | The boat: hull drag, thrust, solar and battery, sails, polars, hazards, wear-out. `make_vessel(design)` picks the model |
| `oceandata/` | Real weather and ocean: ERA5, GLORYS12, ship traffic, storms, sea state, land, challenges |
| `autonomy/` | The autopilot: steering to waypoints, battery safe mode, sailing rules, numbered policies |
| `comms/` | Iridium and the backup beacon: what gets through, and when |
| `basestation/` | The shore team's daily re-planning from a forecast |
| `runner/` | Steps one voyage (`simulate.py`), the finish rule (`arrival.py`), land (`land.py`), replays (`replay.py`) |
| `mc/` | Monte Carlo batches: odds by month, sensitivity, Boatyard grid, leaderboard, drift checks |
| `sandbox/` | What the browser runs: the weather bundle, the parts catalog, the helm game, the race |
| `viz/` | Static HTML reports and result cards |

### One voyage, step by step

`runner/simulate.py` builds a `Components` bundle (one of each: environment,
forecast, vessel, autopilot, link, base policy, land mask, finish target) and
steps a `Voyage` in 10-minute steps:

1. Sample the weather and ocean at the boat (`Environment.sample`).
2. The vessel gives the autopilot its sensor readings (`Vessel.sense`), and
   the autopilot answers with a `Command` (heading, power, sails).
3. The vessel moves the boat for 10 minutes (`Vessel.step`): battery, drift,
   and the hazard dice (knockdowns, ship strikes, failures), returning events.
4. Comms: the daily report goes out over Iridium if it can, the shore base
   may answer with a new route (it waits in the mailbox until the boat checks),
   and the backup beacon pings on its own clock.
5. Check the 25 km finish circle (`runner/arrival.py`) and land (aground ends
   the voyage), and log the hour.

Each part draws from its own random stream, so a change in one part (say an
extra message from base) doesn't reshuffle another part's luck. That is what
makes paired comparisons between two designs fair.

The result is a `VoyageLog`: the track, the events and an `Outcome`. The same
seed and launch always give the same log, which is what lets the replay check
(`python -m boatsim.runner.replay verify`) prove a committed replay still
matches the code.

## Where things live

```
src/boatsim/        the simulator (Python 3.12)
configs/            one YAML per boat; configs/polars/ holds sailing-speed tables
data/land/          land mask kept in git (everything else under data/ is ignored)
tests/              pytest suite for the simulator
sea3d/              the game (TypeScript, three.js, Vite)
  *.html            the six pages
  src/              page scripts and systems (see the rendering guide)
  public/           static data shipped with the site (replays, catalog, ports, stars...)
  blender/          headless Blender scripts that build the detailed boat models
  tests/            unit tests (*.test.ts), quick and smoke browser checks
tools/              site build, live-site checks, playtest bots, proof frames
.github/workflows/  CI, deploy, and the data and study workflows
docs/               these docs, plus QA write-ups in docs/qa/
```
