"""Run a catalog build on a forcing bundle: what the yard page's Web Workers call
in Pyodide (one voyage per worker), and what Actions runs as the reference.

    from boatsim.sandbox.run import open_bundle, launches, run_voyage, launch
    env = open_bundle(bundle_bytes)
    out = run_voyage({"thr": "one-t200", "cruise_w": 15}, env, *launches(env)[0])

Needs only numpy and pyyaml (no pandas, xarray or process pools), plus the
design files and the land mask on the import path's working directory.
"""

from __future__ import annotations

from datetime import datetime

from boatsim.sandbox import catalog
from boatsim.sandbox.forcing import BundleEnvironment

MAX_DAYS = 150.0
LAUNCH_MONTHS = (4, 5, 6)
LAUNCH_DAYS = (1, 15)


def open_bundle(source):
    """The bundle's weather for every page (Boatyard, helm). A hurricane
    challenge bundle carries its storms' best-track fixes, and the vortex goes
    back into the 1 degree weather at sample time (oceandata/stormboost.py);
    any other bundle comes back as the plain BundleEnvironment."""
    from boatsim.oceandata.stormboost import boost_bundle

    return boost_bundle(BundleEnvironment(source))


def note(env: BundleEnvironment) -> str:
    return f"sandbox, {env.meta.get('year', 2020)} weather"


def launches(env_or_year) -> list[tuple[datetime, int]]:
    """The six April to June launches (noon on the 1st and 15th) and their seeds.
    Seeds are the voyage replays' (runner.replay): year * 1000 + the launch's
    place in the year's 24 launches, so 1 April 2020 is seed 2020006."""
    year = env_or_year if isinstance(env_or_year, int) else int(env_or_year.meta["year"])
    out = []
    for m in LAUNCH_MONTHS:
        for i, d in enumerate(LAUNCH_DAYS):
            out.append((datetime(year, m, d, 12), year * 1000 + (m - 1) * len(LAUNCH_DAYS) + i))
    return out


def run_voyage(
    choices: dict | None,
    env: BundleEnvironment,
    start: datetime,
    seed: int,
    max_days: float = MAX_DAYS,
    stride_h: float = 6,
    drop_nudge_deg: float = 0.0,
    drop: tuple[float, float] | None = None,
) -> dict:
    """One voyage of a build: {"result": summary, "replay": slim replay}.
    drop: where the boat is let go (default the design's own drop point; the
    race view puts both boats at one spot). drop_nudge_deg moves the drop north
    by that much: a sensitivity test only."""
    from boatsim.oceandata.grid import OutsideCoverage
    from boatsim.runner.land import default_land
    from boatsim.runner.parallel import summarize
    from boatsim.runner.replay import thin, to_replay
    from boatsim.runner.simulate import default_mission, simulate, standard_components

    design = catalog.design_for(choices)
    lat, lon = drop if drop is not None else (design.voyage["drop_lat"], design.voyage["drop_lon"])
    drop = (lat + drop_nudge_deg, lon)
    c = standard_components(design, env, env, seed=seed, land=default_land())
    try:
        log = simulate(c, start, *drop, default_mission(drop), seed=seed, max_days=max_days)
    except OutsideCoverage:
        return {
            "result": {"start": start.isoformat(), "seed": seed, "outcome": "left_data_box"},
            "replay": None,
        }
    res = summarize(log)
    res["start"] = start.isoformat(timespec="minutes")
    rep = thin(to_replay(log, label="v4 kayak"), stride_h)
    rep["build"] = catalog.grid_id(choices)
    return {"result": res, "replay": rep}


def launch(choices: dict | None, env: BundleEnvironment, which=None) -> dict:
    """Every launch of the season, one after another (the page spreads them over
    workers instead and assembles the same dict). `which` picks launches by index."""
    grid, exact = catalog.nearest(choices)
    runs = [
        run_voyage(choices, env, start, seed)
        for i, (start, seed) in enumerate(launches(env))
        if which is None or i in which
    ]
    return {
        "build": catalog.grid_id(choices),
        "effects": catalog.effects(choices),
        "results": [r["result"] for r in runs],
        "replays": [r["replay"] for r in runs],
        "odds_build": grid,  # look its odds up in boatyard/index.json
        "exact": exact,  # True if the odds are this build's own
        "note": note(env),
    }
