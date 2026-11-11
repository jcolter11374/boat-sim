"""Sensitivity study (issue #21): which change to the design or its settings
moves the odds for April to June launches?

Each variant is the v4 kayak with one thing changed: how the base station
talks to it, the battery, the solar panels, the cruise power, or the safe-mode
battery rules. Every variant sails the SAME launches with the SAME seeds, so
the weather, the forecast error and the hazard dice are identical; only the
change differs. That pairing is what makes small differences visible: a voyage
that arrives in one variant and not in the other is a real effect of the
change (or of the dice being rolled at different moments once the boats
diverge), not a different year's weather.

Read the result with two cautions:

* **Ceiling.** About 93% of April to June launches already arrive in the
  baseline, so a change can't gain many arrivals. The report also shows
  median days at sea and the odds with the 'unknown failure' guess put back
  (months.swept_odds): a faster crossing spends fewer days exposed to
  failures we haven't modelled, so it scores better there.
* **Noise.** With n paired voyages, a gain or loss of a few arrivals is
  within chance. The sign test on the voyages that flipped says how likely
  that split is if the change did nothing.

Dollar costs aren't in yet: the parts catalogue (#25) will price battery and
panel changes. Settings changes (cruise power, safe mode, base policy) are free.
Airtime per voyage is reported, since it is an output to minimise.

One thruster instead of two (`one_thruster`) needs #65 and #66 (thruster
count decides which thrusters exist and can fail), so compare it only with a
baseline run on the same commit or later.

Owner: Ravi.
"""

from __future__ import annotations

import argparse
import math
import os
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

import pandas as pd

from boatsim.config import patched_design
from boatsim.mc.months import (
    MAX_DAYS,
    MONTHS,
    WINDOW,
    MeteredVessel,
    MonthlyVoyage,
    summarise,
    swept_odds,
    wilson,
)
from boatsim.mc.stats import sign_test
from boatsim.runner.simulate import DROP_POINT


@dataclass(frozen=True)
class Variant:
    group: str  # what kind of change: comms, battery, solar, cruise, safe mode
    label: str  # plain words for John
    # (design section, key, new value), e.g. ("power", "battery_wh", 640)
    design: tuple[tuple[str, str, float], ...] = ()
    # "replan": the team's ForecastReplanPolicy; "no_corrections": same daily
    # "all well" message but never a new route; "silent": base sends nothing.
    base: str = "replan"
    safemode: tuple[tuple[str, object], ...] = ()  # SafeModeAutopilot keyword overrides
    link: tuple[tuple[str, object], ...] = ()  # IridiumSBDLink attribute overrides
    # Launch route as (lat, lon) waypoints; empty keeps runner.default_mission.
    route: tuple[tuple[float, float], ...] = ()
    # Finish: (lat, lon) of a Microtransat target on the eastern line, or
    # "old_rule" for the pre-#80 rule (any landfall in Europe, Azores included).
    finish: tuple[float, float] | str | None = None
    # Hours a forecast detour must save before the base sends it (base="replan"
    # only; None keeps the policy default, 6 h). Land and keep-out detours
    # ignore it.
    min_gain_h: float | None = None
    # WaypointAutopilot keyword overrides (e.g. steer="pursuit"), under safe mode.
    guidance: tuple[tuple[str, object], ...] = ()
    # How base plans (runner.simulate standard_components routing=): None keeps
    # the design's own ("fan" unless it says otherwise), or "fan" / "isochrone".
    routing: str | None = None
    # Forecast error scale for base (1 = the error model as it stands, 2 = twice
    # as bad); None keeps the voyage's own. A router that leans on the forecast
    # should keep its gain when the forecast is worse.
    forecast_error: float | None = None
    # The row this variant is paired against in the report.
    against: str = "baseline"


BAY_MOUTH = DROP_POINT  # first waypoint of every route, as in default_mission (the drop)
# Pre-#80 route and rule, for the old-vs-new comparison (Maya, Nov 2026).
OLD_ROUTE = (BAY_MOUTH, (38.5, -28.0), (39.5, -9.6))
_OLD_EUROPE_BOXES = [  # rough sea areas next to European coasts (old arrival.py)
    (36.0, 44.0, -10.5, -8.0),  # Portugal and NW Spain, Atlantic coast
    (43.0, 48.5, -5.0, -1.0),  # Bay of Biscay
    (48.0, 51.5, -6.0, 2.0),  # Brittany, Channel
    (49.5, 59.5, -11.0, -5.0),  # Ireland, west Scotland
    (59.5, 71.0, 4.0, 15.0),  # Norway
]


class OldRuleFinish:
    """The arrival rule before #80: any landfall in Europe, the Azores included
    (within 300 km of the islands' centre, or in a sea box next to a European
    coast). Only for comparing odds under the old and new rules. The silence
    limit from #80 still applies; under the old rule a silent boat had lost both
    electronics boxes anyway, which was already a loss."""

    def reached(self, lat: float, lon: float) -> bool:
        from boatsim.geo import distance_m

        if distance_m(lat, lon, 38.5, -28.0) < 300_000.0:
            return True
        return any(a <= lat <= b and c <= lon <= d for a, b, c, d in _OLD_EUROPE_BOXES)


def _target(lat: float, lon: float, label: str) -> Variant:
    return Variant(
        "finish target",
        f"Finish target at {label}, straight route there",
        route=(BAY_MOUTH, (lat, lon)),
        finish=(lat, lon),
    )


# All values are trial settings to compare, not recommendations.
VARIANTS: dict[str, Variant] = {
    "baseline": Variant("baseline", "The design as it stands"),
    "no_corrections": Variant(
        "comms",
        "Base never changes the route (still sends a daily 'all well')",
        base="no_corrections",
    ),
    "replan_24h": Variant(
        "comms",
        "Base changes the route only for a forecast gain of 24 hours or more",
        min_gain_h=24.0,
    ),
    "replan_72h": Variant(
        "comms",
        "Base changes the route only for a forecast gain of 72 hours or more",
        min_gain_h=72.0,
    ),
    "silent_base": Variant(
        "comms",
        "Base sends nothing; boat follows its stored route, then heads east",
        base="silent",
    ),
    "mailbox_scheduled": Variant(
        "comms",
        "Boat checks for base messages on a separate daily call, not with its report",
        link=(("mailbox", "scheduled"),),
    ),
    "old_rule": Variant(
        "finish rule",
        "Old rule: any landfall in Europe, Azores included (old route via the Azores)",
        route=OLD_ROUTE,
        finish="old_rule",
    ),
    # Finish targets along the Microtransat eastern line (Maya, Nov 2026), each
    # sailed straight there (great circle, which passes north of the Azores).
    # Since the baseline also goes straight to 39.5N 13.5W, target_39_5n matches
    # it; it stays so the sweep reads north to south. dogleg_azores is the old
    # baseline route (via 36N 26W, south of the Azores), for comparison.
    "target_51n": _target(51.0, -16.0, "51N 16W (west of Ireland)"),
    "target_46n": _target(46.0, -11.0, "46N 11W (Bay of Biscay)"),
    "target_44_5n": _target(44.5, -13.5, "44.5N 13.5W (off NW Spain)"),
    "target_39_5n": _target(39.5, -13.5, "39.5N 13.5W (off Lisbon)"),
    "target_37n": _target(37.0, -13.5, "37N 13.5W (off SW Portugal)"),
    "dogleg_azores": Variant(
        "route",
        "Old route: dog-leg south of the Azores via 36N 26W",
        route=(BAY_MOUTH, (36.0, -26.0), (39.5, -13.5)),
        finish=(39.5, -13.5),
    ),
    # Hazard assumptions (#89, #91). The baseline uses the "planning" rate set,
    # which assumes a 14-day unattended shakedown trial before the drop. John
    # confirmed it is planned (9 Nov 2026); no_shakedown shows what it is worth.
    "no_shakedown": Variant(
        "hazards",
        "No 14-day shakedown trial before the drop",
        (("hazards", "shakedown_days", 0.0),),
    ),
    # Drop distance (decided 9 Nov 2026: 100 km, the default). The route still
    # starts at the 100 km point, which lies on the way out from either.
    "drop_29km": Variant(
        "drop",
        "Old drop point, 29 km out (36.85N 75.70W)",
        (("voyage", "drop_lat", 36.85), ("voyage", "drop_lon", -75.70)),
    ),
    "drop_50km": Variant(
        "drop",
        "Fallback drop point, 50 km out (36.79N 75.48W)",
        (("voyage", "drop_lat", 36.79), ("voyage", "drop_lon", -75.48)),
    ),
    "historical_rates": Variant(
        "hazards",
        "Failure rates fitted to the Microtransat record, not the planning set",
        (("hazards", "rate_set", "historical"),),
    ),
    # Wear-out (#118): open-ocean hardware rates rise with days offshore. The
    # record can't tell this from a constant rate; these bracket the fit.
    "wearout_central": Variant(
        "hazards",
        "Kit wears out at sea: failure rate rises with days offshore (best fit)",
        (("hazards", "wearout_k", 1.41), ("hazards", "wearout_t_ref_days", 34.9)),
    ),
    "wearout_high": Variant(
        "hazards",
        "Kit wears out fast at sea (top of the record's range)",
        (("hazards", "wearout_k", 2.24), ("hazards", "wearout_t_ref_days", 48.6)),
    ),
    # Record-check bounds (#118, Theo): how much one shared electronics fault
    # and worse knockdowns would cost, on the historical set.
    "historical_common_0_1": Variant(
        "hazards",
        "Record failure rates, electronics boxes rarely fail together (10%)",
        (("hazards", "rate_set", "historical"), ("hazards", "electronics_common_cause", 0.1)),
    ),
    "historical_common_1_0": Variant(
        "hazards",
        "Record failure rates, one electronics fault kills both boxes (like most record boats)",
        (("hazards", "rate_set", "historical"), ("hazards", "electronics_common_cause", 1.0)),
    ),
    "historical_inverted_x10": Variant(
        "hazards",
        "Record failure rates, a capsize leaves the boat stuck upside down 10x as often",
        (("hazards", "rate_set", "historical"), ("hazards", "p_inverted_stuck", 4e-4)),
    ),
    "historical_inverted_x30": Variant(
        "hazards",
        "Record failure rates, a capsize leaves the boat stuck upside down 30x as often",
        (("hazards", "rate_set", "historical"), ("hazards", "p_inverted_stuck", 1.2e-3)),
    ),
    "historical_wearout_high": Variant(
        "hazards",
        "Record failure rates plus fast wear-out",
        (
            ("hazards", "rate_set", "historical"),
            ("hazards", "wearout_k", 2.24),
            ("hazards", "wearout_t_ref_days", 48.6),
        ),
    ),
    "battery_640": Variant(
        "battery", "Half the battery (one 50 Ah pack, 640 Wh)", (("power", "battery_wh", 640),)
    ),
    "battery_1920": Variant(
        "battery", "Half again the battery (1920 Wh)", (("power", "battery_wh", 1920),)
    ),
    "solar_150": Variant("solar", "Smaller panels (150 W)", (("power", "solar_wp", 150),)),
    "solar_350": Variant("solar", "Bigger panels (350 W)", (("power", "solar_wp", 350),)),
    "cruise_10w": Variant(
        "cruise", "Slower cruise (10 W motor power)", (("propulsion", "cruise_drive_w", 10),)
    ),
    # The default cruise is 25 W since #113 (it was 15 W). These rows bracket it.
    "cruise_15w": Variant(
        "cruise", "Old cruise (15 W motor power)", (("propulsion", "cruise_drive_w", 15),)
    ),
    "cruise_20w": Variant(
        "cruise", "Slower cruise (20 W motor power)", (("propulsion", "cruise_drive_w", 20),)
    ),
    "cruise_30w": Variant(
        "cruise", "Faster cruise (30 W motor power)", (("propulsion", "cruise_drive_w", 30),)
    ),
    "one_thruster": Variant(
        "thrusters",
        "One thruster instead of two (same cruise power, 50 W burst)",
        (("propulsion", "thruster_count", 1), ("propulsion", "max_drive_w", 50)),
    ),
    "hold_at_30": Variant(
        "safe mode",
        "Stop motors earlier: below 30% charge, restart at 40%",
        safemode=(("hold_below_soc", 0.30), ("resume_above_soc", 0.40)),
    ),
    "no_throttle_back": Variant(
        "safe mode",
        "Never slow down on low battery; only stop at 15%",
        safemode=(("throttle_steps", ((0.15, 1.0),)),),
    ),
    "track": Variant(
        "steering",
        "Hold the track line everywhere, crabbing up to 60 degrees into the current "
        "(the default until 11 Nov 2026)",
        guidance=(("steer", "track"),),
    ),
    "pursuit": Variant(
        "steering",
        "Far from land, aim straight at the next waypoint and let the current carry "
        "the boat sideways (crab at most 20 degrees); hold the track line near land "
        "(now the default, so this row matches the design as it stands)",
        guidance=(("steer", "pursuit"),),
    ),
    # Weather routing for the sailing boats (#269): run with --design on a stock
    # sailboat (configs/stock_sail_drone7.yaml or stock_cruiser31.yaml).
    "isochrone": Variant(
        "routing",
        "Base routes on the forecast with isochrones (5-day weather router)",
        routing="isochrone",
    ),
    "fan": Variant(
        "routing",
        "Base plans with the fan of 3-day legs (every boat's default, and the "
        "wind-powered drone's before 11 Nov 2026)",
        routing="fan",
    ),
    "fan_table": Variant(
        "routing",
        "Today's planner with a wing-sail boat's own speed table (#269)",
        routing="fan_table",
    ),
    "fan_forecast_x2": Variant(
        "routing",
        "Today's planner, forecast error doubled",
        routing="fan",
        forecast_error=2.0,
    ),
    "isochrone_forecast_x2": Variant(
        "routing",
        "Isochrone router, forecast error doubled (paired with the row above)",
        routing="isochrone",
        forecast_error=2.0,
        against="fan_forecast_x2",
    ),
    "no_tactician": Variant(
        "steering",
        "Wing-sail drone without the tactician (#279): the wing picks its own tacks, "
        "with no look-ahead for land (the drone before 11 Nov 2026)",
        design=(("electronics", "tactician", False),),
    ),
    "pursuit_nocrab": Variant(
        "steering",
        "As pursuit, but never crab into the current far from land",
        guidance=(("steer", "pursuit"), ("pursuit_crab_deg", 0.0)),
    ),
}

FIRST_BATCH = tuple(VARIANTS)


@dataclass(frozen=True)
class SensitivityVoyage(MonthlyVoyage):
    """MonthlyVoyage with one variant applied."""

    variant: str = "baseline"

    def spec(self) -> Variant:
        """The variant's settings (subclasses may look them up elsewhere)."""
        return VARIANTS[self.variant]

    def drop_point(self) -> tuple[float, float]:
        from boatsim.config import load_design

        v = patched_design(load_design(self.design_path), self.spec().design).voyage
        return v["drop_lat"], v["drop_lon"]

    def mission(self):
        from boatsim.types import Mission, Waypoint

        v = self.spec()
        if not v.route:
            return super().mission()
        return Mission(waypoints=[Waypoint(lat, lon) for lat, lon in v.route])

    def components(self, seed: int = 0):
        from boatsim.autonomy import SafeModeAutopilot
        from boatsim.basestation import ForecastReplanPolicy, HoldCoursePolicy
        from boatsim.config import load_design
        from boatsim.runner.arrival import FinishTarget
        from boatsim.vessel import KayakVessel

        v = self.spec()
        c = super().components(seed)
        design = patched_design(load_design(self.design_path), v.design)
        if v.design:
            inner = KayakVessel(design)
            if self.unknown_p_by_60_days is not None:  # same override as MonthlyVoyage
                from dataclasses import replace as _replace

                inner.hazards = _replace(
                    inner.hazards, unknown_p_by_60_days=self.unknown_p_by_60_days
                )
            c.vessel = MeteredVessel(inner)
        if v.design or v.safemode or v.guidance:
            from boatsim.autonomy import WaypointAutopilot

            prop = design.propulsion
            c.autopilot = SafeModeAutopilot(
                cruise_fraction=prop["cruise_drive_w"] / prop["max_drive_w"],
                thruster_count=int(prop.get("thruster_count", 2)),
                guidance=WaypointAutopilot(**dict(v.guidance)) if v.guidance else None,
                **dict(v.safemode),
            )
        if v.routing is not None or v.forecast_error is not None:
            # Base and its forecast as standard_components builds them for this
            # routing and error, on the same weather (the forecast's truth).
            from boatsim.runner.simulate import standard_components

            alt = standard_components(
                design,
                c.env,
                c.forecast.truth,
                seed=seed,
                forecast_error=self.forecast_error
                if v.forecast_error is None
                else v.forecast_error,
                routing="fan" if v.routing == "fan_table" else v.routing,
            )
            c.base, c.forecast = alt.base, alt.forecast
            if v.routing == "fan_table":
                # Today's fan planner, but costing a wing-sail boat with no VPP
                # polar from its own speed table, as the isochrone router does.
                from boatsim.basestation.isochrone import SteadyPolar

                # Boats with a polar or no wing are costed as before (same as "fan").
                boat = getattr(c.vessel, "inner", c.vessel)
                if getattr(boat, "polar", None) is None and getattr(boat, "sail", None):
                    table = SteadyPolar(boat)
                    c.base = ForecastReplanPolicy(
                        route=self.mission().waypoints,
                        polar=table,
                        boat_speed=ForecastReplanPolicy.polar_factor * table.speed_ms(7.0, 100.0),
                        min_twa_deg=boat.sail.min_upwind_twa_deg,
                        max_twa_deg=boat.sail.min_downwind_twa_deg,
                    )
        route = self.mission().waypoints
        if v.base == "no_corrections":
            c.base = ForecastReplanPolicy(route=route, min_gain_h=math.inf)
        elif v.base == "silent":
            c.base = HoldCoursePolicy()
        elif v.base != "replan":
            raise ValueError(f"unknown base policy {v.base!r}")
        elif v.route or v.min_gain_h is not None:
            kw = {} if v.min_gain_h is None else {"min_gain_h": v.min_gain_h}
            c.base = ForecastReplanPolicy(route=route, **kw)
        if v.finish == "old_rule":
            c.finish = OldRuleFinish()
        elif v.finish is not None:
            c.finish = FinishTarget(*v.finish)
        for attr, value in v.link:
            if not hasattr(c.link, attr):
                raise AttributeError(f"link has no setting {attr!r}")
            setattr(c.link, attr, value)
        return c


def window_launches(year: int, every_days: int = 10, months=WINDOW) -> list[datetime]:
    """Launch times (noon UTC) every `every_days` days through the window."""
    out, t = [], datetime(year, months[0], 1, 12)
    while t.month in months:
        out.append(t)
        t += timedelta(days=every_days)
    return out


def _tagged(args):
    from boatsim.runner.parallel import _call

    name, task = args
    row = _call(task)
    row["variant"] = name
    return row


def run_year(
    year: int,
    variants=FIRST_BATCH,
    every_days: int = 10,
    workers: int | None = 4,
    **job_kw,
) -> pd.DataFrame:
    """Every variant over the same launches and seeds (seed = year * 1000 + i)."""
    starts = window_launches(year, every_days)
    tasks = []
    for name in variants:
        job = SensitivityVoyage(variant=name, **job_kw)
        tasks += [(name, (job, summarise, s, year * 1000 + i)) for i, s in enumerate(starts)]
    workers = workers or os.cpu_count() or 1
    if workers == 1:
        rows = [_tagged(t) for t in tasks]
    else:
        with ProcessPoolExecutor(max_workers=workers) as pool:
            rows = list(pool.map(_tagged, tasks))
    df = pd.DataFrame(rows)
    df["design"] = Path(job_kw.get("design_path") or "configs/v4_kayak.yaml").stem
    return df


# --- Report -----------------------------------------------------------------


def compare(df: pd.DataFrame) -> pd.DataFrame:
    """One row per variant, paired against the baseline voyage by voyage."""
    key = ["start", "seed"]
    rows = []
    for name in [v for v in VARIANTS if v in set(df["variant"])]:
        v = VARIANTS[name]
        against = v.against if v.against in set(df["variant"]) else "baseline"
        base = df[df["variant"] == against].set_index(key)
        base_ok = base["outcome"] == "arrived"
        g = df[df["variant"] == name]
        ok = g["outcome"] == "arrived"
        k = int(ok.sum())
        p, lo, hi = wilson(k, len(g))
        pair = g.set_index(key)["outcome"].eq("arrived")
        common = pair.index.intersection(base_ok.index)
        gained = int((pair[common] & ~base_ok[common]).sum())
        lost = int((~pair[common] & base_ok[common]).sum())
        # Days saved on voyages that finish both ways (positive = faster).
        both = common[pair[common].values & base_ok[common].values]
        saved = base.loc[both, "days"] - g.set_index(key).loc[both, "days"]
        air = g["airtime_usd"].median() if "airtime_usd" in g else math.nan
        rows.append(
            {
                "variant": name,
                "group": v.group,
                "label": v.label,
                "voyages": len(g),
                "arrived": k,
                "within_150": int((ok & (g["days"] <= 150.0)).sum()),
                "odds": p,
                "low95": lo,
                "high95": hi,
                "gained": gained,
                "lost": lost,
                "sign_p": sign_test(gained, lost),
                "median_days": g.loc[ok, "days"].median() if k else math.nan,
                "odds_unknown_10": swept_odds(g, 0.10),
                "odds_unknown_50": swept_odds(g, 0.50),
                "airtime_usd": air,
                "min_soc": g["min_soc"].median(),
                "against": against,
                "both_finished": len(both),
                "median_days_saved": saved.median() if len(both) else math.nan,
                "faster": int((saved > 0).sum()),
                "slower": int((saved < 0).sum()),
            }
        )
    return pd.DataFrame(rows)


def report_markdown(df: pd.DataFrame) -> str:
    t = compare(df)
    years = sorted(df["year"].unique())
    months = sorted(df["month"].unique())
    n = int(t["voyages"].max())
    stem = df["design"].iloc[0] if "design" in df.columns else "v4_kayak"
    boat = "the v4 kayak" if stem == "v4_kayak" else f"`{stem}`"
    lines = [
        "# Sensitivity study: April to June launches",
        "",
        (
            f"Each row is {boat} with one change, sailing the same {n} launches "
            f"({MONTHS[months[0] - 1]} to {MONTHS[months[-1] - 1]}, {years[0]} to "
            f"{years[-1]}, real weather and currents) with the same random dice. "
            "'Finished' follows each row's own finish rule (the Microtransat target "
            "unless the row says otherwise); 'within 150 days' counts those that made it "
            "by day 150. 'Gained' and 'lost' count voyages that finish with the change but not "
            "without it, and the other way round. 'Chance' is how likely that split "
            "is if the change did nothing; above about 5% treat it as noise."
        ),
        "",
        (
            "The 'unknown failure' hazard is off in the runs and put back in the two "
            "'with unknown' columns (10% and 50% chance of a fatal surprise by day 60). "
            "Those columns reward faster crossings. Ship traffic (#13) is in runs on code "
            "7856a64 or later; ERA5 understates hurricane winds, so storm losses are "
            "optimistic. Build cost isn't priced until the parts catalogue (#25)."
        ),
        "",
        (
            "| Change | Finished | Within 150 days | Odds (95% range) | Gained | Lost | Chance | "
            "Median days | With unknown 10% | With unknown 50% | Airtime $ | "
            "Lowest charge |"
        ),
        "|---|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for r in t.itertuples():
        same = r.variant == "baseline"
        lines.append(
            f"| {r.label} | {r.arrived}/{r.voyages} | {r.within_150} | {r.odds:.0%} ({r.low95:.0%} to "
            f"{r.high95:.0%}) | {'' if same else r.gained} | {'' if same else r.lost} | "
            f"{'' if same else f'{r.sign_p:.0%}'} | {r.median_days:.0f} | "
            f"{r.odds_unknown_10:.0%} | {r.odds_unknown_50:.0%} | {r.airtime_usd:.0f} | "
            f"{r.min_soc:.0%} |"
        )
    lines += [
        "",
        (
            "Speed, paired: on voyages that finish both ways, days saved against the row it "
            "is paired with (positive = faster)."
        ),
        "",
        "| Change | Paired with | Both finished | Median days saved | Faster | Slower |",
        "|---|---|---|---|---|---|",
    ]
    for r in t.itertuples():
        if r.variant == r.against:
            continue
        lines.append(
            f"| {r.label} | {VARIANTS[r.against].label} | {r.both_finished} | "
            f"{r.median_days_saved:+.1f} | {r.faster} | {r.slower} |"
        )
    lines += ["", "How voyages ended:", "", "| Change | " + " | ".join(_endings(df)) + " |"]
    lines.append("|---" * (1 + len(_endings(df))) + "|")
    for name in t["variant"]:
        counts = df[df["variant"] == name]["ending"].value_counts()
        cells = " | ".join(str(int(counts.get(e, 0))) for e in _endings(df))
        lines.append(f"| {VARIANTS[name].label} | {cells} |")
    return "\n".join(lines) + "\n"


def _endings(df: pd.DataFrame) -> list[str]:
    return list(df["ending"].value_counts().index)


def trace_lines(log, every_hours: float = 12.0) -> list[str]:
    """One voyage as plain text for a job log: its events (not the routine
    messages), then a row every `every_hours` with position, heading, speed
    through the water, the wind it sails in, the current and the distance left
    to the target. For chasing one launch (the trace subcommand)."""
    from boatsim.geo import distance_m
    from boatsim.runner.arrival import DEFAULT_TARGET

    start = log.start
    routine = {"message_sent", "message_received"}
    out = [f"outcome {getattr(log.outcome, 'value', log.outcome)} after {log.days:.1f} days"]
    for e in log.events:
        kind = getattr(e.kind, "value", str(e.kind))
        if kind not in routine:
            out.append(f"  day {(e.t - start).total_seconds() / 86400:6.2f}  {kind}  {e.detail}")
    out.append("   day     lat      lon  hdg   stw  wind_from  m/s   cur_e  cur_n  soc  target_km")
    next_h = 0.0
    for r in log.rows:
        h = (r["t"] - start).total_seconds() / 3600.0
        if h + 1e-6 < next_h:
            continue
        next_h = h + every_hours
        wu, wv = r.get("wind_u") or 0.0, r.get("wind_v") or 0.0
        wind_from = math.degrees(math.atan2(-wu, -wv)) % 360.0
        left = distance_m(r["lat"], r["lon"], *DEFAULT_TARGET) / 1000.0
        out.append(
            f"{h / 24:6.2f} {r['lat']:7.3f} {r['lon']:8.3f} {r['heading']:4.0f} {r['stw']:5.2f}"
            f"  {wind_from:9.0f} {math.hypot(wu, wv):5.1f}  {r.get('current_u') or 0.0:6.2f}"
            f" {r.get('current_v') or 0.0:6.2f} {r.get('soc') or 0.0:4.2f} {left:10.0f}"
        )
    return out


# --- CLI --------------------------------------------------------------------


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.mc.sensitivity")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="run every variant over one year's April to June launches")
    r.add_argument("year", type=int)
    r.add_argument("--variants", nargs="*", default=list(FIRST_BATCH), choices=list(VARIANTS))
    r.add_argument("--every-days", type=int, default=10)
    r.add_argument("--design", default="configs/v4_kayak.yaml")
    r.add_argument("--out", default="runs/sensitivity")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--max-days", type=float, default=MAX_DAYS)
    r.add_argument("--unknown-p", type=float, default=0.0, help="0 = off, swept in the report")
    r.add_argument("--no-currents", action="store_true", help="try-out only: zero current")
    r.add_argument("--constant", action="store_true", help="test only: constant made-up weather")
    t = sub.add_parser("trace", help="one launch, step by step, printed to the log")
    t.add_argument("start", help="launch day, YYYY-MM-DD (noon UTC, as in run)")
    t.add_argument("--variants", nargs="*", default=["baseline"], choices=list(VARIANTS))
    t.add_argument("--every-days", type=int, default=10, help="as in run: sets the seed")
    t.add_argument("--design", default="configs/v4_kayak.yaml")
    t.add_argument("--max-days", type=float, default=MAX_DAYS)
    t.add_argument("--every-hours", type=float, default=12.0)
    t.add_argument("--out", default="runs/sensitivity")
    t.add_argument("--constant", action="store_true", help="test only: constant made-up weather")
    s = sub.add_parser("report", help="combine per-year CSVs into the sensitivity report")
    s.add_argument("csvs", nargs="+")
    s.add_argument("--out", default="runs/sensitivity")
    a = p.parse_args(argv)

    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.cmd == "trace":
        start = datetime.fromisoformat(a.start).replace(hour=12)
        starts = window_launches(start.year, a.every_days)
        if start not in starts:
            raise SystemExit(
                f"{a.start} is not a launch day every {a.every_days} days from 1 April"
            )
        seed = start.year * 1000 + starts.index(start)  # the same seed as run gives it
        if "baseline" not in a.variants:  # as in run: always the baseline to compare with
            a.variants = ["baseline", *a.variants]
        for name in a.variants:
            job = SensitivityVoyage(
                variant=name,
                design_path=a.design,
                weather="constant" if a.constant else "reanalysis",
                max_days=a.max_days,
                unknown_p_by_60_days=0.0,
            )
            print(f"== {name}: {a.design}, launch {start:%Y-%m-%d %H:%M}, seed {seed}")
            print("\n".join(trace_lines(job(start, seed), a.every_hours)), flush=True)
        return
    if a.cmd == "run":
        if "baseline" not in a.variants:
            a.variants = ["baseline", *a.variants]
        df = run_year(
            a.year,
            a.variants,
            a.every_days,
            a.workers,
            design_path=a.design,
            weather="constant" if a.constant else "reanalysis",
            currents=not a.no_currents,
            max_days=a.max_days,
            unknown_p_by_60_days=a.unknown_p,
        )
        df.to_csv(out / f"sensitivity_{a.year}.csv", index=False)
        cols = [
            "variant",
            "start",
            "outcome",
            "days",
            "last_report_day",
            "last_heard_day",
            "ending",
            "end_lat",
            "end_lon",
        ]
        print(df[[c for c in cols if c in df.columns]].to_string())
    else:
        df = pd.concat([pd.read_csv(x, parse_dates=["start"]) for x in a.csvs], ignore_index=True)
        df.to_csv(out / "sensitivity_all.csv", index=False)
        compare(df).to_csv(out / "sensitivity_compare.csv", index=False)
        md = report_markdown(df)
        (out / "sensitivity_report.md").write_text(md)
        print(md)


if __name__ == "__main__":
    main()
