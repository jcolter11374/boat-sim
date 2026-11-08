# boat-sim

Engineering simulator for a single autonomous solar-electric kayak drone crossing
from the Chesapeake Bay mouth to Europe. It replays the boat through real
historical Atlantic weather and currents and reports the odds of arrival, by
launch month, and what kills the boat when it fails.

Plan, architecture and milestones: [Voyage Simulator Plan](https://claude.ai/artifact/4mgi1LeuFF2wfQGRBnXRDR).
Boat design: [design doc](https://claude.ai/artifact/SUbeMhqMATokuTdqpmWhj6).
(Both links are private team docs; the code and issues here stand on their own.)

## Status

**M0 skeleton.** Every package has its interface and a deliberately dumb stub, so
the whole loop runs end to end. The numbers it prints are meaningless until the
real physics, data and autopilot land (M1 to M3).

## Run it

```bash
python -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest
python -m boatsim configs/v4_kayak.yaml
```

Everything runs in the cloud (Claude thread sandboxes and GitHub Actions);
nothing needs a local machine except a browser to read reports.

## Layout

| Package | What | Owner |
| --- | --- | --- |
| `src/boatsim/types.py`, `config.py`, `geo.py` | Shared types and helpers (the contracts) | Maya (Lead) |
| `src/boatsim/runner/` | Steps one voyage; arrival rule | Maya (Lead) |
| `src/boatsim/vessel/` | Drag, thrust, solar, battery, hazards | Theo (Physics) |
| `src/boatsim/oceandata/` | ERA5, GLORYS12, ship density, forecast error | Priya (Ocean data) |
| `src/boatsim/autonomy/`, `comms/`, `basestation/` | Autopilot, satellite link, base policy | Sam (Autopilot and comms) |
| `src/boatsim/mc/` | Monte Carlo batches, QA | Ravi (QA) |
| `src/boatsim/viz/` | Reports and dashboard | Iris (Graphics) |
| `configs/` | One YAML per boat design | everyone, via PR |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the team rules.

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

## License

MIT. See [LICENSE](LICENSE).
