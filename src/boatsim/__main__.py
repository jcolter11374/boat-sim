"""Smoke run: python -m boatsim configs/v4_kayak.yaml"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta

from boatsim.autonomy import WaypointAutopilot
from boatsim.basestation import HoldCoursePolicy
from boatsim.comms import PerfectLink
from boatsim.config import load_design
from boatsim.mc import run_batch
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.vessel import KinematicVessel
from boatsim.viz import text_summary


def main(path: str = "configs/v4_kayak.yaml") -> None:
    design = load_design(path)
    env = ConstantEnvironment()
    c = Components(
        env=env,
        forecast=PerfectForecast(env),
        vessel=KinematicVessel(design),
        autopilot=WaypointAutopilot(),
        link=PerfectLink(),
        base=HoldCoursePolicy(),
    )
    lat, lon = design.voyage["drop_lat"], design.voyage["drop_lon"]

    def run_one(start, seed):
        return simulate(c, start, lat, lon, default_mission(), seed=seed)

    starts = [datetime(2020, 10, 1) + timedelta(days=7 * i) for i in range(4)]
    print(f"{design.name}: {text_summary(run_batch(run_one, starts))}  [STUB PHYSICS]")


if __name__ == "__main__":
    main(*sys.argv[1:])
