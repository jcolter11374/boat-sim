"""Run many voyages at once, one per CPU core (issue #24).

Why processes and not NumPy vectorisation: one 50-day voyage takes about half
a second on constant (stub) weather (measured 0.53 s with KayakVessel, safe
mode, Iridium and the replan policy). Real ERA5 weather adds tile reads; see
_environment for the cache sizing that keeps those cheap. 2,000 voyages are therefore ~17 CPU-minutes, about 4 to 5 minutes on a
4-core GitHub Actions runner. Vectorising would mean rewriting every package's
step logic around arrays for a gain we don't need yet. If a future batch is too
slow, profile first: the hot spots today are solve_speed and the great-circle
helpers.

Usage:

    from boatsim.runner.parallel import StandardVoyage, run_many, summarize

    job = StandardVoyage(weather="reanalysis")
    rows = run_many(job, starts, reduce=summarize)   # one small dict per voyage

`job` must be picklable: a top-level function, functools.partial, or a frozen
dataclass with __call__ like StandardVoyage. `reduce` runs inside the worker so
full hourly logs never cross process boundaries (2,000 full logs would be
gigabytes).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Sequence
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import datetime
from functools import lru_cache
from typing import Any

from boatsim.runner.simulate import Components, VoyageLog, default_mission, simulate
from boatsim.types import EventKind

Job = Callable[[datetime, int], VoyageLog]


def summarize(log: VoyageLog) -> dict[str, Any]:
    """Small per-voyage record: outcome, duration, where it ended, what went wrong."""
    last = log.rows[-1] if log.rows else {}
    kinds = [e.kind for e in log.events]
    first_bad = next(
        (e for e in log.events if e.kind in (EventKind.LOST, EventKind.SHIP_STRIKE)), None
    )
    return {
        "start": log.start,
        "seed": log.seed,
        "outcome": log.outcome.value,
        "days": round(log.days, 2),
        "end_lat": last.get("lat"),
        "end_lon": last.get("lon"),
        "final_soc": last.get("soc"),
        "battery_empty_events": kinds.count(EventKind.BATTERY_EMPTY),
        "knockdown_events": kinds.count(EventKind.CAPSIZE),
        "parts_failed": kinds.count(EventKind.PART_FAILED),
        "ship_strikes": kinds.count(EventKind.SHIP_STRIKE),
        "routes_received": kinds.count(EventKind.MISSION_UPDATED),
        "loss_cause": first_bad.detail if first_bad else None,
    }


def _call(args):
    job, reduce, start, seed = args
    log = job(start, seed)
    return reduce(log) if reduce is not None else log


def run_many(
    job: Job,
    starts: Sequence[datetime],
    seed: int = 0,
    workers: int | None = None,
    reduce: Callable[[VoyageLog], Any] | None = None,
) -> list[Any]:
    """Run job(start, seed + i) for every start, in parallel; results in input order.

    workers=None uses every core; workers=1 runs in this process (easy to debug).
    Seeds are fixed by position, so results don't depend on the worker count.
    """
    tasks = [(job, reduce, s, seed + i) for i, s in enumerate(starts)]
    workers = workers or os.cpu_count() or 1
    if workers == 1 or len(tasks) <= 1:
        return [_call(t) for t in tasks]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(_call, tasks, chunksize=max(1, len(tasks) // (workers * 8))))


@lru_cache(maxsize=8)
def _environment(weather: str, currents: bool, for_forecast: bool = False):
    """One environment per worker process and role, so in-memory tile caches are reused.

    The base station's forecast gets its own environment with a bigger cache: it
    looks 3+ days ahead of the boat each day, and sharing the boat's 3-day cache
    made the two evict each other's tiles (Ravi measured 113 tile loads, 18 of
    18.6 s, in a 4-day voyage).
    """
    from boatsim.oceandata import ConstantEnvironment, ERA5Source, ReanalysisEnvironment

    if weather == "constant":
        return ConstantEnvironment()
    if weather == "reanalysis":
        from boatsim.oceandata.traffic import default_source

        era5 = ERA5Source(max_tiles=6 if for_forecast else 3)
        ships = default_source()  # data/traffic/ship_density_v1.nc if present (#13)
        if currents:
            from boatsim.oceandata import GlorysSource

            glorys = GlorysSource(max_tiles=3 if for_forecast else 2)
            return ReanalysisEnvironment(era5=era5, currents=glorys, ships=ships)
        return ReanalysisEnvironment(era5=era5, currents=None, ships=ships)
    raise ValueError(f"unknown weather {weather!r}: use 'reanalysis' or 'constant'")


@dataclass(frozen=True)
class StandardVoyage:
    """Picklable recipe for one v4 voyage with the team's current components.

    Every voyage gets fresh vessel, autopilot, link and base objects (they keep
    per-voyage state such as the airtime ledger); only the environment is shared
    within a worker.
    """

    design_path: str = "configs/v4_kayak.yaml"
    weather: str = "reanalysis"  # or "constant" for tests and quick looks
    currents: bool = True
    max_days: float = 120.0
    land: bool = True  # end the voyage when it runs ashore outside Europe (#70)
    forecast_error: float = 1.0  # 0 = base sees the future perfectly; 2 = twice the error

    def components(self, seed: int = 0) -> Components:
        from boatsim.autonomy import SafeModeAutopilot
        from boatsim.basestation import ForecastReplanPolicy
        from boatsim.comms import GlobalstarPinger, IridiumSBDLink
        from boatsim.config import load_design
        from boatsim.oceandata import ErrorForecast
        from boatsim.runner.land import default_land
        from boatsim.vessel import KayakVessel

        design = load_design(self.design_path)
        prop = design.propulsion
        env = _environment(self.weather, self.currents)
        forecast_env = _environment(self.weather, self.currents, for_forecast=True)
        return Components(
            env=env,
            forecast=ErrorForecast(forecast_env, seed=seed, scale=self.forecast_error),
            vessel=KayakVessel(design),
            autopilot=SafeModeAutopilot(
                cruise_fraction=prop["cruise_drive_w"] / prop["max_drive_w"],
                thruster_count=int(prop.get("thruster_count", 2)),
            ),
            link=IridiumSBDLink(),
            pinger=GlobalstarPinger(),
            base=ForecastReplanPolicy(route=default_mission().waypoints),
            land=default_land() if self.land else None,
        )

    def __call__(self, start: datetime, seed: int) -> VoyageLog:
        from boatsim.config import load_design

        voyage = load_design(self.design_path).voyage
        return simulate(
            self.components(seed),
            start,
            voyage["drop_lat"],
            voyage["drop_lon"],
            default_mission(),
            seed=seed,
            max_days=self.max_days,
        )
