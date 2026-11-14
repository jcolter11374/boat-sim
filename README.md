# Bluewater (boat-sim)

**Bluewater** is a sailing game in the browser: pick a boat, set sail on a
real sea in real past weather, and see what happens, in real time if you like.
It grew out of an engineering simulator for one real boat, a 3 m
solar-electric kayak drone meant to cross the Atlantic on its own from the
Chesapeake Bay to Europe, and that simulator still decides everything that
happens in the game.

**Play it:** https://jcolter11374.github.io/boat-sim/

## How it is built, in one paragraph

Two halves. `src/boatsim/` is a Python simulator (the referee): boat physics,
real weather (ERA5 wind and waves, GLORYS12 currents), the autopilot,
satellite comms, and the Microtransat race rules. `sea3d/` is the game:
TypeScript and three.js pages that draw the sea, sky and boats and run the
same Python simulator inside the browser through Pyodide. GitHub Actions runs
the tests, the big offline simulations, and the deploy to GitHub Pages. Start
with **[docs/architecture.md](docs/architecture.md)**.

## Run it

Simulator (Python 3.12):

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest
python -m boatsim configs/v4_kayak.yaml     # smoke run: a small batch in steady made-up weather
```

Game (Node 22):

```bash
cd sea3d
npm ci
npm run dev          # http://localhost:5173
npm run test:unit
```

A bare dev server has no weather data, so the sailing pages say they can't
start; `tools/build_site.sh` builds the full site the way the deploy does.
More in [docs/guides/testing-and-deploy.md](docs/guides/testing-and-deploy.md).

## Documentation

| Read | For |
| --- | --- |
| [docs/game-design.md](docs/game-design.md) | What the game is: pillars, the core loop, modes, the rules the code must keep |
| [docs/architecture.md](docs/architecture.md) | How the pages and modules fit together, and where everything lives |
| [docs/guides/boats.md](docs/guides/boats.md) | Boat design files, which physics each boat gets, 3D models, adding a boat |
| [docs/guides/physics.md](docs/guides/physics.md) | Simulator physics (the referee) and display physics (the look) |
| [docs/guides/weather.md](docs/guides/weather.md) | Weather and ocean data: sources, caching, the browser bundle, checks |
| [docs/guides/boatyard.md](docs/guides/boatyard.md) | The Boatyard: parts catalog, where the odds come from, adding a part |
| [docs/guides/rendering.md](docs/guides/rendering.md) | How the 3D world is drawn: sea, sky, land, cameras, quality, sound |
| [docs/guides/testing-and-deploy.md](docs/guides/testing-and-deploy.md) | Tests, CI, the deploy to GitHub Pages, data workflows |
| [docs/glossary.md](docs/glossary.md) | One name for each thing, in the words players see |
| [CONTRIBUTING.md](CONTRIBUTING.md) | The team's rules |

Deeper references: [docs/sandbox.md](docs/sandbox.md) (simulator in the
browser), [docs/boatyard.md](docs/boatyard.md) (odds grid format),
[src/boatsim/oceandata/README.md](src/boatsim/oceandata/README.md) (weather
data in detail), [sea3d/README.md](sea3d/README.md) (3D file notes),
[docs/qa/](docs/qa/) (studies and checks).

## Layout

| Path | What |
| --- | --- |
| `src/boatsim/types.py`, `config.py`, `geo.py` | Shared types and helpers (the contracts between packages) |
| `src/boatsim/runner/` | Steps one voyage; the finish rule; land; replay files |
| `src/boatsim/vessel/` | Drag, thrust, solar, battery, sails, polars, hazards |
| `src/boatsim/oceandata/` | ERA5, GLORYS12, ship traffic, storms, sea state, land, challenges |
| `src/boatsim/autonomy/`, `comms/`, `basestation/` | Autopilot, satellite link, shore base re-planning |
| `src/boatsim/mc/` | Monte Carlo batches: odds, studies, Boatyard grid, leaderboard |
| `src/boatsim/sandbox/` | What the browser runs: weather bundle, parts catalog, helm game, race |
| `src/boatsim/viz/` | Static reports and result cards |
| `configs/` | One YAML per boat |
| `sea3d/` | The game: six pages, three.js, Vite |
| `tools/` | Site build, live-site checks, playtest bots |
| `.github/workflows/` | CI, deploy, data and study workflows |

## Contributing from outside the team

Outside contributions are welcome, including from other teams building their own
ocean drones. Use the code for your own boat, borrow the physics or data loaders,
or send fixes back.

- Fork the repo and open a pull request against `main`. CI must be green.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md): SI units inside the code, mark any
  unsourced number `# GUESS`, and keep downloaded data out of git.
- Contributions are accepted under the MIT License (below). Only send code and
  data you have the right to share under it.
- Bug reports and questions go in GitHub Issues.
- Other drone teams: see [COLLABORATION.md](COLLABORATION.md) for how we keep in touch.

## Talk to us

- **[Discussions](https://github.com/jcolter11374/boat-sim/discussions)** is the
  place to swap ideas, data sources, test results and lessons learned, including
  with other teams building ocean drones. Start a thread in Q&A, Ideas or
  Show and tell.
- **[Issues](https://github.com/jcolter11374/boat-sim/issues)** are for concrete
  bugs and work items in this code.
- Please don't post files you don't have the right to share, and check that
  anything you attach can be shared under the MIT License.

## License

MIT. See [LICENSE](LICENSE).
