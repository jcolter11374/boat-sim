"""KeelboatVessel: a sailing yacht (stock vessels), sailed from a polar.

Everything the kayak model does stays: energy, steering limits (it can't
point closer to the wind than min_upwind_twa_deg, it tacks with hysteresis,
it runs off in a storm), damage and hazards. Only the speed differs: each
step looks the boat speed up in a polar made offline by our VPP
(vessel/vpp.py) for the true wind, the wind angle and the sail plan, then
slows it for the real sea, fouling and damage.

Plain terms:
* A polar is a table of boat speed by wind speed and wind angle.
* Reefing makes the sails smaller in strong wind. The boat reefs itself
  ("auto") to the fastest sail plan that keeps the heel (lean) under
  reef_heel_deg, or the player picks one (Command.sail_plan).
* Leeway is the small sideways slide a sailboat makes, away from the wind.

Sea penalty. The polar is for flat water. In waves of height Hs coming
from a given angle off the bow, our VPP's added resistance (fitted to the
ORC certificate) is added to the polar's resistance at that speed, and the
speed falls by (R / (R + added))^(1 / r_exp), where r_exp is how steeply
resistance rises with speed there (both from the polar file). Fouling and
damage drag work the same way.

Engine: an inboard diesel with a fuel tank. With Command.thrust_fraction above
zero it runs when the true wind is below engine_below_wind_kn (calms) and
there is fuel, and the boat goes at whichever is faster, motor or sail. With
the sails down and no engine, the boat drifts with the kayak model's
windage and current (the hull block). Under power (QA, docs/qa/
helm-sail-engine-orders.md):
* One propeller can't steer: the engine only drives the boat while the
  autopilot is alive and the rudder works. Otherwise it stays off.
* A diesel never runs below idle: any throttle above zero is at least
  engine_idle_frac (GUESS 0.2), for both fuel burn and speed. That keeps a
  30 L tank to a couple of hundred miles at any throttle.
* Thrust at a throttle f is the calm-water resistance at the speed f gives
  (engine_resist_n at full, falling as f^(2/3)). The wind on the hull and rig
  (air_front_area_m2, air_cd_front, the true wind's head-on part) uses some of
  that thrust up, so a head wind slows the boat and a gale stops it.
* The engine's alternator charges the house battery (alternator_w, GUESS
  500 W into the bank) whenever it runs. Below charge_below_soc (GUESS 0.35)
  the autopilot computer starts it out of gear (a separate start battery
  turns it over) and idles it until the bank reaches charge_until_soc
  (GUESS 0.8), as a short-handed boat does. Out of gear it needs no rudder,
  but it needs the computer alive, and it never burns into the last
  fuel_reserve_l litres (GUESS 5). Idle burn is engine_idle_frac of full.

Overcanvassed. Each plan is cut for a wind range: flown so hard that it heels
past reef_heel_deg, the sails are overloaded by x = heel / reef_heel_deg - 1.
Each hour that costs a torn sail (damage "sail": no more sailing) with
chance sail_overload_per_h x^2, and a broach (rounding up, knocked flat)
with half that (GUESS both, set so full sail held for a day in 40 kn tears
something most of the time). The boat's own reefing stays under the limit,
so it never pays.

Gusts. The wind is never steady. We treat 3-second gusts as independent
draws (gusts_per_hour 1200) with spread gust_sigma 0.085 of the mean, which
puts the strongest gust in 10 minutes at about 1.23 x the mean: the WMO's
at-sea gust factor (WMO/TD-1555, 2010). A small boat answers a gust within
a few seconds, so 3-second gusts are the ones that count (GUESS). Rain
marks showers and squalls, whose downdrafts gust far harder: the spread
rises by squall_sigma_per_mm_h per mm/h of rain, up to squall_sigma_max
(GUESS 0.03 and 0.17, so heavy rain doubles it). The
autopilot trims for the mean wind, so a gust g times the mean pushes the
heeling moment up by g^2 (heel moment = m0 cos^3(heel), m0 from the polar).
If no heel below capsize_heel_deg balances it, the boat is knocked flat.
A ballasted keelboat can't be: its righting moment outgrows the falling
sail force all the way to 90 deg, so this only bites dinghies and
catamarans, whose stability comes from their crew (and there is none).
After a capsize the boat stays over with p_capsize_stays_over (hazards
block): 1 for a catamaran or a dinghy with nobody to right it.
Flooding. A leak (the hazards' leak, a ship strike, ...) is water in the
hull. A yacht's electric bilge pump keeps up with most leaks; with
p_sink_given_leak (vpp block, GUESS) it can't, and the boat sinks. If the
battery goes flat with a leak still open, the pump stops and it sinks too.
Foam-filled dinghies and sealed catamaran hulls float holed (0).
The dice come from the step's fixed block (hazards.SLOT), using the slots of
thrusters a keelboat doesn't have, so paired runs stay in step.
"""

from __future__ import annotations

import json
import math
from bisect import bisect_right
from dataclasses import dataclass, fields, replace
from datetime import timedelta
from pathlib import Path

import numpy as np

from boatsim.config import Design
from boatsim.types import BoatState, Command, EnvState, Event, EventKind, Sensors
from boatsim.vessel import hull as H
from boatsim.vessel.hazards import MAX_THRUSTERS, SLOT
from boatsim.vessel.kayak import (
    KayakState,
    KayakVessel,
    SpeedSolution,
    _boat_axes,
    has_brain,
    solve_speed,
)

KNOT = 0.514444
CONFIGS = Path(__file__).resolve().parents[3] / "configs"
DOWN = "down"  # sails down (bare poles)
GUST_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 1}"]  # a keelboat has no thrusters
STAYS_OVER_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 2}"]
SINK_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 3}"]
SAIL_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 4}"]
BROACH_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 5}"]
RHO_AIR = 1.225
LEAK = "leak_main_tub"  # the hazards' leak (vessel/hazards.py), here water in the hull


@dataclass
class KeelboatState(KayakState):
    """KayakState plus what a yacht shows: fuel, sail plan, heel, engine."""

    fuel_l: float = 0.0
    sail_plan: str = "full"
    heel_deg: float = 0.0  # positive = leaning to starboard
    engine_on: bool = False
    charging: bool = False  # engine idling out of gear to charge the battery
    # The masthead wind vane's last reading, relative to the water (for the
    # sailing tactician, autonomy/sailing.py): where the wind comes from (deg)
    # and its speed (m/s). None before the first step.
    wind_from_deg: float | None = None
    wind_speed_ms: float | None = None


@dataclass(frozen=True)
class PolarPoint:
    speed: float  # m/s, flat water
    heel_deg: float
    leeway_deg: float
    resist_n: float
    r_exp: float
    m0_nm: float = 0.0  # sails' heeling moment if upright (for gusts)


class Polar:
    """The VPP's table (configs/polars/*.json), bilinear in wind speed and angle."""

    COLS = ("speed_kn", "heel_deg", "leeway_deg", "resist_n", "r_exp", "m0_nm")

    def __init__(self, table: dict):
        self.tws = np.asarray(table["tws_kn"], float)
        self.twa = np.asarray(table["twa_deg"], float)
        self.waves_k = float(table.get("waves_k", 0.0))
        self.disp_kg = float(table.get("disp_kg", 0.0))
        self.plans = list(table["plans"])  # biggest sails first
        gz = table.get("gz", {"deg": [0, 90], "m": [0, 1]})
        self.gz_deg = np.asarray(gz["deg"], float)
        self.gz_m = np.asarray(gz["m"], float)
        self._beat = {n: np.asarray(p["beat_deg"], float) for n, p in table["plans"].items()}
        self._t = {
            name: {c: np.asarray(p[c], float) for c in self.COLS if c in p}
            for name, p in table["plans"].items()
        }
        # Plain-list copies for speed_ms, the autopilot's and base's hot path
        # (#322): the same numbers and arithmetic as at(), without building a
        # whole PolarPoint per plan or calling numpy for each lookup.
        self._tws_l = [float(x) for x in self.tws]
        self._twa_l = [float(x) for x in self.twa]
        self._speed_l = {
            name: [[float(x) for x in row] for row in c["speed_kn"]] if "speed_kn" in c else None
            for name, c in self._t.items()
        }

    @classmethod
    def load(cls, path) -> Polar:
        return cls(json.loads(Path(path).read_text()))

    def at(self, plan: str, tws_kn: float, twa_deg: float) -> PolarPoint:
        """Values at a true wind speed (kn) and angle off the bow (0-180 deg).
        Below the lowest wind speed the speed falls in proportion to the wind;
        above the highest it holds; inside the lowest angle it is zero (in
        irons: the sails just flap)."""
        t = self._t[plan]
        twa = min(abs(twa_deg), 180.0)
        if twa < self.twa[0] or tws_kn <= 0.0:
            return PolarPoint(0.0, 0.0, 0.0, 1.0, 2.0)
        scale = min(tws_kn / self.tws[0], 1.0)
        w = min(max(tws_kn, self.tws[0]), self.tws[-1])
        i = min(int(np.searchsorted(self.tws, w, side="right")) - 1, len(self.tws) - 2)
        j = min(int(np.searchsorted(self.twa, twa, side="right")) - 1, len(self.twa) - 2)
        fw = (w - self.tws[i]) / (self.tws[i + 1] - self.tws[i])
        fa = (twa - self.twa[j]) / (self.twa[j + 1] - self.twa[j])

        def val(c):
            if c not in t:
                return 0.0
            a = t[c]
            top = a[i, j] + (a[i, j + 1] - a[i, j]) * fa
            bot = a[i + 1, j] + (a[i + 1, j + 1] - a[i + 1, j]) * fa
            return float(top + (bot - top) * fw)

        return PolarPoint(
            val("speed_kn") * KNOT * scale,
            val("heel_deg") * scale * scale,
            val("leeway_deg"),
            max(val("resist_n") * scale * scale, 1.0),
            max(val("r_exp"), 1.0),
            val("m0_nm") * scale * scale,
        )

    def speed_ms(self, tws_ms: float, twa_deg: float, plan: str | None = None) -> float:
        """Flat-water boat speed (m/s) for the autopilot's tactician (autonomy):
        the given plan, or the fastest plan."""
        # Bit for bit the speed at() gives (same index search, same bilinear
        # arithmetic), shared across the plans: ten times faster (#322).
        names = [plan] if plan else self.plans
        tws_kn = tws_ms / KNOT
        tws, twa_g = self._tws_l, self._twa_l
        twa = min(abs(twa_deg), 180.0)
        if twa < twa_g[0] or tws_kn <= 0.0:
            return 0.0
        scale = min(tws_kn / tws[0], 1.0)
        w = min(max(tws_kn, tws[0]), tws[-1])
        i = min(bisect_right(tws, w) - 1, len(tws) - 2)
        j = min(bisect_right(twa_g, twa) - 1, len(twa_g) - 2)
        fw = (w - tws[i]) / (tws[i + 1] - tws[i])
        fa = (twa - twa_g[j]) / (twa_g[j + 1] - twa_g[j])
        best = None
        for n in names:
            a = self._speed_l[n]
            if a is None:
                v = 0.0
            else:
                r0, r1 = a[i], a[i + 1]
                top = r0[j] + (r0[j + 1] - r0[j]) * fa
                bot = r1[j] + (r1[j + 1] - r1[j]) * fa
                v = top + (bot - top) * fw
            sp = v * KNOT * scale
            if best is None or sp > best:
                best = sp
        return best

    def beat_deg(self, tws_ms: float, plan: str | None = None) -> float:
        """Best upwind angle (deg) from the VPP, at a wind speed (m/s)."""
        b = self._beat[plan or self.plans[0]]
        return float(np.interp(tws_ms / KNOT, self.tws, b))


VARIANTS = "polars/variants"  # sail and keel parts' polars, named <boat>-<fingerprint>.json


def variant_name(design: Design, stem: str) -> str:
    """Where the polar for this design's vpp block lives (a part changed it)."""
    from boatsim.vessel.vpp import fingerprint

    return f"{VARIANTS}/{stem}-{fingerprint(design.vpp)}.json"


def polar_path(design: Design, base: Path | None = None) -> Path:
    name = design.vpp["polar_file"]
    for root in (base, Path("configs"), CONFIGS):
        if root is not None and (Path(root) / name).exists():
            return Path(root) / name
    if name.startswith(VARIANTS + "/"):
        # A part's polar no one has saved yet: build it (the name is its fingerprint,
        # so it can't be stale) where the configs are, else beside this run.
        from boatsim.vessel.vpp import build_polar

        src = f"boatsim.vessel.vpp on {design.name} with Boatyard parts: all GUESS inputs"
        for root in (CONFIGS, Path("configs"), Path(".")):
            try:
                return build_polar(design.vpp, Path(root) / name, src)
            except OSError:
                continue
    raise FileNotFoundError(f"polar {name} for {design.name}: run python -m boatsim.vessel.vpp")


class KeelboatVessel(KayakVessel):
    """A sailing yacht for the Vessel protocol. Design: configs/stock_*.yaml."""

    def __init__(self, design: Design, polar: Polar | None = None):
        super().__init__(design)
        self.polar = polar or Polar.load(polar_path(design))
        v, prop = design.vpp, design.propulsion
        self.reef_heel_deg = float(v.get("reef_heel_deg", 25.0))
        # Baked into the polar's speeds by vpp.py (the file doesn't carry it): a
        # Command.trim_share replaces it for a helm spell's watch.
        self.autopilot_factor = float(v.get("autopilot_factor", 1.0))
        self.engine_kn = float(prop.get("engine_cruise_kn", 0.0))
        self.engine_l_per_h = float(prop.get("engine_l_per_h", 0.0))
        self.engine_resist_n = float(prop.get("engine_resist_n", 1.0))
        self.engine_below_wind_kn = float(prop.get("engine_below_wind_kn", 5.0))
        self.engine_idle_frac = float(prop.get("engine_idle_frac", 0.2))  # GUESS
        self.alternator_w = float(prop.get("alternator_w", 0.0))
        self.charge_below_soc = float(prop.get("charge_below_soc", 0.35))  # GUESS
        self.charge_until_soc = float(prop.get("charge_until_soc", 0.8))  # GUESS
        self.fuel_reserve_l = float(prop.get("fuel_reserve_l", 5.0))  # GUESS
        self.sail_overload_per_h = float(v.get("sail_overload_per_h", 1.0))  # GUESS
        self.fuel_l = float(prop.get("fuel_l", 0.0))
        self.p_sink_given_leak = float(v.get("p_sink_given_leak", 0.0))
        self.gust_sigma = float(v.get("gust_sigma", 0.085))  # WMO gust factor, see above
        self.gusts_per_hour = float(v.get("gusts_per_hour", 1200.0))  # 3-second gusts
        self.squall_sigma_per_mm_h = float(v.get("squall_sigma_per_mm_h", 0.03))  # GUESS
        self.squall_sigma_max = float(v.get("squall_sigma_max", 0.17))  # GUESS
        cap = min(float(v.get("capsize_heel_deg", 90.0)), 89.0)
        phi = np.radians(np.arange(0.0, cap + 0.01, 1.0))
        gz = np.interp(np.degrees(phi), self.polar.gz_deg, self.polar.gz_m)
        w = self.polar.disp_kg * H.G
        # Largest upright heeling moment the boat can hold below capsize_heel_deg.
        self.max_m0_nm = float(np.max(w * gz / np.cos(phi) ** 3)) if cap < 89.0 else math.inf
        self._step: dict = {}

    def initial_state(self, t, lat: float, lon: float) -> KeelboatState:
        k = super().initial_state(t, lat, lon)
        return KeelboatState(**{f.name: getattr(k, f.name) for f in fields(k)}, fuel_l=self.fuel_l)

    # --- sail plans -------------------------------------------------------
    def choose_plan(self, tws_kn: float, twa_deg: float, asked: str | None) -> str:
        """The sail plan to fly: the one asked for, or the fastest that keeps
        the heel under reef_heel_deg (the smallest if none does)."""
        if asked == DOWN or asked in self.polar.plans:
            return asked
        best, best_v = self.polar.plans[-1], -1.0
        for name in self.polar.plans:
            pt = self.polar.at(name, tws_kn, twa_deg)
            if pt.heel_deg <= self.reef_heel_deg and pt.speed > best_v:
                best, best_v = name, pt.speed
        return best

    def added_resistance(self, hs: float, wave_rel_deg: float) -> float:
        """vpp.added_resistance with the polar file's fitted size."""
        if self.polar.waves_k <= 0.0 or hs <= 0.0:
            return 0.0
        head = 0.5 * (1.0 + math.cos(math.radians(wave_rel_deg)))
        return self.polar.waves_k * self.polar.disp_kg * H.G * hs * hs * (0.15 + 0.85 * head)

    def gust_sigma_at(self, rain_mm_h: float) -> float:
        """Gust spread (share of the mean wind), higher in showers and squalls."""
        extra = self.squall_sigma_per_mm_h * max(rain_mm_h, 0.0)
        return min(self.gust_sigma + extra, max(self.squall_sigma_max, self.gust_sigma))

    def gust_capsize_p(self, m0_nm: float, hours: float, rain_mm_h: float = 0.0) -> float:
        """Chance that a gust knocks the boat flat in `hours` with the sails
        trimmed for a mean-wind heeling moment m0_nm (upright)."""
        if m0_nm <= 0.0 or not math.isfinite(self.max_m0_nm):
            return 0.0
        g = math.sqrt(self.max_m0_nm / m0_nm)  # gust ratio that capsizes it
        sigma = self.gust_sigma_at(rain_mm_h)
        p = 0.5 * math.erfc((g - 1.0) / (sigma * math.sqrt(2.0)))
        return 1.0 - (1.0 - p) ** (self.gusts_per_hour * hours)

    def wants_charge(self, state: BoatState, fuel: float) -> bool:
        """Does the autopilot computer run the engine to charge the battery?"""
        if self.alternator_w <= 0.0 or state.damage.get("engine"):
            return False
        alive = getattr(state, "electronics_on", True) and state.battery_wh > 0.0
        if not has_brain(state.damage) or not alive:
            return False  # no computer left to start it (either box can: GUESS)
        if fuel <= self.fuel_reserve_l:
            return False
        cap = state.battery_capacity_wh
        soc = state.battery_wh / cap if cap > 0 else 1.0
        if getattr(state, "charging", False):
            return soc < self.charge_until_soc
        return soc < self.charge_below_soc

    # --- hooks into KayakVessel.step ---------------------------------------
    def _motoring(
        self, state: BoatState, cmd: Command, drive_w: float, working: int, rudder_ok: bool
    ) -> bool:
        on = self._step["engine"] > 0.0 and rudder_ok  # one propeller: the rudder steers
        self._step["motoring"] = on
        return on

    def _solve(
        self,
        heading: float,
        push_w: float,
        working: int,
        env: EnvState,
        foul: float,
        cur_e: float,
        cur_n: float,
        extra_drag_mult: float,
        sail_alpha_max: float,
    ) -> SpeedSolution:
        wx, wy = _boat_axes(heading, env.wind_u - cur_e, env.wind_v - cur_n)
        tws_kn = math.hypot(wx, wy) / KNOT
        twa_signed = math.degrees(math.atan2(-wy, -wx))  # + = wind from starboard
        wave_rel = abs((env.wave_dir - heading + 180.0) % 360.0 - 180.0)
        aw = self.added_resistance(env.hs, wave_rel)
        drag = (1.0 + foul) * extra_drag_mult
        plan = DOWN
        sail_v = heel = lee = 0.0
        if sail_alpha_max > 0.0:
            plan = self.choose_plan(tws_kn, twa_signed, self._step["asked"])
        if plan != DOWN:
            pt = self.polar.at(plan, tws_kn, twa_signed)
            sail_v = pt.speed * (drag + aw / pt.resist_n) ** (-1.0 / pt.r_exp)
            share = self._step.get("trim_share")
            if share is not None:  # a player's watch: their share of the crew's best speed
                sail_v *= share / self.autopilot_factor
            heel, lee = pt.heel_deg, pt.leeway_deg
        motor_v = 0.0
        if self._step.get("motoring"):
            f = self._step["engine"]
            v0 = self.engine_kn * KNOT * f ** (1.0 / 3.0)
            thrust = self.engine_resist_n * f ** (2.0 / 3.0)
            head = -wx  # true wind's part on the nose, m/s (boat axes: x forward)
            h = self.hull
            air = 0.5 * RHO_AIR * h.air_cd_front * h.air_front_area_m2 * head * abs(head)
            left = max(1.0 - air / thrust, 0.0)
            motor_v = v0 * math.sqrt(left / (drag + aw / self.engine_resist_n))
        side = -1.0 if twa_signed > 0 else 1.0  # pushed away from the wind
        m0 = self.polar.at(plan, tws_kn, twa_signed).m0_nm if plan != DOWN else 0.0
        self._step.update(plan=plan, heel=side * heel, engine_used=motor_v > sail_v, m0=m0)
        self._step["overload"] = max(heel / self.reef_heel_deg - 1.0, 0.0) if plan != DOWN else 0.0
        surge = max(sail_v, motor_v)
        if surge <= 0.0:  # bare poles, no engine: drift like any hull
            return solve_speed(
                self.hull, self.thrusters, heading, 0.0, 0, env, foul, cur_e, cur_n, extra_drag_mult
            )
        if motor_v > sail_v:
            lee *= 0.3  # GUESS: under power the keel meets the water head on
        sway = side * surge * math.tan(math.radians(lee))
        return SpeedSolution(surge, sway, 0.0, 0.0, aw)

    def step(
        self,
        state: BoatState,
        cmd: Command,
        env: EnvState,
        dt: timedelta,
        rng: np.random.Generator,
    ) -> tuple[KeelboatState, list[Event]]:
        fuel = getattr(state, "fuel_l", self.fuel_l)
        tws_kn = math.hypot(env.wind_u - env.current_u, env.wind_v - env.current_v) / KNOT
        frac = min(max(cmd.thrust_fraction, 0.0), 1.0)
        wanted = cmd.engine if cmd.engine is not None else tws_kn < self.engine_below_wind_kn
        if frac > 0.0:
            frac = max(frac, self.engine_idle_frac)  # a diesel never runs below idle
        engine = frac if wanted and fuel > 0.0 and not state.damage.get("engine") else 0.0
        self._step = {"engine": engine, "asked": cmd.sail_plan, "plan": DOWN, "heel": 0.0}
        self._step["trim_share"] = cmd.trim_share
        charging = self.wants_charge(state, fuel)
        new, events = super().step(state, cmd, env, dt, rng)
        hours = dt.total_seconds() / 3600.0
        used = self._step.get("engine_used", False) or self._step.get("motoring", False)
        in_gear = used and engine > 0.0
        burn = self.engine_l_per_h * engine * hours if used else 0.0
        if charging and not in_gear:  # idling out of gear
            burn = self.engine_l_per_h * self.engine_idle_frac * hours
        running = in_gear or charging
        if running and self.alternator_w > 0.0:
            cap = new.battery_capacity_wh
            put = self.alternator_w * hours * self.battery.charge_eff
            new.battery_wh = min(new.battery_wh + put, cap)
        out = KeelboatState(
            **{f.name: getattr(new, f.name) for f in fields(new)},
            fuel_l=max(fuel - burn, 0.0),
            sail_plan=self._step["plan"],
            heel_deg=self._step["heel"],
            engine_on=running,
            charging=charging,
            wind_from_deg=_wind_from(env),
            wind_speed_ms=math.hypot(env.wind_u - env.current_u, env.wind_v - env.current_v),
        )
        if out.alive and out.damage.get(LEAK) and self.p_sink_given_leak > 0.0:
            new_leak = not state.damage.get(LEAK)
            pump_dead = out.battery_wh <= 0.0
            if pump_dead or (new_leak and self._last_dice[SINK_SLOT] < self.p_sink_given_leak):
                why = "flooded: the bilge pump lost power" if pump_dead else "flooded and sank"
                events.append(Event(out.t, EventKind.LOST, why))
                out.alive = False
        dice = self._last_dice
        x = self._step.get("overload", 0.0)
        if out.alive and x > 0.0 and self.sail_overload_per_h > 0.0:
            rate = self.sail_overload_per_h * x * x
            if not out.damage.get("sail") and dice[SAIL_SLOT] < 1.0 - math.exp(-rate * hours):
                out.damage["sail"] = True
                why = f"sail (blown out: {self._step['plan']} flown at {abs(out.heel_deg):.0f} deg heel)"
                events.append(Event(out.t, EventKind.PART_FAILED, why))
            if dice[BROACH_SLOT] < 1.0 - math.exp(-0.5 * rate * hours):
                events.append(Event(out.t, EventKind.CAPSIZE, "broached under too much sail"))
                out.knockdowns += 1
                if dice[STAYS_OVER_SLOT] < self.hazards.p_capsize_stays_over:
                    events.append(Event(out.t, EventKind.LOST, "broached and stayed over"))
                    out.alive = False
        if out.alive:
            p = self.gust_capsize_p(self._step.get("m0", 0.0), hours, env.rain)
            if p > 0.0 and dice[GUST_SLOT] < p:
                t = out.t
                events.append(Event(t, EventKind.CAPSIZE, "knocked flat by a gust"))
                out.knockdowns += 1
                if dice[STAYS_OVER_SLOT] < self.hazards.p_capsize_stays_over:
                    events.append(Event(t, EventKind.LOST, "capsized in a gust and stayed over"))
                    out.alive = False
        return out, events

    def sense(self, state: BoatState, rng: np.random.Generator) -> Sensors:
        """The kayak's sensors plus the wind vane (truth for now, like the GPS)."""
        base = super().sense(state, rng)
        return replace(
            base,
            wind_from_deg=getattr(state, "wind_from_deg", None),
            wind_speed_ms=getattr(state, "wind_speed_ms", None),
        )


def _wind_from(env: EnvState) -> float:
    """Where the wind blows from (deg), relative to the water."""
    we, wn = env.wind_u - env.current_u, env.wind_v - env.current_v
    return (math.degrees(math.atan2(we, wn)) + 180.0) % 360.0
