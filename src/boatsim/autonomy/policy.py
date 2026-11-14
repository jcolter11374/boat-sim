"""Which rules the autopilot sails by, as one numbered policy (Rosa, M5 piece G2).

The autopilot is three parts that each had their own defaults: the steering
(`guidance.WaypointAutopilot`), the battery rules (`safemode.SafeModeAutopilot`)
and base's daily re-planning (`basestation.replan.ForecastReplanPolicy`). A
policy names one setting of all three, so a change to how the boat sails is one
number that every caller can ask for, and two runs can be checked to be on the
same one.

* Policy 1: the autopilot as it stands behind the Boatyard's odds, the
  leaderboard and every recorded voyage. Nothing about it changes here.
* Policy 2: the same parts, set to sail sensibly. Found with
  `python -m boatsim.sandbox.rival_survey`: on 20 launch days of 2020 a player
  who gave one order ("straight at the finish") and never touched the boat again
  beat policy 1 on most days, by days. Three causes, three settings:

  1. Steering. Away from the coast policy 1 aims its course over the ground at
     the waypoint and crabs up to 20 degrees into a cross current to hold it.
     Across the Gulf Stream that spends the motors fighting water that is going
     the boat's way. Policy 2 points the bow at the waypoint and lets the current
     carry her (no crab), and holds the track line only within 50 km of a coast
     (policy 1: 150 km).
  2. Base's daily detours. Policy 1 lets base send a new leg, up to 60 degrees
     off, whenever its 3-day forecast says that saves 6 hours. Over a crossing
     those zig-zags cost more than they save. Policy 2 keeps base's daily "all
     well" and still replaces a leg that would hit land, but takes no detour
     for speed.
  3. Power. Policy 1 holds the design's cruise power whatever the sun gives, so
     the battery sits near full for most of the crossing (never under 42%, 86% on
     average, 12 June 2020). Policy 2 spends what the sun brings: more than
     cruise power on a full battery, cruise in the middle, and the same easing
     and the same hold as policy 1 when the battery runs down.

A policy sets how a boat under motor only is sailed (our kayak, the rowing
boat). Anything with a sail sails by policy 1 whatever is asked for
(runner/simulate.py standard_components): policy 2 was tuned and measured on
the kayak alone, a sailing boat needs base's weather routing (without it the
sail drone was up to 6 days slower on the 2020 days tried), and steering closer
to a coast is what grounded the sailing boats when it was last tried
(docs/qa/near75-coastal-stall-2026-11.md). A fair ghost for the sailing boats
is its own piece of work.

Every number in policy 2 is a GUESS tuned on 2020 only. It is used by the game
(sandbox/helm.py: the ghost and "let the autopilot sail") and nowhere else until
the ten-year gate has been run on it (docs/qa, Ravi) and the odds are regridded.

Owner: Rosa (policy 2); Sam (the autopilot).
"""

from __future__ import annotations

from dataclasses import dataclass

from boatsim.autonomy.safemode import DEFAULT_THROTTLE_STEPS


@dataclass(frozen=True)
class AutopilotPolicy:
    version: int
    # safemode.SafeModeAutopilot: (state-of-charge floor, fraction of cruise power).
    throttle_steps: tuple[tuple[float, float], ...]
    # guidance.WaypointAutopilot, pursuit mode.
    pursuit_crab_deg: float
    track_near_land_km: float
    # basestation: hours a new leg must save before base sends it. None: the planner's own number (6 h for the fan). Infinity: base
    # only ever replaces a leg that would hit land.
    replan_min_gain_h: float | None


POLICIES: dict[int, AutopilotPolicy] = {
    1: AutopilotPolicy(
        version=1,
        throttle_steps=DEFAULT_THROTTLE_STEPS,
        pursuit_crab_deg=20.0,
        track_near_land_km=150.0,
        replan_min_gain_h=None,
    ),
    2: AutopilotPolicy(
        version=2,
        # GUESSES. Above 90% charge 1.8 x cruise (45 W of the kayak's 25 W cruise),
        # above 75% 1.4 x (35 W), then policy 1's steps unchanged.
        throttle_steps=((0.90, 1.8), (0.75, 1.4), *DEFAULT_THROTTLE_STEPS),
        pursuit_crab_deg=0.0,
        track_near_land_km=50.0,  # GUESS
        replan_min_gain_h=float("inf"),
    ),
}

# What the odds, the leaderboard and the recorded voyages sail by.
ODDS_POLICY = 1
# What the game's ghost sails by, and the player's boat while the autopilot has her.
GAME_POLICY = 2


def policy(version: int) -> AutopilotPolicy:
    try:
        return POLICIES[version]
    except KeyError:
        raise ValueError(f"no autopilot policy {version!r}; known: {sorted(POLICIES)}") from None
