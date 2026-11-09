"""KayakVessel: the v4 solar-electric kayak, replacing the M0 KinematicVessel.

Each 10-minute step:

1. Work out drive power: what the autopilot asked for, limited by the
   thrusters that still work and by what the battery can deliver.
2. Find the speed through the water where thrust plus the push of the wind
   balances drag (calm-water drag x fouling x rough water). The kayak reaches
   steady speed in well under a minute, so a steady balance per step is fine.
3. Find the sideways slip (leeway) where the wind's side force balances the
   keel and hull.
4. Add the ocean current and the waves' Stokes drift, and move the boat.

With no drive power the boat can't steer and lies beam-on to the wind (GUESS),
so it drifts with wind and current: the M1 drifter comparison case.

5. Draw hazards (vessel/hazards.py): knockdowns from breaking waves, the
   parts they break, ship strikes, then leaks, electronics, Iridium and
   beacon failures, steering, entanglement, thrusters and capture. A loss is
   tagged with its phase, near land or open ocean. Broken panels cut solar; a broken
   rudder leaves steering to differential thrust, which needs both thrusters.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, replace
from datetime import datetime, timedelta

import numpy as np

from boatsim.config import Design
from boatsim.geo import move
from boatsim.types import BoatState, Command, EnvState, Event, EventKind, Sensors
from boatsim.vessel import hull as H
from boatsim.vessel import sail as S
from boatsim.vessel.coast import distance_to_land_km
from boatsim.vessel.hazards import (
    DEFAULT_PANELS_W,
    OPEN_OCEAN,
    HazardParams,
    draw_dice,
    phase,
    sample_failures,
    sample_hazards,
    tag_phase,
)
from boatsim.vessel.power import BatteryParams, SolarParams, energy_step, solar_power_w
from boatsim.vessel.propulsion import ThrusterParams, total_thrust

THRUSTER_PARTS = ("thruster_port", "thruster_starboard")  # the v4 pair


def thruster_parts(count: int) -> tuple[str, ...]:
    """Damage-dict names for the thrusters a boat actually has."""
    if count == 1:
        return ("thruster_centre",)
    if count == 2:
        return THRUSTER_PARTS
    return tuple(f"thruster_{i + 1}" for i in range(count))


@dataclass
class KayakState(BoatState):
    """BoatState plus what the kayak model needs to remember or wants logged.

    Subclassing keeps the shared BoatState contract untouched; the runner just
    hands this back to step() each time.
    """

    t_launch: datetime | None = None
    speed_over_ground: float = 0.0  # m/s
    course_over_ground: float = 0.0  # deg, compass
    leeway_deg: float = 0.0  # angle between heading and track through the water
    solar_w: float = 0.0
    drive_w: float = 0.0
    hotel_w: float = 0.0
    fouling_frac: float = 0.0
    electronics_on: bool = True
    knockdowns: int = 0  # total so far this voyage
    days_open_ocean: float = 0.0  # offshore days; counted only with wear-out on (#118)

    @property
    def iridium_ok(self) -> bool:
        """Can the boat send reports and check its Iridium mailbox? Needs power,
        the main box (it holds the RockBLOCK) and the comms path itself."""
        return (
            self.electronics_on
            and not self.damage.get("electronics_main", False)
            and not self.damage.get("comms_silent", False)
        )

    @property
    def beacon_ok(self) -> bool:
        """Is the Globalstar beacon still pinging? It has its own solar cell."""
        return not self.damage.get("beacon", False)


@dataclass(frozen=True)
class SpeedSolution:
    surge: float  # m/s through the water along the heading
    sway: float  # m/s through the water to starboard
    thrust_n: float
    drag_n: float
    wave_frac: float
    sail_alpha_deg: float = 0.0  # wing angle to the apparent wind (sailing designs)
    sail_drive_n: float = 0.0  # wing's forward force


def _boat_axes(heading_deg: float, east: float, north: float) -> tuple[float, float]:
    """World (east, north) -> boat (forward, starboard)."""
    h = math.radians(heading_deg)
    s, c = math.sin(h), math.cos(h)
    return east * s + north * c, east * c - north * s


def _world_axes(heading_deg: float, fwd: float, stbd: float) -> tuple[float, float]:
    """Boat (forward, starboard) -> world (east, north)."""
    h = math.radians(heading_deg)
    s, c = math.sin(h), math.cos(h)
    return fwd * s + stbd * c, fwd * c - stbd * s


def _surge_root(surplus) -> float:
    """Speed where surplus(u) = 0. surplus() falls as u rises (more drag, less
    thrust, less tailwind), so a bracketed root-finder is safe. Illinois variant
    of regula falsi."""
    lo, hi = -3.0, 4.0
    f_lo, f_hi = surplus(lo), surplus(hi)
    while f_hi > 0.0 and hi < 64.0:  # storm tailwind: widen the bracket
        hi *= 2.0
        f_hi = surplus(hi)
    u = 0.0
    side = 0
    for _ in range(60):
        u = (lo * f_hi - hi * f_lo) / (f_hi - f_lo)
        f = surplus(u)
        if abs(f) < 1e-6 or hi - lo < 1e-6:
            break
        if f > 0:
            lo, f_lo = u, f
            if side == 1:
                f_hi *= 0.5
            side = 1
        else:
            hi, f_hi = u, f
            if side == -1:
                f_lo *= 0.5
            side = -1
    return u


SAIL_PASSES = 4  # surge / leeway / wing-angle passes; settles to < 1 mm/s


def solve_speed(
    hp: H.HullParams,
    tp: ThrusterParams,
    heading_deg: float,
    drive_w: float,
    working_thrusters: int,
    env: EnvState,
    fouling: float,
    current_e: float,
    current_n: float,
    extra_drag_mult: float = 1.0,
    sail: S.SailParams | None = None,
    sail_alpha_max_deg: float = 0.0,
) -> SpeedSolution:
    """Steady speed through the water for a given heading and drive power.

    With a sail, the wing's drive and side force join the balances; the wing
    angle (up to `sail_alpha_max_deg`, 0 = feathered) is re-chosen each pass.
    """
    # Wind relative to the water, in boat axes. (The boat's own speed is
    # subtracted inside the balances, which is what makes them self-consistent.)
    wx, wy = _boat_axes(heading_deg, env.wind_u - current_e, env.wind_v - current_n)
    wave_rel = (env.wave_dir - heading_deg) % 360.0
    f_wave = H.wave_drag_frac(hp, env.hs, wave_rel)
    mult = (1.0 + fouling) * (1.0 + f_wave) * extra_drag_mult

    def surplus_with(wing_fx):
        def surplus(u: float) -> float:
            thrust = total_thrust(tp, drive_w, u, working_thrusters)
            fx, _ = H.air_force(hp, wx - u, 0.0)
            return thrust + fx + wing_fx(u) - H.calm_drag(hp, u) * mult

        return surplus

    if sail is None:
        u = _surge_root(surplus_with(lambda u: 0.0))
        v = H.lateral_speed(hp, wy, u)
        thrust = total_thrust(tp, drive_w, u, working_thrusters)
        return SpeedSolution(u, v, thrust, H.calm_drag(hp, u) * mult, f_wave)

    # The wing feels the wind at its own (low) height.
    k = S.wind_factor(sail, env.hs)
    ax, ay = k * wx, k * wy
    u = v = alpha = 0.0
    for _ in range(SAIL_PASSES):
        alpha = S.best_alpha(sail, ax - u, ay - v, sail_alpha_max_deg)
        u = _surge_root(
            surplus_with(lambda u, a=alpha, v=v: S.wing_force(sail, ax - u, ay - v, a)[0])
        )
        fy = S.wing_force(sail, ax - u, ay - v, alpha)[1]
        v = H.lateral_speed_with_force(hp, wy, u, fy)
    drive = S.wing_force(sail, ax - u, ay - v, alpha)[0]
    thrust = total_thrust(tp, drive_w, u, working_thrusters)
    return SpeedSolution(
        u, v, thrust, H.calm_drag(hp, u) * mult, f_wave, math.degrees(alpha), drive
    )


class KayakVessel:
    """Physics for the v4 kayak. Drop-in for the Vessel protocol."""

    def __init__(self, design: Design):
        self.hull = H.HullParams.from_config(design.hull)
        self.thrusters = ThrusterParams.from_config(design.propulsion)
        self.solar = SolarParams.from_config(design.power)
        self.battery = BatteryParams.from_config(design.power)
        e = design.electronics
        self.nav_light_w = float(e.get("nav_light_w", 0.5))
        dark_hours = float(e.get("nav_light_hours_per_day", 8.0))
        hotel_wh = float(e.get("hotel_load_wh_per_day", 85.0))
        # Everything except the light runs all day; the light runs when it's dark.
        self.base_hotel_w = (hotel_wh - self.nav_light_w * dark_hours) / 24.0
        self.dark_ghi = float(e.get("nav_light_on_below_ghi", 5.0))
        self.min_steer_w = float(design.propulsion.get("min_steer_w", 1.0))  # GUESS
        self.hazards = HazardParams.from_config(design.hazards)
        self.thruster_parts = thruster_parts(self.thrusters.count)
        self.panels_w = dict(design.power.get("panels_w", DEFAULT_PANELS_W))
        self._panels_total_w = sum(self.panels_w.values()) or 1.0
        # Sailing designs: a wing sail; the rudder steers whenever the autopilot is
        # powered, with no drive power needed (vessel/sail.py).
        self.sail = S.SailParams.from_config(design.sail)
        # No independent beacon fitted (comms.beacon: false): count it as failed
        # from the start, so a silent main radio means a silent boat.
        self.has_beacon = bool(design.comms.get("beacon", True))

    def initial_state(self, t, lat: float, lon: float) -> KayakState:
        cap = self.battery.capacity_wh
        state = KayakState(
            t=t, lat=lat, lon=lon, battery_wh=cap, battery_capacity_wh=cap, t_launch=t
        )
        if not self.has_beacon:
            state.damage["beacon"] = True
        return state

    def extra_drag_mult(self, state: BoatState) -> float:
        """Drag from damage: line or weed caught on the boat, a rudder jammed over."""
        m = 1.0
        if state.damage.get("entangled"):
            m *= 1.0 + self.hazards.entangle_extra_drag
        if state.damage.get("rudder_jammed"):
            m *= self.hazards.rudder_jam_drag_mult
        return m

    def panel_fraction(self, state: BoatState) -> float:
        """Share of rated solar still on deck after damage."""
        left = sum(w for k, w in self.panels_w.items() if not state.damage.get(k, False))
        return left / self._panels_total_w

    def working_thrusters(self, state: BoatState) -> int:
        return sum(1 for k in self.thruster_parts if not state.damage.get(k, False))

    def step(
        self,
        state: BoatState,
        cmd: Command,
        env: EnvState,
        dt: timedelta,
        rng: np.random.Generator,
    ) -> tuple[KayakState, list[Event]]:
        events: list[Event] = []
        hours = dt.total_seconds() / 3600.0
        t_launch = getattr(state, "t_launch", None) or state.t
        days = (state.t - t_launch).total_seconds() / 86400.0
        was_on = getattr(state, "electronics_on", True)
        cap = state.battery_capacity_wh

        # --- Energy -----------------------------------------------------------
        on = was_on or (cap > 0 and state.battery_wh / cap >= self.battery.restart_soc)
        working = self.working_thrusters(state)
        frac = min(max(cmd.thrust_fraction, 0.0), 1.0)
        drive_req = frac * self.thrusters.max_power_each_w * working if on else 0.0
        hotel_req = 0.0
        if on:
            hotel_req = self.base_hotel_w + (self.nav_light_w if env.ghi < self.dark_ghi else 0.0)
        solar = solar_power_w(self.solar, env.ghi, env.hs, env.air_temp)
        solar *= self.panel_fraction(state)
        es = energy_step(
            self.battery, state.battery_wh, solar, drive_req, hotel_req, hours, env.air_temp
        )
        if es.battery_wh <= 0.0 and state.battery_wh > 0.0:
            events.append(Event(state.t + dt, EventKind.BATTERY_EMPTY))
        on_next = on and es.battery_wh > 0.0

        # --- Motion -----------------------------------------------------------
        cur_e, cur_n = env.current_u, env.current_v
        if self.hull.stokes_drift:
            se, sn = H.stokes_drift(env.hs, env.tp, env.wave_dir)
            cur_e, cur_n = cur_e + se, cur_n + sn

        # Rudder gone: differential thrust can still steer, but only with two working
        # thrusters. A one-thruster boat can't steer at all without its rudder.
        sail_alpha_max = 0.0
        if self.sail is not None:
            # A sailboat steers with its rudder alone: it needs the autopilot powered
            # and the rudder working. It can't point into the wind (sail_heading).
            steering = on and not state.damage.get("rudder")
        else:
            can_steer = working >= (2 if state.damage.get("rudder") else 1)
            steering = es.drive_w >= self.min_steer_w and can_steer
        if steering and self.sail is not None:
            we, wn = env.wind_u - cur_e, env.wind_v - cur_n
            wind_from = (math.degrees(math.atan2(we, wn)) + 180.0) % 360.0
            tws = math.hypot(env.wind_u, env.wind_v)
            heading, feather = S.sail_heading(self.sail, cmd.heading, wind_from, state.heading, tws)
            if not feather and not state.damage.get("sail"):
                sail_alpha_max = self.sail.max_alpha_deg
        elif steering:
            heading = cmd.heading
        else:
            # Can't steer: lie beam-on to the wind relative to the water.
            we, wn = env.wind_u - cur_e, env.wind_v - cur_n
            if we == 0.0 and wn == 0.0:
                heading = state.heading
            else:
                wind_to = math.degrees(math.atan2(we, wn))
                heading = (wind_to + self.hull.drift_heading_offset_deg) % 360.0

        foul = H.fouling_frac(self.hull, days)
        # A boat that can't steer just turns circles: the power is spent (until the
        # autopilot cuts it) but it makes no headway, so it drifts.
        push_w = es.drive_w if steering else 0.0
        sol = solve_speed(
            self.hull,
            self.thrusters,
            heading,
            push_w,
            working,
            env,
            foul,
            cur_e,
            cur_n,
            extra_drag_mult=self.extra_drag_mult(state),
            sail=self.sail,
            sail_alpha_max_deg=sail_alpha_max,
        )
        ve, vn = _world_axes(heading, sol.surge, sol.sway)
        ge, gn = ve + cur_e, vn + cur_n
        secs = dt.total_seconds()
        lat, lon = move(state.lat, state.lon, ge * secs, gn * secs)

        new = KayakState(
            t=state.t + dt,
            lat=lat,
            lon=lon,
            heading=heading,
            speed_through_water=math.hypot(sol.surge, sol.sway),
            battery_wh=es.battery_wh,
            battery_capacity_wh=cap,
            alive=state.alive,
            damage=dict(state.damage),
            t_launch=t_launch,
            speed_over_ground=math.hypot(ge, gn),
            course_over_ground=math.degrees(math.atan2(ge, gn)) % 360.0,
            leeway_deg=math.degrees(math.atan2(sol.sway, max(abs(sol.surge), 1e-9))),
            solar_w=es.solar_w,
            drive_w=es.drive_w,
            hotel_w=es.hotel_w,
            fouling_frac=foul,
            electronics_on=on_next,
        )
        # One fixed block of dice per step, so the stream stays in step across
        # runs whose paths differ (hazards.SLOT).
        dice = draw_dice(rng)
        hz = sample_hazards(self.hazards, env, hours, state.damage, new.t, dice)
        events += hz.events
        new.knockdowns = getattr(state, "knockdowns", 0) + hz.knockdowns
        new.days_open_ocean = getattr(state, "days_open_ocean", 0.0)
        if (
            self.hazards.wearout_k != 1.0
            and phase(self.hazards, distance_to_land_km(new.lat, new.lon)) == OPEN_OCEAN
        ):
            new.days_open_ocean += hours / 24.0
        for part in hz.failed_parts:
            new.damage[part] = True
        fl = sample_failures(
            self.hazards,
            env,
            hours,
            new.damage,
            new.t,
            new.lat,
            new.lon,
            days + hours / 48.0,
            dice,
            thrusters=self.thruster_parts,
            days_open_ocean=new.days_open_ocean,
        )
        events += fl.events
        for part in fl.failed_parts:
            new.damage[part] = True
        for part in fl.cleared_parts:
            new.damage.pop(part, None)
        if hz.lost or fl.lost:
            new.alive = False
            ph = phase(self.hazards, distance_to_land_km(new.lat, new.lon))
            events = [
                replace(e, detail=tag_phase(e.detail, ph)) if e.kind == EventKind.LOST else e
                for e in events
            ]
        return new, events

    def sense(self, state: BoatState, rng: np.random.Generator) -> Sensors:
        # Truth for now; GPS and compass noise belong with the sensor-failure work.
        return Sensors(
            t=state.t,
            lat=state.lat,
            lon=state.lon,
            heading=state.heading,
            soc=state.soc,
            thrusters_ok=self.working_thrusters(state),
        )


def with_damage(state: KayakState, part: str) -> KayakState:
    """Copy of `state` with one part marked failed (helper for tests and hazards)."""
    return replace(state, damage={**state.damage, part: True})
