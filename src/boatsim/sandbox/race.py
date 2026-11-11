"""Race view: two builds, any bases, sail the same launch side by side.

What the page's worker calls (Pyodide), like the helm game:

    from boatsim.sandbox.race import Race, season
    r = Race(env, {"thr": "one-t200"}, {"base": "revc"}, launch_index=0)
    out = r.run(hours=24)            # or r.run() = until something happens
    out["stopped"], out["status"], out["track"]
    r.result()                       # once out["status"]["over"]
    s = season(env, a, b)            # every launch of the season, paired verdict

Fairness, the same rules as the helm game and the leaderboard (#197, #200):

* Same launch: same time, same drop point (boat A's, unless `drop="own"`:
  each boat from its own design's drop, as in its Boatyard odds; Randolph's
  boats drop off New Jersey, ours off the Bay mouth), same weather, same seed. Each step draws a fixed block of
  breakdown dice whatever the boat does (common random numbers, #110), so
  both boats get the same luck on the same step. One build can still break
  where the other doesn't: a weaker part fails on a roll the stronger survives.
* Each boat is the full autopilot with safe mode and the base station's route
  corrections, exactly as in the odds runs: a boat's voyage here is the one
  `run_voyage` gives for the same launch.
* The two boats move in lockstep, so neither's future shows early.
* One race is one roll of the weather's dice. `season()` sails every launch
  and ranks the pair with Ravi's paired test (mc/leaderboard.paired): "too
  close to call" unless the launches one boat finished and the other didn't
  are lopsided enough not to be luck.

Everything returned is plain JSON. Imports nothing beyond numpy and pyyaml
(the same as run.py), so it runs in the browser.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from boatsim.geo import distance_m
from boatsim.mc.leaderboard import MIN_LAUNCHES, paired
from boatsim.runner.simulate import Voyage, default_mission, standard_components
from boatsim.sandbox import catalog
from boatsim.sandbox.helm import BREAKDOWNS, DRAW_DAYS, TRACK_STRIDE_H, UNTIL_CAP_H
from boatsim.sandbox.run import MAX_DAYS, launches, run_voyage
from boatsim.types import Outcome

LEAD_HYST_KM = 2.0  # the lead must swing past this the other way to count as a change

BASE_NAMES = {
    "kayak": "Our kayak",
    "revc": "Randolph Rev C (our model)",
    "revb": "Randolph Rev B (our model)",
}


def _iso(t: datetime) -> str:
    return t.isoformat(timespec="minutes")


def label(choices: dict | None) -> str:
    """A name for the page: the base's name, plus "custom" if any part differs
    from that base's defaults."""
    base = catalog.base_of(choices)
    name = BASE_NAMES.get(base, base)
    stock = catalog.grid_id(choices) == catalog.grid_id({"base": base})
    return name if stock else f"{name}, custom"


def _names(a: dict | None, b: dict | None) -> tuple[str, str]:
    na, nb = label(a), label(b)
    if na == nb:
        na, nb = f"{na} (A)", f"{nb} (B)"
    return na, nb


def drops(a: dict | None, b: dict | None, drop="same") -> list[tuple[float, float]]:
    """Where each boat is let go: "same" (boat A's drop for both), "own" (each
    design's own drop), or one (lat, lon) for both."""

    def own(ch):
        v = catalog.design_for(ch).voyage
        return (float(v["drop_lat"]), float(v["drop_lon"]))

    if drop == "own":
        return [own(a), own(b)]
    if drop == "same":
        return [own(a)] * 2
    lat, lon = drop
    return [(float(lat), float(lon))] * 2


class Race:
    def __init__(
        self,
        env,
        a: dict | None = None,
        b: dict | None = None,
        launch_index: int = 0,
        breakdowns: bool = True,
        max_days: float = MAX_DAYS,
        drop: str | tuple[float, float] = "same",
    ):
        from boatsim.runner.land import default_land

        self.choices = (a, b)
        self.names = _names(a, b)
        self.builds = (catalog.grid_id(a), catalog.grid_id(b))
        self.launch_index = launch_index
        self.start, self.seed = launches(env)[launch_index]
        self.breakdowns = breakdowns
        land = default_land()
        self.drops = drops(a, b, drop)
        self.boats: list[Voyage] = []
        for ch, here in zip((a, b), self.drops, strict=True):
            design = catalog.design_for(ch)
            c = standard_components(design, env, env, seed=self.seed, land=land)
            if not breakdowns:
                from boatsim.sandbox.helm import _no_breakdowns

                _no_breakdowns(c)
            self.boats.append(
                Voyage(
                    c, self.start, *here, default_mission(here), seed=self.seed, max_days=max_days
                )
            )
        self.left_data: set[int] = set()

    # -------------------------------------------------------------- running

    def _advance(self, v: Voyage, until: datetime | None = None) -> None:
        from boatsim.oceandata.grid import OutsideCoverage

        try:
            v.step() if until is None else v.run_until(until)
        except OutsideCoverage:  # sailed off the weather bundle, as in run_voyage
            v.done = True
            v.log.end = v.state.t
            self.left_data.add(id(v))

    def _step(self) -> None:
        """One step of whichever boat is behind in time (or still sailing), then
        the other up to it."""
        a, b = self.boats
        lead, other = (a, b) if (not a.done and (b.done or a.state.t <= b.state.t)) else (b, a)
        if lead.done:
            return
        self._advance(lead)
        if not other.done and other.state.t < lead.state.t:
            self._advance(other, lead.state.t)

    @property
    def over(self) -> bool:
        return all(v.done for v in self.boats)

    def _outcome(self, v: Voyage) -> str:
        if id(v) in self.left_data:
            return "left_data_box"
        return v.log.outcome.value if v.done else "at_sea"

    def _km_to_finish(self, v: Voyage) -> float:
        if v.log.outcome == Outcome.ARRIVED:
            return 0.0
        f = v.c.finish
        return max(distance_m(v.state.lat, v.state.lon, f.lat, f.lon) - f.radius_m, 0.0) / 1000.0

    def lead_km(self) -> float:
        """How far A is ahead of B: km closer to the finish (negative: B leads)."""
        a, b = self.boats
        return self._km_to_finish(b) - self._km_to_finish(a)

    def now(self) -> datetime:
        return max(v.state.t for v in self.boats)

    def run(
        self,
        hours: float | None = None,
        lead_change: bool = True,
        breakdown: bool = True,
        finish: bool = True,
        max_hours: float = UNTIL_CAP_H,
    ) -> dict:
        """Let the race run until `hours` pass or something happens. With
        hours=None it also stops after `max_hours`, so a quiet ocean never
        swallows weeks at once.

        Stop reasons: time, lead_change, breakdown (either boat), finished
        (either boat's voyage ended: arrived, lost, aground...), over (both ended)."""
        t0 = self.now()
        until = t0 + timedelta(hours=hours if hours is not None else max_hours)
        seen = [len(v.log.events) for v in self.boats]
        done = [v.done for v in self.boats]
        lead0 = self.lead_km()
        ahead = None if abs(lead0) < LEAD_HYST_KM else lead0 > 0
        stopped = None
        while stopped is None:
            if self.over:
                stopped = "over"
                break
            if all(v.done or v.state.t >= until for v in self.boats):
                stopped = "time"
                break
            self._step()
            new = []
            for i, v in enumerate(self.boats):
                new += v.log.events[seen[i] :]
                seen[i] = len(v.log.events)
            if self.over:
                stopped = "over"
            elif finish and any(v.done and not d for v, d in zip(self.boats, done, strict=True)):
                stopped = "finished"
            elif breakdown and any(e.kind in BREAKDOWNS for e in new):
                stopped = "breakdown"
            elif lead_change:
                lead = self.lead_km()
                if abs(lead) >= LEAD_HYST_KM:
                    now_ahead = lead > 0
                    if ahead is not None and now_ahead != ahead:
                        stopped = "lead_change"
                    ahead = now_ahead
            done = [v.done for v in self.boats]
        return {"stopped": stopped, "status": self.status(), "track": self.track(since=t0)}

    # -------------------------------------------------------------- reading

    def _boat(self, i: int) -> dict:
        v = self.boats[i]
        s, e = v.state, v.env
        out = {
            "name": self.names[i],
            "build": self.builds[i],
            "t": _iso(s.t),
            "lat": s.lat,
            "lon": s.lon,
            "heading": s.heading,
            "stw": s.speed_through_water,
            "soc": s.soc,
            "km_to_finish": self._km_to_finish(v),
            "outcome": self._outcome(v),
            "breakdowns": sorted({x.kind.value for x in v.log.events if x.kind in BREAKDOWNS}),
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

    def status(self) -> dict:
        lead = self.lead_km()
        return {
            "launch": _iso(self.start),
            "seed": self.seed,
            "drops": [list(d) for d in self.drops],
            "day": (self.now() - self.start).total_seconds() / 86400.0,
            "over": self.over,
            "boats": [self._boat(0), self._boat(1)],
            "lead_km": lead,  # positive: A ahead
            "leader": None if abs(lead) < 0.5 else (0 if lead > 0 else 1),
        }

    def track(self, since: datetime | None = None, stride_h: float = TRACK_STRIDE_H) -> list[list]:
        """Both boats' logged rows after `since`, one every `stride_h` hours."""

        def rows(v: Voyage) -> list[dict]:
            every = max(round(stride_h * 3600 / (v.dt.total_seconds() * v.log_every)), 1)
            out = []
            for r in v.log.rows[::every]:
                if since is not None and r["t"] <= since:
                    continue
                out.append({k: (_iso(x) if isinstance(x, datetime) else x) for k, x in r.items()})
            return out

        return [rows(v) for v in self.boats]

    def result(self) -> dict:
        """The results card. Sails both boats to the end first (it can be called
        mid-race: "skip to the end")."""
        while not self.over:
            self._step()

        def card(i: int) -> dict:
            v = self.boats[i]
            return {
                "name": self.names[i],
                "build": self.builds[i],
                "outcome": self._outcome(v),
                "days": (v.state.t - self.start).total_seconds() / 86400.0,
                "battery_low": min([r["soc"] for r in v.log.rows] or [v.state.soc]),
                "breakdowns": sorted({e.kind.value for e in v.log.events if e.kind in BREAKDOWNS}),
            }

        ca, cb = card(0), card(1)
        arrived = Outcome.ARRIVED.value
        margin = cb["days"] - ca["days"] if ca["outcome"] == cb["outcome"] == arrived else None
        if margin is not None:
            winner = None if abs(margin) < DRAW_DAYS else (0 if margin > 0 else 1)
            verdict = "draw" if winner is None else "finished_first"
        elif ca["outcome"] == arrived or cb["outcome"] == arrived:
            winner, verdict = (0 if ca["outcome"] == arrived else 1), "only_one_finished"
        else:
            winner, verdict = None, "neither_finished"
        if verdict == "draw":
            words = (
                f"A draw: both finished within {DRAW_DAYS:g} day of each other, "
                "inside the weather's luck."
            )
        elif verdict == "finished_first":
            w, lo = (ca, cb) if winner == 0 else (cb, ca)
            words = f"{w['name']} finished first, {abs(margin):.1f} days ahead of {lo['name']}."
        elif verdict == "only_one_finished":
            w, lo = (ca, cb) if winner == 0 else (cb, ca)
            words = (
                f"{w['name']} finished; {lo['name']} didn't ({lo['outcome'].replace('_', ' ')})."
            )
        else:
            words = "Neither boat finished this launch."
        return {
            "launch": _iso(self.start),
            "seed": self.seed,
            "breakdowns_on": self.breakdowns,
            "boats": [ca, cb],
            "margin_days": margin,  # positive: A finished first
            "winner": winner,  # 0 = A, 1 = B, None = draw or neither
            "verdict": verdict,
            "words": words
            + " One race is one roll of the dice: see the season for which is better.",
            "breakdowns_differ": ca["breakdowns"] != cb["breakdowns"],
        }


def season(env, a: dict | None = None, b: dict | None = None, which=None, drop="same") -> dict:
    """Every launch of the season for both builds, paired launch by launch.
    The page can instead run one launch per worker with `season_launch` and
    pass the list to `season_verdict`; the answer is the same."""
    runs = [
        season_launch(env, a, b, i)
        for i in range(len(launches(env)))
        if which is None or i in which
    ]
    return season_verdict(a, b, runs)


def season_launch(env, a: dict | None, b: dict | None, i: int, drop="same") -> dict:
    """Launch i for both builds: the same voyages run_voyage gives from those drops."""
    start, seed = launches(env)[i]
    da, db = drops(a, b, drop)
    ra = run_voyage(a, env, start, seed, drop=da)
    rb = run_voyage(b, env, start, seed, drop=db)
    return {
        "index": i,
        "a": ra["result"],
        "b": rb["result"],
        "replays": [ra["replay"], rb["replay"]],
    }


def season_verdict(a: dict | None, b: dict | None, runs: list[dict]) -> dict:
    """The paired verdict over launches (Ravi's leaderboard.paired, rule 3)."""
    na, nb = _names(a, b)

    def entry(name: str, key: str) -> dict:
        return {
            "design": name,
            "launches": [
                {"start": r[key]["start"], "seed": r[key]["seed"], "outcome": r[key]["outcome"]}
                for r in runs
            ],
        }

    p = paired(entry(na, "a"), entry(nb, "b"))
    rows = [
        {
            "launch": r["a"]["start"],
            "a": {"outcome": r["a"]["outcome"], "days": r["a"].get("days")},
            "b": {"outcome": r["b"]["outcome"], "days": r["b"].get("days")},
        }
        for r in runs
    ]
    return {
        "names": [na, nb],
        "builds": [catalog.grid_id(a), catalog.grid_id(b)],
        "launches": rows,
        "finished": [
            sum(r["a"]["outcome"] == "arrived" for r in runs),
            sum(r["b"]["outcome"] == "arrived" for r in runs),
        ],
        "pair": {
            "n": p.n,
            "a_only": p.a_only,
            "b_only": p.b_only,
            "gap": p.gap,
            "lo": p.lo,
            "hi": p.hi,
            "p": p.p,
            "clear": p.clear,
        },
        "words": p.words(),
        "enough_launches": p.n >= MIN_LAUNCHES,  # the leaderboard's bar; a season is 6
    }
