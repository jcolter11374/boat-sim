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

from boatsim.autonomy.helm import HelmAutopilot, OrderMission
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


class PlayerBase:
    """Base station in "Real base station" mode: it only listens. It keeps the
    last report that reached it, which is all it knows about the boat when the
    player gives an order. It never re-plans by itself."""

    def __init__(self, t0: datetime, lat: float, lon: float):
        self.last = {"t": _iso(t0), "lat": lat, "lon": lon}

    def on_report(self, report, forecast):
        self.last = dict(report)


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
        safe: bool | None = None,
        breakdowns: bool = True,
        max_days: float = MAX_DAYS,
        mode: str = "hands_on",
    ):
        from boatsim.runner.land import default_land

        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if safe is None:
            safe = mode == "base"  # the boat's own safe mode acts between base orders
        self.mode, self.safe, self.max_days = mode, safe, max_days
        self.launch_index = launch_index
        self.choices = choices
        self.design = catalog.design_for(choices)
        self.start, self.seed = launches(env)[launch_index]
        voyage = self.design.voyage
        self.drop = (voyage["drop_lat"], voyage["drop_lon"])
        land = default_land()
        self.breakdowns = breakdowns

        mine = standard_components(self.design, env, env, seed=self.seed, land=land)
        prop = self.design.propulsion
        self.finish = (mine.finish.lat, mine.finish.lon)
        self.helm = HelmAutopilot(
            finish=self.finish,
            thruster_count=int(prop.get("thruster_count", 2)),
            safe=safe,
        )
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
        self._route = default_mission(self.drop).waypoints

    # ---------------------------------------------------------------- orders

    def order(self, heading: float | str, power: float) -> dict:
        """heading: degrees, "finish" or "route"; power: 0 to 1 of full drive power.

        Hands on: takes effect now. Real base station: sent now if a day has
        passed since the last order (else refused, "accepted": False), and it
        reaches the boat at the boat's next mailbox check ("arrives")."""
        v = self.mine
        t = v.state.t
        check = HelmAutopilot(self.finish)
        check.set_order(heading, power)  # same validation in both modes
        heading, power = check.heading, check.power
        o = {
            "t": _iso(t),
            "min": round((t - self.start).total_seconds() / 60),
            "heading": heading,
            "power": power,
        }
        if self.mode == "hands_on":
            self.helm.set_order(heading, power)
            o["accepted"] = True
            self.orders.append(o)
            return o
        last = self.orders[-1]["t"] if self.orders else None
        if last is not None and t - datetime.fromisoformat(last) < ORDER_EVERY:
            nxt = datetime.fromisoformat(last) + ORDER_EVERY
            return {**o, "accepted": False, "next_allowed": _iso(nxt)}
        o.update(self._send(heading, power))
        self.orders.append(o)
        return o

    def _send(self, heading: float | str, power: float) -> dict:
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
        m = OrderMission(wps, power=power)
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
        order_arrived (Real base station mode), over."""
        from boatsim.vessel.coast import distance_to_land_km

        v = self.mine
        t0 = v.state.t
        until = t0 + timedelta(hours=hours if hours is not None else max_hours)
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
            "mode": self.mode,
            "order": {"heading": self.helm.heading, "power": self.helm.power},
            "power_w": self.helm.power * self.max_drive_w,
        }
        if self.mode == "base":
            out["base"] = {"last_report": dict(self.base.last), "waiting": self.waiting()}
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
            "mode": self.mode,
            "boat": me,
            "ghost": gh,
            "margin_days": margin,  # positive: the player finished first
            "verdict": verdict,
            "breakdowns_differ": me["breakdowns"] != gh["breakdowns"],
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
            "m": self.mode,
            "s": self.safe,
            "b": self.breakdowns,
            "d": self.max_days,
            "o": [[o["min"], o["heading"], o["power"]] for o in self.orders],
            "at": round((self.mine.state.t - self.start).total_seconds() / 60),
            "p": [round(self.mine.state.lat, 4), round(self.mine.state.lon, 4)],
        }
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
        if p.get("v") != SAVE_VERSION:
            raise ValueError(f"saved game format {p.get('v')}, this page reads {SAVE_VERSION}")
        g = cls(
            env,
            choices=p["c"],
            launch_index=p["l"],
            safe=p["s"],
            breakdowns=p["b"],
            max_days=p["d"],
            mode=p["m"],
        )
        for minute, heading, power in p["o"]:
            g._advance_to(g.start + timedelta(minutes=minute))
            g.order(heading, power)
        g._advance_to(g.start + timedelta(minutes=p["at"]))
        here = [round(g.mine.state.lat, 4), round(g.mine.state.lon, 4)]
        if here != p["p"]:
            raise ValueError("this saved game was sailed by a different simulator version")
        return g

    def _advance_to(self, t: datetime) -> None:
        while not self.mine.done and self.mine.state.t < t:
            self._step()
