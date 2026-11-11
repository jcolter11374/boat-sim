"""The joke fleet's odd boats: honest physics for absurd craft (stock vessels).

Each is the kayak model (drag, windage, drift, hazards) plus up to three
things the kayak never needed, all set in the design's `odd:` block:

* Muscle power. A person (or two) paddling or pedalling: crew_w watts at the
  paddle, paddle or wheel losses in thruster_efficiency, for crew_hours a
  day starting at crew_start_hour (local sun time, from longitude), falling
  by fatigue_per_day to no less than fatigue_floor (GUESS). The design's
  "battery" is then food and water (no solar), sized so it doesn't run out
  first; the autopilot only steers.
* Swamping. An open boat fills when wave crests top its freeboard (the
  height of its edge above the water). A small boat rides up and down long
  waves, so only the water moving relative to it counts: about pi L / lambda
  of the wave height for a boat of length L on waves lambda long, but never
  less than rel_floor (GUESS 0.35: the short chop riding on the big waves).
  Crests are Rayleigh distributed, about 0.6 x that relative height, so a
  share exp(-2 (freeboard / (0.6 rel Hs))^2) of waves top it; each ships
  ship_l litres (GUESS). A crew bails bail_l_per_h while awake (awake_hours a day, from
  crew_start_hour). When the water reaches
  swamp_l the boat is swamped: it floats (most do) but nobody can paddle or
  steer it any more. That ends the voyage, and the event says why.
* A kite. Pulls downwind only: it adds kite_cda_m2 of drag area to the
  windage (a kite is a drag device on a string). Each hour the wind is
  below kite_min_ms, it falls in the sea with p_kite_drop_per_lull_h and
  nobody can relaunch it.

Random draws use the step's fixed dice block (hazards.SLOT), in slots of
thrusters these boats don't have, so paired runs stay in step.

Lifetime limits (a pool float's seams) use the hazards' Weibull "unknown"
failure (unknown_p_by_60_days, unknown_shape), reworded by loss_words.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, fields, replace
from datetime import timedelta

import numpy as np

from boatsim.config import Design
from boatsim.types import BoatState, Command, EnvState, Event, EventKind
from boatsim.vessel.coast import distance_to_land_km
from boatsim.vessel.hazards import MAX_THRUSTERS, SLOT, phase, tag_phase
from boatsim.vessel.kayak import KayakState, KayakVessel

SWAMP_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 1}"]
KITE_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 2}"]
G = 9.81
CREST_PER_HS = 0.6  # crest height / wave height, Rayleigh seas (GUESS: steep seas run higher)


@dataclass
class OddState(KayakState):
    water_l: float = 0.0  # in the boat
    kite_up: bool = False
    crew_working: bool = False


class OddBoatVessel(KayakVessel):
    """The kayak model plus muscle power, swamping and a kite (module doc)."""

    def __init__(self, design: Design):
        super().__init__(design)
        o = design.stock.get("odd", {})
        self.crew_w = float(o.get("crew_w", 0.0))
        self.crew_hours = float(o.get("crew_hours", 0.0))
        self.crew_start_hour = float(o.get("crew_start_hour", 7.0))
        self.awake_hours = float(o.get("awake_hours", max(self.crew_hours, 16.0)))
        self.fatigue_per_day = float(o.get("fatigue_per_day", 0.0))
        self.fatigue_floor = float(o.get("fatigue_floor", 1.0))
        self.freeboard_m = o.get("freeboard_m")  # None = closed deck, never swamps
        self.ship_l = float(o.get("ship_l", 0.0))
        self.rel_floor = float(o.get("rel_floor", 0.35))
        self.bail_l_per_h = float(o.get("bail_l_per_h", 0.0))
        self.swamp_l = float(o.get("swamp_l", math.inf))
        self.kite_cda_m2 = float(o.get("kite_cda_m2", 0.0))
        self.kite_min_ms = float(o.get("kite_min_ms", 0.0))
        self.p_kite_drop_per_lull_h = float(o.get("p_kite_drop_per_lull_h", 0.0))
        self.loss_words = dict(o.get("loss_words", {}))
        self._bare_hull = self.hull
        if self.kite_cda_m2 > 0.0:
            h = self.hull
            self._kite_hull = replace(
                h,
                air_side_area_m2=h.air_side_area_m2 + self.kite_cda_m2 / max(h.air_cd_side, 1e-6),
                air_front_area_m2=h.air_front_area_m2
                + self.kite_cda_m2 / max(h.air_cd_front, 1e-6),
            )

    def initial_state(self, t, lat: float, lon: float) -> OddState:
        k = super().initial_state(t, lat, lon)
        return OddState(
            **{f.name: getattr(k, f.name) for f in fields(k)}, kite_up=self.kite_cda_m2 > 0
        )

    def _since_start(self, state: BoatState) -> float:
        """Hours since the crew's day began, local sun time from longitude."""
        hour = (state.t.hour + state.t.minute / 60.0 + state.lon / 15.0) % 24.0
        return (hour - self.crew_start_hour) % 24.0

    def crew_on(self, state: BoatState) -> bool:
        """Is the crew paddling now?"""
        return self.crew_hours > 0.0 and self._since_start(state) < self.crew_hours

    def crew_awake(self, state: BoatState) -> bool:
        """Is the crew awake (and so bailing) now?"""
        return self.awake_hours > 0.0 and self._since_start(state) < self.awake_hours

    def crew_power_w(self, state: BoatState) -> float:
        t0 = getattr(state, "t_launch", None) or state.t
        days = (state.t - t0).total_seconds() / 86400.0
        return self.crew_w * max(1.0 - self.fatigue_per_day * days, self.fatigue_floor)

    def topping_share(self, hs: float, tp: float) -> float:
        """Share of waves whose crest tops the freeboard, relative to the boat."""
        if self.freeboard_m is None or hs <= 0.05:
            return 0.0
        wavelength = G * max(tp, 1.0) ** 2 / (2.0 * math.pi)  # deep water
        rel = min(max(math.pi * self.hull.waterline_length_m / wavelength, self.rel_floor), 1.0)
        return math.exp(-2.0 * (float(self.freeboard_m) / (CREST_PER_HS * rel * hs)) ** 2)

    def step(
        self,
        state: BoatState,
        cmd: Command,
        env: EnvState,
        dt: timedelta,
        rng: np.random.Generator,
    ) -> tuple[OddState, list[Event]]:
        hours = dt.total_seconds() / 3600.0
        water = getattr(state, "water_l", 0.0)
        kite = getattr(state, "kite_up", False)
        working = self.crew_on(state) and state.alive
        if self.crew_w > 0.0:
            # The crew is the motor: full effort while on shift, nothing off it.
            frac = min(self.crew_power_w(state) / self.crew_w, 1.0) if working else 0.0
            cmd = replace(cmd, thrust_fraction=frac)
        self.hull = self._kite_hull if kite else self._bare_hull
        new, events = super().step(state, cmd, env, dt, rng)
        self.hull = self._bare_hull
        dice = self._last_dice
        tws = math.hypot(env.wind_u, env.wind_v)
        p_drop = 1.0 - (1.0 - self.p_kite_drop_per_lull_h) ** hours
        if kite and tws < self.kite_min_ms and dice[KITE_SLOT] < p_drop:
            kite = False
            new.damage["kite"] = True
            events.append(Event(new.t, EventKind.PART_FAILED, "kite (fell in the sea in a lull)"))
        waves = 3600.0 / max(env.tp, 1.0) * hours
        shipped = self.ship_l * waves * self.topping_share(env.hs, env.tp)
        bailed = self.bail_l_per_h * hours if self.crew_awake(state) and state.alive else 0.0
        water = max(water + shipped - bailed, 0.0)
        out = OddState(
            **{f.name: getattr(new, f.name) for f in fields(new)},
            water_l=water,
            kite_up=kite,
            crew_working=working,
        )
        if out.alive and water >= self.swamp_l:
            ph = phase(self.hazards, distance_to_land_km(out.lat, out.lon))
            why = f"swamped: waves over a {self.freeboard_m} m edge filled it"
            events.append(Event(out.t, EventKind.LOST, tag_phase(why, ph)))
            out.alive = False
        if self.loss_words:
            events = [self.reword(e) if e.kind == EventKind.LOST else e for e in events]
        return out, events

    def reword(self, e: Event) -> Event:
        """'stuck inverted or keel lost [open ocean]' -> this boat's own words,
        keeping the phase tag. Keys are the cause before any ' (' or ' ['."""
        base, sep, tag = e.detail.partition(" [")
        key = base.split(" (")[0].split(":")[0]
        if key not in self.loss_words:
            return e
        return replace(e, detail=self.loss_words[key] + (sep + tag if sep else ""))
