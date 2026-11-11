"""Take the helm: the player steers the kayak on a real 2020 launch, and the
autopilot sails the same launch beside them as a ghost.

What the page's worker calls (Pyodide), one game per worker:

    from boatsim.sandbox.helm import Game
    g = Game(env, choices=None, launch_index=0)       # 1 April 2020
    g.order("finish", 0.5)                            # heading, power (0-1)
    out = g.run(hours=24)                             # or g.run(soc_below=0.3)
    out["stopped"], out["status"], out["track"]
    g.forecast(hours=120)                             # with the base's forecast error
    g.result()                                        # once out["status"]["over"]

Fairness (design note, Maya's calls of 11 Nov 2026):

* Same build, launch, weather and seed for both boats, so each step's
  breakdown dice are the same whatever either boat does (#110, #112).
  Breakdowns are on by default; `breakdowns=False` turns them off for both.
* The ghost is the full autopilot with safe mode and the base station's
  route corrections, exactly as in the odds runs: `run_voyage` gives the
  same voyage for the same launch.
* The ghost moves in step with the player's clock, so nothing it does is
  visible before the player gets there.
* "Hands on" has no safe mode by default (`safe=True` turns it on). The
  hardware still cuts out at empty, as the vessel model does.

Everything returned is plain JSON (strings, numbers, lists, dicts).

Owner: Sam.
"""

from __future__ import annotations

import math
from dataclasses import replace
from datetime import datetime, timedelta

from boatsim.autonomy.helm import HelmAutopilot
from boatsim.basestation.base import HoldCoursePolicy
from boatsim.geo import distance_m
from boatsim.runner.simulate import Voyage, default_mission, standard_components
from boatsim.sandbox import catalog
from boatsim.sandbox.run import MAX_DAYS, launches
from boatsim.types import EventKind, Outcome

BREAKDOWNS = {EventKind.PART_FAILED, EventKind.CAPSIZE, EventKind.SHIP_STRIKE}
DRAW_DAYS = 1.0  # a margin under this is "a draw, within the weather's luck" (docs/sandbox.md)
LAND_WARN_KM = 50.0
TRACK_STRIDE_H = 6.0


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="minutes")


def _no_breakdowns(c):
    c.vessel.hazards = replace(c.vessel.hazards, enabled=False, failures_enabled=False)


class Game:
    def __init__(
        self,
        env,
        choices: dict | None = None,
        launch_index: int = 0,
        safe: bool = False,
        breakdowns: bool = True,
        max_days: float = MAX_DAYS,
    ):
        from boatsim.runner.land import default_land

        self.choices = choices
        self.design = catalog.design_for(choices)
        self.start, self.seed = launches(env)[launch_index]
        voyage = self.design.voyage
        self.drop = (voyage["drop_lat"], voyage["drop_lon"])
        land = default_land()
        self.breakdowns = breakdowns

        mine = standard_components(self.design, env, env, seed=self.seed, land=land)
        prop = self.design.propulsion
        self.helm = HelmAutopilot(
            finish=(mine.finish.lat, mine.finish.lon),
            thruster_count=int(prop.get("thruster_count", 2)),
            safe=safe,
        )
        mine.autopilot = self.helm
        mine.base = HoldCoursePolicy()  # hands on: no route corrections from base
        ghost = standard_components(self.design, env, env, seed=self.seed, land=land)
        if not breakdowns:
            _no_breakdowns(mine)
            _no_breakdowns(ghost)
        self.max_drive_w = float(prop["max_drive_w"])
        self.mine = Voyage(
            mine,
            self.start,
            *self.drop,
            default_mission(self.drop),
            seed=self.seed,
            max_days=max_days,
        )
        self.ghost = Voyage(
            ghost,
            self.start,
            *self.drop,
            default_mission(self.drop),
            seed=self.seed,
            max_days=max_days,
        )
        self.orders: list[dict] = []
        self.left_data: set[int] = set()

    # ---------------------------------------------------------------- orders

    def order(self, heading: float | str, power: float) -> dict:
        """heading: degrees, "finish" or "route"; power: 0 to 1 of full drive power."""
        self.helm.set_order(heading, power)
        o = {"t": _iso(self.mine.state.t), "heading": self.helm.heading, "power": self.helm.power}
        self.orders.append(o)
        return o

    # -------------------------------------------------------------- running

    def _km_to_finish(self, v: Voyage) -> float:
        if v.log.outcome == Outcome.ARRIVED:
            return 0.0
        f = v.c.finish
        return max(distance_m(v.state.lat, v.state.lon, f.lat, f.lon) - f.radius_m, 0.0) / 1000.0

    def lead_km(self) -> float:
        """How far ahead of the ghost the player is, km closer to the finish (negative: behind)."""
        return self._km_to_finish(self.ghost) - self._km_to_finish(self.mine)

    def _advance(self, v: Voyage, until: datetime | None = None) -> None:
        """Step `v` (once, or up to `until`). Sailing off the edge of the weather
        bundle ends that voyage, as in run_voyage ("left_data_box")."""
        from boatsim.oceandata.grid import OutsideCoverage

        try:
            v.step() if until is None else v.run_until(until)
        except OutsideCoverage:
            v.done = True
            v.log.end = v.state.t
            self.left_data.add(id(v))

    def _outcome(self, v: Voyage) -> str:
        if id(v) in self.left_data:
            return "left_data_box"
        return v.log.outcome.value if v.done else "at_sea"

    def _step(self) -> None:
        self._advance(self.mine)
        self._advance(self.ghost, self.mine.state.t)

    def run(
        self,
        hours: float | None = None,
        soc_below: float | None = None,
        wind_above: float | None = None,
        land_within_km: float | None = LAND_WARN_KM,
        breakdown: bool = True,
        ghost_passes: bool = True,
    ) -> dict:
        """Let time run until `hours` pass (None: until something happens) or a
        stop condition fires. Returns why it stopped, the status, and the new
        6-hourly track rows of both boats."""
        from boatsim.vessel.coast import distance_to_land_km

        v = self.mine
        t0 = v.state.t
        until = t0 + timedelta(hours=hours) if hours is not None else None
        n_events = len(v.log.events)
        near = (
            land_within_km is not None
            and distance_to_land_km(v.state.lat, v.state.lon) <= land_within_km
        )
        ahead = self.lead_km() >= 0.0
        stopped = None
        while stopped is None:
            if v.done:
                stopped = "over"
                break
            if until is not None and v.state.t >= until:
                stopped = "time"
                break
            self._step()
            new = v.log.events[n_events:]
            n_events = len(v.log.events)
            if v.done:
                stopped = "over"
            elif breakdown and any(e.kind in BREAKDOWNS for e in new):
                stopped = "breakdown"
            elif soc_below is not None and v.state.soc < soc_below:
                stopped = "battery"
            elif (
                wind_above is not None
                and v.env is not None
                and math.hypot(v.env.wind_u, v.env.wind_v) > wind_above
            ):
                stopped = "wind"
            elif land_within_km is not None:
                now_near = distance_to_land_km(v.state.lat, v.state.lon) <= land_within_km
                if now_near and not near:
                    stopped = "land"
                near = now_near
            if stopped is None and ghost_passes:
                now_ahead = self.lead_km() >= 0.0
                if ahead and not now_ahead:
                    stopped = "ghost_passed"
                ahead = now_ahead
        return {"stopped": stopped, "status": self.status(), "track": self.track(since=t0)}

    # -------------------------------------------------------------- reading

    def _boat(self, v: Voyage) -> dict:
        s = v.state
        return {
            "t": _iso(s.t),
            "lat": s.lat,
            "lon": s.lon,
            "heading": s.heading,
            "stw": s.speed_through_water,
            "soc": s.soc,
            "km_to_finish": self._km_to_finish(v),
            "outcome": self._outcome(v),
        }

    def status(self) -> dict:
        v, e = self.mine, self.mine.env
        out = {
            "day": (v.state.t - self.start).total_seconds() / 86400.0,
            "over": v.done,
            "boat": self._boat(v),
            "ghost": self._boat(self.ghost),
            "lead_km": self.lead_km(),
            "order": {"heading": self.helm.heading, "power": self.helm.power},
            "power_w": self.helm.power * self.max_drive_w,
        }
        if e is not None:
            out["weather"] = {
                "wind_u": e.wind_u,
                "wind_v": e.wind_v,
                "hs": e.hs,
                "tp": e.tp,
                "wave_dir": e.wave_dir,
                "current_u": e.current_u,
                "current_v": e.current_v,
                "ghi": e.ghi,
                "rain": getattr(e, "rain", 0.0),
            }
        return out

    def track(self, since: datetime | None = None, stride_h: float = TRACK_STRIDE_H) -> dict:
        """Both boats' logged rows after `since`, one every `stride_h` hours of voyage time."""

        def rows(v: Voyage) -> list[dict]:
            every = max(round(stride_h * 3600 / (v.dt.total_seconds() * v.log_every)), 1)
            out = []
            for r in v.log.rows[::every]:
                if since is not None and r["t"] <= since:
                    continue
                out.append({k: (_iso(x) if isinstance(x, datetime) else x) for k, x in r.items()})
            return out

        return {"boat": rows(self.mine), "ghost": rows(self.ghost)}

    def forecast(self, hours: float = 120.0, every_h: float = 6.0) -> list[dict]:
        """The forecast the base would get now, at the boat's position: same
        realistic error as the base station's (ErrorForecast), not the truth."""
        v = self.mine
        issued = v.c.forecast.issue(v.state.t)
        out = []
        for k in range(int(hours // every_h) + 1):
            t = v.state.t + timedelta(hours=k * every_h)
            e = issued.sample(t, v.state.lat, v.state.lon)
            out.append(
                {
                    "t": _iso(t),
                    "wind_u": e.wind_u,
                    "wind_v": e.wind_v,
                    "hs": e.hs,
                    "current_u": e.current_u,
                    "current_v": e.current_v,
                    "ghi": e.ghi,
                }
            )
        return out

    def result(self) -> dict:
        """The results card. Call when status()["over"] (it also works mid-game)."""

        def card(v: Voyage) -> dict:
            days = (v.state.t - self.start).total_seconds() / 86400.0
            socs = [r["soc"] for r in v.log.rows] or [v.state.soc]
            broke = sorted({e.kind.value for e in v.log.events if e.kind in BREAKDOWNS})
            return {
                "outcome": self._outcome(v),
                "days": days,
                "battery_low": min(socs),
                "breakdowns": broke,
            }

        if self.mine.done:
            self._advance(
                self.ghost, self.start + timedelta(days=10_000)
            )  # the game is over: the rest of the ghost's voyage can be shown
        me, gh = card(self.mine), card(self.ghost)
        both = me["outcome"] == gh["outcome"] == Outcome.ARRIVED.value
        margin = gh["days"] - me["days"] if both else None
        if both:
            verdict = "draw" if abs(margin) < DRAW_DAYS else ("won" if margin > 0 else "lost")
        elif me["outcome"] == Outcome.ARRIVED.value:
            verdict = "won"
        elif gh["outcome"] == Outcome.ARRIVED.value:
            verdict = "lost"
        else:
            verdict = "neither_finished"
        return {
            "build": catalog.grid_id(self.choices),
            "launch": _iso(self.start),
            "seed": self.seed,
            "breakdowns_on": self.breakdowns,
            "boat": me,
            "ghost": gh,
            "margin_days": margin,  # positive: the player finished first
            "verdict": verdict,
            "breakdowns_differ": me["breakdowns"] != gh["breakdowns"],
            "orders": self.orders,
        }
