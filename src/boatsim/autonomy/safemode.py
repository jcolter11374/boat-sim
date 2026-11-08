"""Safe-mode rules: a Python copy of what the STM32 safe-mode controller does.

The STM32 is a small, simple backup computer that sits beside the Pixhawk. Its
job is to keep the boat alive and heading for Europe when something goes wrong.
It wraps the normal waypoint follower and changes only the throttle and, in one
case, which waypoint it aims for.

1. **Low battery: throttle back.** Below 50% charge the boat slows down, and
   below 15% it stops the motors and lets the sun recharge it. It only starts
   them again once the charge is back above 25%. That gap, called hysteresis,
   stops it flicking on and off at the threshold.
2. **Lost comms: keep going east on the stored route.** If nothing has come
   from base for `lost_comms_days`, the boat stops trusting route changes that
   point it backwards. It skips any waypoint that's already behind it (west of
   it) and heads due east (090°) if it runs out of route. It never just stops
   and waits.
3. **One dead thruster: keep the same push on the other.** The thrusters share
   the drive power. If one dies, the survivor gets the whole drive power, so
   cruise speed barely changes. The rudder corrects the lopsided push. If both
   die, motors are set to zero, and the boat keeps reporting and drifting.

Every threshold is a GUESS until bench tests on the real battery and the
STM32 firmware are written.

Owner: Sam.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from enum import Enum

from boatsim.autonomy.guidance import WaypointAutopilot
from boatsim.types import Command, Mission, Sensors, Waypoint


class Mode(str, Enum):
    NORMAL = "normal"
    LOW_BATTERY = "low_battery"  # throttled back
    BATTERY_HOLD = "battery_hold"  # motors off, recharging
    LOST_COMMS = "lost_comms"


# (state-of-charge floor, fraction of cruise power), checked top to bottom. GUESSES.
DEFAULT_THROTTLE_STEPS = ((0.50, 1.0), (0.30, 0.6), (0.15, 0.3))


class SafeModeAutopilot:
    """Wraps `WaypointAutopilot` with the STM32 rules. Implements `Autopilot`.

    `cruise_fraction` is the normal `thrust_fraction` (design cruise power over
    max drive power, 15 W / 100 W = 0.15 for v4).

    Thruster health comes from `sensors.thrusters_ok` (count working) when the
    Sensors type has that field; on the real boat the STM32 reads it from the
    motor controllers' current draw. Until then `set_thrusters_ok` sets it.

    Contact with base: call `on_message_received(t)` when a base message
    arrives. A new mission version also counts as contact.
    """

    def __init__(
        self,
        cruise_fraction: float = 1.0,
        guidance: WaypointAutopilot | None = None,
        thruster_count: int = 2,
        throttle_steps: tuple[tuple[float, float], ...] = DEFAULT_THROTTLE_STEPS,
        hold_below_soc: float = 0.15,  # GUESS: leaves ~190 Wh for electronics and nights
        resume_above_soc: float = 0.25,  # GUESS
        lost_comms_days: float = 5.0,  # GUESS: five missed daily check-ins
        east_margin_deg: float = 0.05,  # GUESS: ~4 km; waypoints this far west are "behind"
    ):
        self.cruise_fraction = cruise_fraction
        self.guidance = guidance or WaypointAutopilot()
        self.thruster_count = thruster_count
        self.throttle_steps = throttle_steps
        self.hold_below_soc = hold_below_soc
        self.resume_above_soc = resume_above_soc
        self.lost_comms = timedelta(days=lost_comms_days)
        self.east_margin_deg = east_margin_deg

        self.mode = Mode.NORMAL
        self.mode_log: list[tuple[datetime, Mode]] = []
        self._holding = False
        self._last_contact: datetime | None = None
        self._mission_version: int | None = None
        self._thrusters_ok: int | None = None
        self._fallback: Mission | None = None
        self._last_frac: float | None = None
        self._last_t: datetime | None = None
        self._mission_obj: Mission | None = None

    # ------------------------------------------------------------- inputs

    def reset(self) -> None:
        """Forget everything from a previous voyage (runs reuse one instance)."""
        self.__init__(
            cruise_fraction=self.cruise_fraction,
            guidance=self.guidance,
            thruster_count=self.thruster_count,
            throttle_steps=self.throttle_steps,
            hold_below_soc=self.hold_below_soc,
            resume_above_soc=self.resume_above_soc,
            lost_comms_days=self.lost_comms.total_seconds() / 86400.0,
            east_margin_deg=self.east_margin_deg,
        )
        self.guidance.reset()

    def on_message_received(self, t: datetime) -> None:
        self._last_contact = t

    def set_thrusters_ok(self, n: int) -> None:
        self._thrusters_ok = n

    # ------------------------------------------------------------- rules

    def throttle_scale(self, soc: float) -> float:
        """Fraction of cruise power allowed at this charge, with hysteresis."""
        if self._holding and soc >= self.resume_above_soc:
            self._holding = False
        elif not self._holding and soc < self.hold_below_soc:
            self._holding = True
        if self._holding:
            return 0.0
        for floor, scale in self.throttle_steps:
            if soc >= floor:
                return scale
        return self.throttle_steps[-1][1]

    def thruster_scale(self, sensors: Sensors) -> float:
        """Multiply the per-thruster setting so the survivors carry the full drive power."""
        ok = getattr(sensors, "thrusters_ok", None)
        if ok is None:
            ok = self._thrusters_ok
        if ok is None or ok >= self.thruster_count:
            return 1.0
        if ok <= 0:
            return 0.0
        return self.thruster_count / ok

    def comms_lost(self, t: datetime) -> bool:
        return self._last_contact is not None and t - self._last_contact >= self.lost_comms

    def _eastbound(self, sensors: Sensors, mission: Mission) -> Mission:
        """Skip stored waypoints that are behind the boat; due east if none are left.

        Skipped waypoints stay skipped (active_index moves on), so the boat
        doesn't turn back for them when contact returns.
        """
        wps = mission.waypoints
        for i in range(mission.active_index, len(wps)):
            if wps[i].lon > sensors.lon + self.east_margin_deg:
                mission.active_index = i
                self._fallback = None
                return mission
        mission.active_index = len(wps) - 1
        # Nothing ahead: aim at a far point due east. Arrival is any European coast.
        # Keep the same object while it's in use so guidance keeps one track line.
        if self._fallback is None:
            far = Waypoint(sensors.lat, min(sensors.lon + 20.0, 179.0))
            self._fallback = Mission([far], version=-1)
        return self._fallback

    # ----------------------------------------------------------- interface

    def update(self, sensors: Sensors, mission: Mission, t: datetime) -> Command:
        # A new voyage: time went backwards, or a fresh version-0 route appeared.
        new_route0 = mission is not self._mission_obj and mission.version == 0
        if self._last_t is not None and (t < self._last_t or new_route0):
            self.reset()
        self._last_t = t
        self._mission_obj = mission
        if self._last_contact is None:
            self._last_contact = t  # launch counts as contact
        if mission.version != self._mission_version:
            if self._mission_version is not None:
                self._last_contact = t
            self._mission_version = mission.version

        lost = self.comms_lost(t)
        follow = self._eastbound(sensors, mission) if lost else mission
        if not lost:
            self._fallback = None
        # Motors were off last step: the boat drifted, so don't learn a crab from it.
        self.guidance.hold_crab = self._last_frac is not None and self._last_frac <= 0.0
        cmd = self.guidance.update(sensors, follow, t)

        batt = self.throttle_scale(sensors.soc)
        frac = min(1.0, self.cruise_fraction * batt * self.thruster_scale(sensors))

        if self._holding:
            mode = Mode.BATTERY_HOLD
        elif batt < 1.0:
            mode = Mode.LOW_BATTERY
        elif lost:
            mode = Mode.LOST_COMMS
        else:
            mode = Mode.NORMAL
        if mode != self.mode or not self.mode_log:
            self.mode_log.append((t, mode))
        self.mode = mode
        self._last_frac = frac
        return Command(heading=cmd.heading, thrust_fraction=frac)
