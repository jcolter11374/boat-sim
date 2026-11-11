"""Take the helm: the player steers the kayak on a real 2020 launch, and the
autopilot sails the same launch beside them as a ghost.

What the page's worker calls (Pyodide), one game per worker:

    from boatsim.sandbox.helm import Game
    days = launch_days(env)                           # every day the bundle covers
    g = Game(env, choices=None, day=days[k]["date"])  # or launch_index=0 (1 April 2020)
    g.order("finish", 0.5)                            # heading, power (0-1)
    out = g.run(hours=24)                             # or g.run(soc_below=0.3)
    out["stopped"], out["status"], out["track"]
    g.forecast(hours=120)                             # with the base's forecast error
    g.result()                                        # once out["status"]["over"]
    code = g.save()                                   # share link; Game.load(env, code)

Two modes:

* ``"hands_on"`` (default): orders take effect at once.
* ``"base"`` ("Real base station"): what steering from home is really like.
  One order a day, sent through the Iridium link. It waits in the mailbox
  until the boat's next daily report, so it reaches the boat about a day
  later. Base builds the route from the last report it received, not from
  where the boat is now. Between orders the boat's own safe mode acts
  (`safe` defaults on in this mode).

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
* "Until something happens" always stops within `UNTIL_CAP_H` (3 game days).

Everything returned is plain JSON (strings, numbers, lists, dicts).

Owner: Sam.
"""

from __future__ import annotations

import base64
import json
import math
import zlib
from dataclasses import replace
from datetime import datetime, timedelta

from boatsim.autonomy.helm import HelmAutopilot, OrderMission, sail_orders_for
from boatsim.autonomy.sailing import tactician_for
from boatsim.autonomy.sphere import destination
from boatsim.basestation.base import HoldCoursePolicy
from boatsim.geo import distance_m
from boatsim.runner.simulate import (
    Voyage,
    default_mission,
    mission_size_bytes,
    standard_components,
)
from boatsim.sandbox import catalog
from boatsim.sandbox.endings import ending
from boatsim.sandbox.run import MAX_DAYS, launches
from boatsim.types import EventKind, Message, Outcome, Waypoint

BREAKDOWNS = {EventKind.PART_FAILED, EventKind.CAPSIZE, EventKind.SHIP_STRIKE}
DRAW_DAYS = 1.0  # a margin under this is "a draw, within the weather's luck" (docs/sandbox.md)
LAND_WARN_KM = 50.0
TRACK_STRIDE_H = 6.0
UNTIL_CAP_H = 72.0  # "until something happens" stops by this at the latest (Maya, 11 Nov)
MODES = ("hands_on", "base")
ORDER_EVERY = timedelta(hours=24)  # "Real base station": one order a day
COMPASS_LEG_M = 2_000_000.0  # GUESS: a compass order is a waypoint this far along the bearing
SAVE_VERSION = 1
ESTIMATE_MAX_H = 48.0  # GUESS: base stops extrapolating a silent boat after this
LAUNCH_MONTHS = (4, 5, 6)  # the target window (John, 8 Nov): April to June
LOOKAHEAD_DAYS = 4.0  # base's forecast looks 3 days ahead; keep it inside the bundle
SHARED_LOSS_DAYS = 15.0  # both boats gone this early, the same way: nobody could steer round it
PASS_MARGIN_KM = 1.0  # a lead change counts once the other boat is this far clear (Maya, 11 Nov)
PASS_QUIET_H = 1.0  # no "passed" stops in the first hour after the drop (Maya, 11 Nov)


def day_seed(start: datetime) -> int:
    """The seed for a launch day. The 1st and 15th keep the grid's and the
    replays' seeds (year * 1000 + place among the year's 24 launches), so the
    ghost on those days is exactly the Boatyard's voyage. Every other day gets
    year * 1000 + 100 + day of the year, clear of those."""
    for t, seed in launches(start.year):
        if t == start:
            return seed
    return start.year * 1000 + 100 + start.timetuple().tm_yday


def launch_days(
    env, max_days: float = MAX_DAYS, lookahead_days: float = LOOKAHEAD_DAYS
) -> list[dict]:
    """Every April to June launch day (noon) the weather bundle covers for a
    whole voyage, with its seed. More days than the six odds launches, so one
    unlucky seed can't decide the game (Ravi, 11 Nov: 1 May 2020 loses every
    two-box build on day 3.9). `odds` marks the six that match the Boatyard."""
    year = int(env.meta["year"])
    first = datetime.fromisoformat(env.meta["first"])
    last = datetime.fromisoformat(env.meta["last"]) + timedelta(days=1)
    odds = {t for t, _ in launches(year)}
    out = []
    t = datetime(year, LAUNCH_MONTHS[0], 1, 12)
    while t.month in LAUNCH_MONTHS:
        if t >= first and t + timedelta(days=max_days + lookahead_days) <= last:
            out.append({"date": t.date().isoformat(), "seed": day_seed(t), "odds": t in odds})
        t += timedelta(days=1)
    return out


def challenge_start(env, cid: str) -> tuple[datetime, int]:
    """A weather challenge's drop time and seed (oceandata.challenges), checked
    against the bundle: the page must open that challenge's own bundle."""
    from boatsim.oceandata.challenges import by_id

    try:
        c = by_id(cid)
    except KeyError:
        raise ValueError(f"no challenge called {cid!r}") from None
    start = datetime(c.start.year, c.start.month, c.start.day, 12)
    first = datetime.fromisoformat(env.meta["first"])
    last = datetime.fromisoformat(env.meta["last"]) + timedelta(days=1)
    if not first <= start < last:
        raise ValueError(f"challenge {cid} needs its own weather ({c.bundle})")
    return start, c.seed


class PlayerBase:
    """Base station in "Real base station" mode: it only listens. It keeps the
    last report that reached it, which is all it knows about the boat when the
    player gives an order. It never re-plans by itself."""

    def __init__(self, t0: datetime, lat: float, lon: float):
        self.last = {"t": _iso(t0), "lat": lat, "lon": lon}
        self.reports = [dict(self.last)]  # every report that reached base, the drop first

    def on_report(self, report, forecast):
        self.last = dict(report)
        self.reports.append(dict(report))

    def estimate(self, t: datetime) -> dict:
        """Where base guesses the boat is at `t`: the last report carried on at
        the speed and direction between the last two (dead reckoning), for at
        most ESTIMATE_MAX_H. What the page shows as the faint "estimated" boat."""
        a = self.reports[-1]
        ta = datetime.fromisoformat(a["t"])
        lat, lon = float(a["lat"]), float(a["lon"])
        ahead_s = min(max((t - ta).total_seconds(), 0.0), ESTIMATE_MAX_H * 3600.0)
        if len(self.reports) >= 2 and ahead_s > 0:
            b = self.reports[-2]
            span = (ta - datetime.fromisoformat(b["t"])).total_seconds()
            if span > 0:
                k = ahead_s / span
                lat += (lat - float(b["lat"])) * k
                lon += (lon - float(b["lon"])) * k
        return {
            "lat": lat,
            "lon": lon,
            "from_report": a["t"],
            "age_h": (t - ta).total_seconds() / 3600.0,
        }


def port_start(port_id: str, env=None) -> tuple[float, float]:
    """A port's launch point (oceandata/ports.py): where a support boat drops the
    boat when it sails from that port. Only ports whose voyage crosses the race
    start line, with the launch point and its launch route inside the weather
    actually loaded (a challenge's own bundle included) and clear of its edge."""
    from boatsim.oceandata import ports

    p = ports.load().get(port_id)
    if p is None:
        raise ValueError(f"no port called {port_id!r}")
    if not p["crosses_start"]:
        raise ValueError(
            f"can't sail from {p['name']}: its voyage wouldn't cross the start line here"
        )
    if not p["in_corridor"]:
        raise ValueError(f"can't sail from {p['name']}: the boats would drift out of the weather")
    lat, lon = float(p["launch_lat"]), float(p["launch_lon"])
    w = getattr(env, "weather", None)  # a bundle's weather grid; full data has no edge to check
    if w is not None:
        box = (float(w.lats[0]), float(w.lats[-1]), float(w.lons[0]), float(w.lons[-1]))
        if not ports.route_inside(lat, lon, box=box):  # same margin as the list's flag
            raise ValueError(f"can't sail from {p['name']}: this weather doesn't reach it")
    return lat, lon


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="minutes")


def _no_breakdowns(c):
    c.vessel.hazards = replace(c.vessel.hazards, enabled=False, failures_enabled=False)


class Game:
    def __init__(
        self,
        env,
        choices: dict | None = None,
        launch_index: int | None = None,
        safe: bool | None = None,
        breakdowns: bool = True,
        max_days: float = MAX_DAYS,
        mode: str = "hands_on",
        day: str | None = None,
        challenge: str | None = None,
        start_port: str | None = None,
    ):
        from boatsim.runner.land import default_land

        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if safe is None:
            safe = mode == "base"  # the boat's own safe mode acts between base orders
        self.mode, self.safe, self.max_days = mode, safe, max_days
        if sum(x is not None for x in (day, launch_index, challenge)) > 1:
            raise ValueError("give one of a launch day, a launch index or a challenge")
        self.launch_index, self.day, self.challenge = launch_index, day, challenge
        self.choices = choices
        self.design = catalog.design_for(choices)
        if challenge is not None:
            self.start, self.seed = challenge_start(env, challenge)
        elif day is not None:
            self.start = datetime.fromisoformat(day).replace(hour=12)
            # Any April to June noon inside the bundle; a voyage that later
            # sails past its end stops as "left_data_box", as in run_voyage.
            ok = {d["date"] for d in launch_days(env, 0.0, 0.0)}
            if self.start.date().isoformat() not in ok:
                raise ValueError(f"{day} is not a launch day this weather covers")
            self.seed = day_seed(self.start)
        else:
            self.start, self.seed = launches(env)[launch_index or 0]
        voyage = self.design.voyage
        # Where both boats start: the design's drop, or a port's launch point. The
        # route (and base's "route" orders) start there too; the finish is unchanged.
        self.start_port = start_port
        self.drop = (
            port_start(start_port, env) if start_port else (voyage["drop_lat"], voyage["drop_lon"])
        )
        land = default_land()
        self.breakdowns = breakdowns

        mine = standard_components(self.design, env, env, seed=self.seed, land=land)
        prop = self.design.propulsion
        self.finish = (mine.finish.lat, mine.finish.lon)
        # A boat with a polar (the stock sailboats) also takes sail and engine
        # orders: its own sail plans, and the engine only if it has one.
        self.sail_plans, self.has_engine = sail_orders_for(mine.vessel)
        self.helm = HelmAutopilot(
            finish=self.finish,
            sail_plans=self.sail_plans,
            has_engine=self.has_engine,
            thruster_count=int(prop.get("thruster_count", 2)),
            safe=safe,
            tactician=tactician_for(mine.vessel),  # None unless the boat has a polar
        )
        self.sailboat = bool(self.sail_plans)
        if mode == "base":
            # Until the first order arrives the boat sails the launch route at
            # design cruise power, as it would after the drop.
            self.helm.set_order("route", prop["cruise_drive_w"] / prop["max_drive_w"])
            mine.base = self.base = PlayerBase(self.start, *self.drop)
        else:
            mine.base = self.base = HoldCoursePolicy()  # no route corrections from base
        mine.autopilot = self.helm
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
        # Who is ahead, with hysteresis: None while level (as at the drop), then
        # "me" or "ghost" once that boat is PASS_MARGIN_KM clear. Each change of
        # leader is a pass, including the first one away from the drop.
        self.leader: str | None = None
        self.last_pass: str | None = None
        self._route = default_mission(self.drop).waypoints

    # ---------------------------------------------------------------- orders

    def order(
        self,
        heading: float | str,
        power: float,
        sails: str | None = None,
        engine: bool | None = None,
    ) -> dict:
        """heading: degrees, "finish" or "route"; power: 0 to 1 of full drive power.
        Sailboats only (`sailboat` in the status): sails, one of this boat's own
        sail plans (status "sailing"["plans"]), and engine True/False if it has
        one ("sailing"["has_engine"]); None lets the boat decide.

        Hands on: takes effect now. Real base station: sent now if a day has
        passed since the last order (else refused, "accepted": False), and it
        reaches the boat at the boat's next mailbox check ("arrives")."""
        v = self.mine
        t = v.state.t
        if (sails is not None or engine is not None) and not self.sailboat:
            raise ValueError("this boat has no sails or engine to order")
        check = HelmAutopilot(self.finish, sail_plans=self.sail_plans, has_engine=self.has_engine)
        check.set_order(heading, power, sails, engine)  # same validation in both modes
        heading, power = check.heading, check.power
        o = {
            "t": _iso(t),
            "min": round((t - self.start).total_seconds() / 60),
            "heading": heading,
            "power": power,
        }
        if sails is not None or engine is not None:
            o["sails"], o["engine"] = sails, engine
        if self.mode == "hands_on":
            self.helm.set_order(heading, power, sails, engine)
            o["accepted"] = True
            self.orders.append(o)
            return o
        last = self.orders[-1]["t"] if self.orders else None
        if last is not None and t - datetime.fromisoformat(last) < ORDER_EVERY:
            nxt = datetime.fromisoformat(last) + ORDER_EVERY
            return {**o, "accepted": False, "next_allowed": _iso(nxt)}
        o.update(self._send(heading, power, sails, engine))
        self.orders.append(o)
        return o

    def _send(
        self, heading: float | str, power: float, sails: str | None, engine: bool | None
    ) -> dict:
        """Uplink the order as a route from base (built from the last report
        base received) through the boat's own Iridium link."""
        v = self.mine
        known = self.base.last
        lat, lon = float(known["lat"]), float(known["lon"])
        if heading == "route":
            from boatsim.comms.feed import ahead_of

            wps = list(ahead_of(self._route, lon))
        elif heading == "finish":
            wps = [Waypoint(*self.finish)]
        else:
            wps = [Waypoint(*destination(lat, lon, heading, COMPASS_LEG_M))]
        m = OrderMission(wps, power=power, sails=sails, engine=engine)
        env = v.env if v.env is not None else v.c.env.sample(v.state.t, v.state.lat, v.state.lon)
        down = Message(v.state.t, "down", {"waypoints": len(wps)}, size_bytes=mission_size_bytes(m))
        t_down = v.c.link.send(down, env, v.link_rng)
        if t_down is None:
            return {"accepted": True, "arrives": None, "from_report": known["t"]}
        if t_down < v.next_report:
            # Before the boat's first report its mailbox hasn't been opened yet
            # (the link only knows the report times it has seen), so the order
            # goes with that first report.
            t_down = v.next_report + timedelta(seconds=getattr(v.c.link, "session_s", 0.0))
        v.pending_down.append((t_down, m))
        return {"accepted": True, "arrives": _iso(t_down), "from_report": known["t"]}

    def waiting(self) -> list[dict]:
        """Orders sent from base that haven't reached the boat yet."""
        return [
            {"due": _iso(t), "power": m.power}
            for t, m in self.mine.pending_down
            if isinstance(m, OrderMission)
        ]

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
        self.last_pass = self._update_leader()

    def _update_leader(self) -> str | None:
        """'ghost_passed' or 'passed_ghost' on the step the leader changes, else
        None. A lead of a few metres flips back and forth with every wave, so a
        pass needs the other boat PASS_MARGIN_KM clear, and none counts in the
        first PASS_QUIET_H after the drop (1 May 2020: a 2 m swing 20 minutes in)."""
        if self.mine.state.t < self.start + timedelta(hours=PASS_QUIET_H):
            return None
        lead = self.lead_km()
        now = "me" if lead > PASS_MARGIN_KM else "ghost" if lead < -PASS_MARGIN_KM else None
        if now is None or now == self.leader:
            return None
        self.leader = now
        return "ghost_passed" if now == "ghost" else "passed_ghost"

    def run(
        self,
        hours: float | None = None,
        soc_below: float | None = None,
        wind_above: float | None = None,
        land_within_km: float | None = LAND_WARN_KM,
        breakdown: bool = True,
        ghost_passes: bool = True,
        order_arrives: bool = True,
        max_hours: float = UNTIL_CAP_H,
    ) -> dict:
        """Let time run until `hours` pass or a stop condition fires. With
        hours=None ("until something happens") it also stops after `max_hours`
        ("time"), so a quiet ocean never swallows weeks of the voyage at once.
        Returns why it stopped, the status, and both boats' new 6-hourly rows.

        Stop reasons: time, battery, wind, land, breakdown, ghost_passed,
        passed_ghost, order_arrived (Real base station mode), over. A pass
        means the lead changed hands by more than PASS_MARGIN_KM, after the
        first PASS_QUIET_H (see _update_leader)."""
        from boatsim.vessel.coast import distance_to_land_km

        v = self.mine
        t0 = v.state.t
        until = t0 + timedelta(hours=hours if hours is not None else max_hours)
        n_events = len(v.log.events)
        near = (
            land_within_km is not None
            and distance_to_land_km(v.state.lat, v.state.lon) <= land_within_km
        )
        stopped = None
        while stopped is None:
            if v.done:
                stopped = "over"
                break
            if v.state.t >= until:
                stopped = "time"
                break
            self._step()
            new = v.log.events[n_events:]
            n_events = len(v.log.events)
            if v.done:
                stopped = "over"
            elif breakdown and any(e.kind in BREAKDOWNS for e in new):
                stopped = "breakdown"
            elif (
                order_arrives
                and self.mode == "base"
                and any(e.kind == EventKind.MISSION_UPDATED for e in new)
            ):
                stopped = "order_arrived"
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
            if stopped is None and ghost_passes and self.last_pass:
                stopped = self.last_pass
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
            "mode": self.mode,
            "show_true_position": True,
            "order": {"heading": self.helm.heading, "power": self.helm.power},
            "power_w": self.helm.power * self.max_drive_w,
            "sailboat": self.sailboat,
        }
        if self.sailboat:
            st, tac = v.state, self.helm.tactician
            out["order"].update(sails=self.helm.sails, engine=self.helm.engine)
            out["sailing"] = {
                "plans": list(self.sail_plans),  # what may be ordered, biggest sails first
                "has_engine": self.has_engine,
                "plan": getattr(st, "sail_plan", None),  # what is set now (auto or ordered)
                "heel_deg": getattr(st, "heel_deg", None),
                "engine_on": getattr(st, "engine_on", None),
                "fuel_l": getattr(st, "fuel_l", None),
                # "beat" (tacking upwind), "run" (gybing downwind) or "reach"
                "tactic": tac.mode if tac is not None else None,
                "tacks": tac.switches if tac is not None else 0,
            }
        if self.mode == "base":
            # What steering from home looks like (Maya, 11 Nov): the page shows
            # the last report and a faint estimate, not the true boat; the true
            # track goes on the results card.
            out["base"] = {
                "last_report": dict(self.base.last),
                "estimate": self.base.estimate(self.mine.state.t),
                "reports": [dict(r) for r in self.base.reports],
                "waiting": self.waiting(),
            }
            out["show_true_position"] = False
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
        realistic error as the base station's (ErrorForecast), not the truth.
        Cut short at the end of the weather bundle."""
        from boatsim.oceandata.grid import OutsideCoverage

        v = self.mine
        issued = v.c.forecast.issue(v.state.t)
        out = []
        for k in range(int(hours // every_h) + 1):
            t = v.state.t + timedelta(hours=k * every_h)
            try:
                e = issued.sample(t, v.state.lat, v.state.lon)
            except OutsideCoverage:
                break  # past the end of the weather bundle: a shorter forecast
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
            outcome = self._outcome(v)
            return {
                "outcome": outcome,
                "days": days,
                "battery_low": min(socs),
                "breakdowns": broke,
                # How it ends, in the boat's own words (sandbox/endings.py).
                "ending": ending(outcome, v.log.events, self.start, label),
            }

        design = getattr(self, "design", None)  # QA's stand-in games have none
        label = design.stock.get("label") if design is not None else None

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
        shared = (
            verdict == "neither_finished"
            and me["outcome"] == gh["outcome"]
            and me["outcome"] not in ("at_sea", "left_data_box")
            and me["breakdowns"] == gh["breakdowns"]
            and abs(me["days"] - gh["days"]) < DRAW_DAYS
            and me["days"] < SHARED_LOSS_DAYS
        )
        note = None
        if shared:
            what = "An electronics failure" if "part_failed" in me["breakdowns"] else "Bad luck"
            note = f"{what} no one could steer around: both boats lost. Try another day."
        return {
            "build": catalog.grid_id(self.choices),
            "launch": _iso(self.start),
            "challenge": self.challenge,
            "start_port": self.start_port,
            "seed": self.seed,
            "breakdowns_on": self.breakdowns,
            "mode": self.mode,
            "boat": me,
            "ghost": gh,
            "margin_days": margin,  # positive: the player finished first
            "verdict": verdict,
            "breakdowns_differ": me["breakdowns"] != gh["breakdowns"],
            "shared_loss": shared,  # both lost early to the same thing: not the player's doing
            "note": note,
            "orders": self.orders,
        }

    # ------------------------------------------------------- save and resume

    def save(self) -> str:
        """A short code for a share link (URL-safe). Game.load(env, code) sails
        the same game back to this moment: same launch, build and orders, and
        the same seeds, so the same weather and luck."""
        payload = {
            "v": SAVE_VERSION,
            "c": self.choices,
            "l": self.launch_index,
            "day": self.day,
            "ch": self.challenge,
            "m": self.mode,
            "s": self.safe,
            "b": self.breakdowns,
            "d": self.max_days,
            "o": [
                [o["min"], o["heading"], o["power"]]
                + ([o["sails"], o["engine"]] if "sails" in o else [])
                for o in self.orders
            ],
            "at": round((self.mine.state.t - self.start).total_seconds() / 60),
            "p": [round(self.mine.state.lat, 4), round(self.mine.state.lon, 4)],
        }
        if self.start_port:
            payload["sp"] = self.start_port  # only when set, so other codes stay as they were
        raw = zlib.compress(json.dumps(payload, separators=(",", ":")).encode(), 9)
        return base64.urlsafe_b64encode(raw).decode().rstrip("=")

    @classmethod
    def load(cls, env, code: str) -> Game:
        """Rebuild a saved game. Raises ValueError if the code is damaged or was
        saved by a simulator that sails the voyage differently."""
        try:
            raw = base64.urlsafe_b64decode(code + "=" * (-len(code) % 4))
            p = json.loads(zlib.decompress(raw))
        except (ValueError, zlib.error) as err:
            raise ValueError("not a saved game") from err
        if not isinstance(p, dict):
            raise ValueError("not a saved game")  # noqa: TRY004 - one error type for the page
        if p.get("v") != SAVE_VERSION:
            raise ValueError(f"saved game format {p.get('v')}, this page reads {SAVE_VERSION}")
        try:
            g = cls(
                env,
                choices=p["c"],
                launch_index=p["l"],
                day=p.get("day"),
                challenge=p.get("ch"),
                start_port=p.get("sp"),  # older links: the usual drop
                safe=p["s"],
                breakdowns=p["b"],
                max_days=p["d"],
                mode=p["m"],
            )
            for minute, heading, power, *sail_orders in p["o"]:
                g._advance_to(g.start + timedelta(minutes=minute))
                g.order(heading, power, *sail_orders[:2])
            g._advance_to(g.start + timedelta(minutes=p["at"]))
        except (KeyError, TypeError, IndexError, AttributeError) as err:
            # Valid JSON, but not a game this page can rebuild (a mangled link).
            raise ValueError("not a saved game") from err
        here = [round(g.mine.state.lat, 4), round(g.mine.state.lon, 4)]
        if here != p["p"]:
            raise ValueError("this saved game was sailed by a different simulator version")
        return g

    def _advance_to(self, t: datetime) -> None:
        while not self.mine.done and self.mine.state.t < t:
            self._step()
