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
windage and current (the hull block).

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
from dataclasses import dataclass, fields
from datetime import timedelta
from pathlib import Path

import numpy as np

from boatsim.config import Design
from boatsim.types import BoatState, Command, EnvState, Event, EventKind
from boatsim.vessel import hull as H
from boatsim.vessel.hazards import MAX_THRUSTERS, SLOT
from boatsim.vessel.kayak import KayakState, KayakVessel, SpeedSolution, _boat_axes, solve_speed

KNOT = 0.514444
CONFIGS = Path(__file__).resolve().parents[3] / "configs"
DOWN = "down"  # sails down (bare poles)
GUST_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 1}"]  # a keelboat has no thrusters
STAYS_OVER_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 2}"]
SINK_SLOT = SLOT[f"thruster_{MAX_THRUSTERS - 3}"]
LEAK = "leak_main_tub"  # the hazards' leak (vessel/hazards.py), here water in the hull


@dataclass
class KeelboatState(KayakState):
    """KayakState plus what a yacht shows: fuel, sail plan, heel, engine."""

    fuel_l: float = 0.0
    sail_plan: str = "full"
    heel_deg: float = 0.0  # positive = leaning to starboard
    engine_on: bool = False


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
        names = [plan] if plan else self.plans
        return max(self.at(n, tws_ms / KNOT, twa_deg).speed for n in names)

    def beat_deg(self, tws_ms: float, plan: str | None = None) -> float:
        """Best upwind angle (deg) from the VPP, at a wind speed (m/s)."""
        b = self._beat[plan or self.plans[0]]
        return float(np.interp(tws_ms / KNOT, self.tws, b))


def polar_path(design: Design, base: Path | None = None) -> Path:
    name = design.vpp["polar_file"]
    for root in (base, Path("configs"), CONFIGS):
        if root is not None and (Path(root) / name).exists():
            return Path(root) / name
    raise FileNotFoundError(f"polar {name} for {design.name}: run python -m boatsim.vessel.vpp")


class KeelboatVessel(KayakVessel):
    """A sailing yacht for the Vessel protocol. Design: configs/stock_*.yaml."""

    def __init__(self, design: Design, polar: Polar | None = None):
        super().__init__(design)
        self.polar = polar or Polar.load(polar_path(design))
        v, prop = design.vpp, design.propulsion
        self.reef_heel_deg = float(v.get("reef_heel_deg", 25.0))
        self.engine_kn = float(prop.get("engine_cruise_kn", 0.0))
        self.engine_l_per_h = float(prop.get("engine_l_per_h", 0.0))
        self.engine_resist_n = float(prop.get("engine_resist_n", 1.0))
        self.engine_below_wind_kn = float(prop.get("engine_below_wind_kn", 5.0))
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

    # --- hooks into KayakVessel.step ---------------------------------------
    def _motoring(self, state: BoatState, cmd: Command, drive_w: float, working: int) -> bool:
        on = self._step["engine"] > 0.0
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
            heel, lee = pt.heel_deg, pt.leeway_deg
        motor_v = 0.0
        if self._step.get("motoring"):
            v0 = self.engine_kn * KNOT * self._step["engine"] ** (1.0 / 3.0)
            motor_v = v0 * (drag + aw / self.engine_resist_n) ** -0.5
        side = -1.0 if twa_signed > 0 else 1.0  # pushed away from the wind
        m0 = self.polar.at(plan, tws_kn, twa_signed).m0_nm if plan != DOWN else 0.0
        self._step.update(plan=plan, heel=side * heel, engine_used=motor_v > sail_v, m0=m0)
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
        engine = frac if wanted and fuel > 0.0 and not state.damage.get("engine") else 0.0
        self._step = {"engine": engine, "asked": cmd.sail_plan, "plan": DOWN, "heel": 0.0}
        new, events = super().step(state, cmd, env, dt, rng)
        used = self._step.get("engine_used", False) or self._step.get("motoring", False)
        burn = self.engine_l_per_h * engine * dt.total_seconds() / 3600.0 if used else 0.0
        out = KeelboatState(
            **{f.name: getattr(new, f.name) for f in fields(new)},
            fuel_l=max(fuel - burn, 0.0),
            sail_plan=self._step["plan"],
            heel_deg=self._step["heel"],
            engine_on=bool(used and engine > 0.0),
        )
        if out.alive and out.damage.get(LEAK) and self.p_sink_given_leak > 0.0:
            new_leak = not state.damage.get(LEAK)
            pump_dead = out.battery_wh <= 0.0
            if pump_dead or (new_leak and self._last_dice[SINK_SLOT] < self.p_sink_given_leak):
                why = "flooded: the bilge pump lost power" if pump_dead else "flooded and sank"
                events.append(Event(out.t, EventKind.LOST, why))
                out.alive = False
        if out.alive:
            hours = dt.total_seconds() / 3600.0
            p = self.gust_capsize_p(self._step.get("m0", 0.0), hours, env.rain)
            dice = self._last_dice
            if p > 0.0 and dice[GUST_SLOT] < p:
                t = out.t
                events.append(Event(t, EventKind.CAPSIZE, "knocked flat by a gust"))
                out.knockdowns += 1
                if dice[STAYS_OVER_SLOT] < self.hazards.p_capsize_stays_over:
                    events.append(Event(t, EventKind.LOST, "capsized in a gust and stayed over"))
                    out.alive = False
        return out, events
