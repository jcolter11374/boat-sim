from __future__ import annotations

from datetime import timedelta
from typing import Protocol

import numpy as np

from boatsim.config import Design
from boatsim.geo import heading_to_vector, move
from boatsim.types import BoatState, Command, EnvState, Event, EventKind, Sensors


class Vessel(Protocol):
    def initial_state(self, t, lat: float, lon: float) -> BoatState: ...

    def step(
        self, state: BoatState, cmd: Command, env: EnvState, dt: timedelta, rng: np.random.Generator
    ) -> tuple[BoatState, list[Event]]:
        """Advance the boat by dt. Return the new state and anything that happened."""
        ...

    def sense(self, state: BoatState, rng: np.random.Generator) -> Sensors:
        """What the onboard computer can measure."""
        ...


class KinematicVessel:
    """Stub for M0: no drag curve, no waves, no hazards.

    Speed through the water is a fixed design speed times thrust fraction.
    Solar = GHI x panel area-equivalent x a flat derate. Theo replaces all of this.
    """

    def __init__(self, design: Design):
        p = design.power
        self.cruise_speed = design.propulsion.get("cruise_speed_kt", 1.7) * 0.514444
        self.max_drive_w = design.propulsion.get("max_drive_w", 120.0)
        self.hotel_w = design.electronics.get("hotel_load_wh_per_day", 85.0) / 24.0
        self.panel_wp = p.get("solar_wp", 250.0)
        self.solar_derate = p.get("solar_system_derate", 0.6)
        self.capacity_wh = p.get("battery_wh", 1280.0)

    def initial_state(self, t, lat: float, lon: float) -> BoatState:
        return BoatState(
            t=t, lat=lat, lon=lon, battery_wh=self.capacity_wh, battery_capacity_wh=self.capacity_wh
        )

    def step(self, state, cmd, env, dt, rng):
        events: list[Event] = []
        hours = dt.total_seconds() / 3600.0

        # Energy: solar in (rated Wp scales with irradiance / 1000 W/m^2), drive and hotel out.
        solar_w = self.panel_wp * (env.ghi / 1000.0) * self.solar_derate
        drive_w = self.max_drive_w * cmd.thrust_fraction if state.battery_wh > 0 else 0.0
        battery = state.battery_wh + (solar_w - drive_w - self.hotel_w) * hours
        battery = min(max(battery, 0.0), state.battery_capacity_wh)
        if battery == 0.0 and state.battery_wh > 0.0:
            events.append(Event(state.t + dt, EventKind.BATTERY_EMPTY))

        # Motion: through-water velocity + current.
        stw = self.cruise_speed * cmd.thrust_fraction if battery > 0 else 0.0
        ve, vn = heading_to_vector(cmd.heading, stw)
        ve += env.current_u
        vn += env.current_v
        lat, lon = move(state.lat, state.lon, ve * dt.total_seconds(), vn * dt.total_seconds())

        new = BoatState(
            t=state.t + dt,
            lat=lat,
            lon=lon,
            heading=cmd.heading,
            speed_through_water=stw,
            battery_wh=battery,
            battery_capacity_wh=state.battery_capacity_wh,
            alive=state.alive,
            damage=dict(state.damage),
        )
        return new, events

    def sense(self, state, rng):
        return Sensors(
            t=state.t, lat=state.lat, lon=state.lon, heading=state.heading, soc=state.soc
        )
