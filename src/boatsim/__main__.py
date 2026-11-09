"""Smoke run: python -m boatsim configs/v4_kayak.yaml"""

from __future__ import annotations

import sys
from datetime import datetime, timedelta

from boatsim.autonomy import SafeModeAutopilot
from boatsim.basestation import ForecastReplanPolicy
from boatsim.comms import GlobalstarPinger, IridiumSBDLink
from boatsim.config import load_design
from boatsim.mc import run_batch
from boatsim.oceandata import ConstantEnvironment, PerfectForecast
from boatsim.runner import Components, simulate
from boatsim.runner.simulate import default_mission
from boatsim.vessel import KayakVessel
from boatsim.viz import text_summary


def main(path: str = "configs/v4_kayak.yaml") -> None:
    design = load_design(path)
    env = ConstantEnvironment()
    prop = design.propulsion
    # Cruise at the design power; safe mode throttles back on low charge (#15).
    cruise_fraction = prop["cruise_drive_w"] / prop["max_drive_w"]
    lat, lon = design.voyage["drop_lat"], design.voyage["drop_lon"]

    def run_one(start, seed):
        # Fresh components per voyage: the link's ledger and the autopilot's
        # safe-mode state must not carry over from one run to the next.
        c = Components(
            env=env,
            forecast=PerfectForecast(env),
            vessel=KayakVessel(design),
            autopilot=SafeModeAutopilot(cruise_fraction=cruise_fraction),
            link=IridiumSBDLink(),
            pinger=GlobalstarPinger(),
            base=ForecastReplanPolicy(route=default_mission().waypoints),
        )
        return simulate(c, start, lat, lon, default_mission(), seed=seed)

    starts = [datetime(2020, 10, 1) + timedelta(days=7 * i) for i in range(4)]
    print(
        f"{design.name}: {text_summary(run_batch(run_one, starts))}  [real hull and satellite link; stub weather]"
    )


if __name__ == "__main__":
    main(*sys.argv[1:])
