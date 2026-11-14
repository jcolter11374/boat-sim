# Tests, CI and deploy

Everything runs in the cloud: Claude thread sandboxes and GitHub Actions.
Nobody needs a local machine except to play the game in a browser, though
everything below also works locally.

## Running the tests

**Simulator (Python 3.12):**

```bash
pip install -e '.[dev]'           # add ,data,reports for the real-weather and report extras
ruff check . && ruff format --check . && pytest
python -m boatsim configs/v4_kayak.yaml   # smoke run in steady made-up weather (no data needed)
```

Tests live in `tests/`, one file per area (`test_vessel_*.py`,
`test_oceandata_*.py`, `test_sandbox_*.py` and so on). They use stub weather,
so they need no network or login.

**Game (Node 22):**

```bash
cd sea3d
npm ci
npm run dev          # live page at http://localhost:5173
npm run build        # typecheck + static site in dist/
npm run test:unit    # every tests/*.test.ts (picked up by name; no list to edit)
npm run test:quick   # after build: every page opens, the sea animates, Real time on every speed bar
npm test             # after build: the full smoke test, screenshots in test-output/
```

The browser tests need Playwright and Chromium
(`npm install --no-save playwright && npx playwright install chromium`).
A local `npm run dev` has no weather bundle or data releases, so pages that
sail say they can't start. For the whole game, build it the way the deploy
does: `tools/build_site.sh` (needs Python with numpy and pyyaml).

## What runs on a pull request

| Workflow | What it checks | Time |
| --- | --- | --- |
| **CI** (`ci.yml`) | ruff, pytest, one smoke voyage | a few minutes |
| **Pre-release playtest** (`prerelease-playtest.yml`), fast gate | builds the whole site with `tools/build_site.sh`, typecheck, unit tests, `test:quick` | about 5 to 8 minutes |
| **Replay check (PR)** | committed voyage replays still match the simulator, on cached currents | only when replays or `runner/replay.py` change |
| **Sandbox data (PR)** | the in-browser simulator still runs the reference voyages | only when `src/boatsim/sandbox/` or `tools/pyodide/` change |

The full suite (both smoke halves, live checks and playtests in Chrome and
Firefox) runs **nightly on main** at 07:00 UTC, and by hand.

## How the live site is deployed

The live game is GitHub Pages: https://jcolter11374.github.io/boat-sim/

1. A merge to `main` that touches `sea3d/`, `src/boatsim/`, `configs/` or
   `data/land/` starts **3D sea page** (`sea3d.yml`).
2. It builds the Blender boats (cached), then runs `tools/build_site.sh`:
   - downloads the published data releases into `sea3d/public/`
     (`sandbox-data`, `seastate-data`, `land-data`, `challenge-data`,
     `forecast-data`, `leaderboard-data`). A missing release only warns;
   - packs the simulator into `boatsim.zip`, stamped with this commit;
   - builds the pages (`npm run build`);
   - runs `python -m boatsim.sandbox check-page`, which fails if the zip
     can't do something a page asks for (`sea3d/sandbox-needs.json`).
3. Unit tests and the smoke test run on that build, then it deploys.
4. After deploy, a live check confirms the page, `sandbox/boatsim.json` and
   the zip are all the same commit, and **Live site check** and **Playtest**
   play the deployed site in a fresh browser.

## Data and study workflows

These are run by hand or on a schedule from the Actions tab. Most publish to
a GitHub release that the site build picks up; none commit to `main` unless
asked.

| Workflow | Makes |
| --- | --- |
| Voyage replays | `sea3d/public/voyages/` (the only run output kept in git) |
| Boatyard grid | `sea3d/public/boatyard/` odds and replays |
| Sandbox data | the 2020 weather bundle for the browser (`sandbox-data` release) |
| Sea state data, Land data, Today's weather | display data releases |
| Challenge data, Challenge stars, Challenge storm dates | weather challenges |
| Design leaderboard | `leaderboard-data` release |
| Odds by launch month, Sensitivity study, Dead-boat drift, Drop-day drift | studies; write-ups in `docs/qa/` |
| Check ERA5 against buoys, Drifter check, Compare currents with SMOC, Check storms against IBTrACS, Check land mask near the Bay, ... | checks of the data against the real world |
| Fetch ocean currents, Fetch SMOC currents | warm the currents cache |
| Frame-time budget, Proof frames | drawing speed; before/after pictures (`tools/proof/`) |

Only workflows that need the Copernicus login use secrets, and those never
run on pull requests.

## Team rules that matter here

From [CONTRIBUTING.md](../../CONTRIBUTING.md): run ruff and pytest before
pushing; keep downloaded data and run outputs out of git (`data/`, `runs/`);
don't merge `main` into a PR branch just to keep it fresh, because every push
restarts the gate.
