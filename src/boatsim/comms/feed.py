"""Live tracker feed (3D roadmap item 3): satellite reports -> public JSON.

During the real voyage, a scheduled Action will collect the boat's Iridium
reports and Globalstar beacon pings, decode them, and publish voyage.json for
the 3D viewer, with ghost.json (a simulated prediction from the latest fix)
alongside. Spec: the "Live tracker feed" note (tracker/live-feed-spec.md).

Until there is a boat at sea, **replay mode** fakes the satellite side: it sails
a simulated voyage, records exactly what base would receive (the packed 16-byte
reports with their send and receive times, the beacon pings, the routes base
sent), and feeds that "tape" through the same builder the live pipeline will
use. A clock maps real time onto voyage time, so the feed grows like a live
one and the viewer can be built against real-shaped data now.

What the builder guarantees, live or replay:

* **Nothing before the drop.** Fixes before the voyage start, or within
  `prefilter_km` of the launch area before the drop, are never published (the
  shakedown track would show where the boat is kept).
* **Near-land delay** (John, 10 Nov 2026: "sure the delay is fine"): a fix
  within `near_land_km` (20 km) of land is published `delay_h` (24 h) late, and
  so is a route base sent from such a fix, so nobody can use the feed to go and
  meet the boat.
* **No identifiers.** No IMEI, ESN, account names, provider message ids or raw
  bytes in the feed. A report whose status byte won't decode keeps its position,
  gets `mode: "unknown"`, and its hex goes only to the private job log.
* **Status from fixes alone.** finished / aground / lost_contact / dq come from
  what base has received, never from the simulator's truth, so replay behaves as
  live will.

Usage:

    python -m boatsim.comms.feed replay --out feed/            # voyage.json, ghost.json
    python -m boatsim.comms.feed replay --day 30 --out feed/   # as of day 30

Owner: Sam.
"""

from __future__ import annotations

import argparse
import itertools
import json
import logging
import math
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import numpy as np

from boatsim.comms.packing import Status, pack_report, unpack_report
from boatsim.geo import distance_m
from boatsim.runner.arrival import SILENT_DAYS_IN_A_ROW, SILENT_DAYS_TOTAL, SilenceClock
from boatsim.types import EnvState, Outcome

log = logging.getLogger("boatsim.feed")

SCHEMA = 1
NEAR_LAND_KM = 20.0  # John, 10 Nov 2026
DELAY_H = 24.0  # John, 10 Nov 2026
PREFILTER_KM = 50.0  # GUESS: radius round the launch area kept private before the drop
LOST_CONTACT_H = 72.0  # GUESS: no fix for 3 days -> "lost_contact" on the page


def _iso(t: datetime) -> str:
    return t.astimezone(UTC).isoformat(timespec="seconds").replace("+00:00", "Z")


def _dt(s: str) -> datetime:
    t = datetime.fromisoformat(s)
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _land_km(lat: float, lon: float) -> float:
    from boatsim.vessel.coast import distance_to_land_km

    return distance_to_land_km(lat, lon)


# --------------------------------------------------------------------- decode


def decode_uplink(raw: bytes) -> dict | None:
    """One Iridium report -> fix fields. Never raises: a bad status byte keeps
    the position with mode "unknown"; an unreadable record is skipped. Either
    way the hex goes to the (private) job log, never to the feed."""
    try:
        r = unpack_report(raw)
    except ValueError:
        # Reserved status bits set: keep the position, drop the flags.
        try:
            r = unpack_report(raw[:-1] + b"\x00")
        except Exception:  # noqa: BLE001 - one bad record must not stop the job
            log.warning("unreadable report %s", raw.hex())
            return None
        log.warning("report with bad status byte %s", raw.hex())
        r["status"], r["flags"] = None, None
    except Exception:  # noqa: BLE001
        log.warning("unreadable report %s", raw.hex())
        return None
    st = r["status"]
    if st is None:
        mode = "unknown"
    elif st["lost_comms"]:
        mode = "lost_comms"
    elif st["safe_mode"]:
        mode = "safe"
    else:
        mode = "normal"
    return {
        "t": _iso(_dt(r["t"])),
        "lat": r["lat"],
        "lon": r["lon"],
        "soc": r["soc"],
        "hdg": r["hdg"],
        "mode": mode,
        "flags": st,
    }


# ---------------------------------------------------------------------- tape


@dataclass
class Tape:
    """What base receives, in the order it arrives. Raw uplinks stay bytes."""

    start: datetime
    start_lat: float
    start_lon: float
    finish: tuple[float, float, float]  # lat, lon, radius_km
    name: str = "v4 kayak"
    uplinks: list[tuple[datetime, datetime, bytes]] = field(default_factory=list)  # t, rx, raw
    pings: list[tuple[datetime, datetime, float, float]] = field(default_factory=list)
    routes: list[dict] = field(default_factory=list)  # sent, version, kind, waypoints, near_land
    replay: bool = False
    weather: str = "real"


# --------------------------------------------------------------------- build


def build_feed(
    tape: Tape,
    now: datetime,
    near_land_km: float = NEAR_LAND_KM,
    delay_h: float = DELAY_H,
    prefilter_km: float = PREFILTER_KM,
    land_km=_land_km,
) -> dict:
    """voyage.json as of `now`: only what base had received and may publish."""
    delay = timedelta(hours=delay_h)

    def private(t: datetime, lat: float, lon: float) -> bool:
        before = t < tape.start
        near_home = distance_m(lat, lon, tape.start_lat, tape.start_lon) < prefilter_km * 1e3
        return before or (near_home and t < tape.start)

    def publish_at(t: datetime, rx: datetime, lat: float, lon: float) -> datetime:
        return max(rx, t + delay) if land_km(lat, lon) < near_land_km else rx

    fixes, heard = [], []
    for t, rx, raw in tape.uplinks:
        if rx > now:
            continue
        f = decode_uplink(raw)
        if f is None:
            continue
        heard.append(t)
        if private(t, f["lat"], f["lon"]) or publish_at(t, rx, f["lat"], f["lon"]) > now:
            continue
        fixes.append({**f, "src": "iridium", "rx": _iso(rx)})
    for t, rx, lat, lon in tape.pings:
        if rx > now:
            continue
        heard.append(t)
        if private(t, lat, lon) or publish_at(t, rx, lat, lon) > now:
            continue
        fixes.append({"t": _iso(t), "src": "beacon", "lat": lat, "lon": lon, "rx": _iso(rx)})
    fixes.sort(key=lambda f: f["t"])

    routes = []
    for r in tape.routes:
        out = r["sent"] + delay if r.get("near_land") else r["sent"]
        if r["sent"] < tape.start or out > now:
            continue
        item = {"sent": _iso(r["sent"]), "version": r["version"], "kind": r["kind"]}
        if r["kind"] == "route":
            item["waypoints"] = [[round(a, 4), round(b, 4)] for a, b in r["waypoints"]]
        routes.append(item)
    routes.sort(key=lambda r: r["sent"], reverse=True)

    flat, flon, frad = tape.finish
    summary, status = None, "pre_launch" if now < tape.start else "at_sea"
    if fixes:
        last = fixes[-1]
        km = 0.0
        for a, b in itertools.pairwise(fixes):
            km += distance_m(a["lat"], a["lon"], b["lat"], b["lon"]) / 1e3
        clock = SilenceClock(tape.start)
        for t in heard:
            clock.heard(t)
        last_heard = max(heard)
        to_finish = distance_m(last["lat"], last["lon"], flat, flon) / 1e3
        summary = {
            "days_at_sea": round((now - tape.start).total_seconds() / 86400, 1),
            "km_sailed": round(km),
            "km_to_finish": round(to_finish),
            "last_fix_age_h": round((now - _dt(last["t"])).total_seconds() / 3600, 1),
            "silent_days_total": clock.silent_total(now),
        }
        if any(distance_m(f["lat"], f["lon"], flat, flon) <= frad * 1e3 for f in fixes):
            status = "finished"
        elif clock.disqualified(now):
            status = "dq"
        elif land_km(last["lat"], last["lon"]) < 1.0:
            status = "aground"
        elif (now - last_heard).total_seconds() > LOST_CONTACT_H * 3600:
            status = "lost_contact"
    voyage = {
        "name": tape.name,
        "start": {"t": _iso(tape.start), "lat": tape.start_lat, "lon": tape.start_lon},
        "finish": {"lat": flat, "lon": flon, "radius_km": frad},
        "status": status,
        "rules": {
            "silent_days_in_a_row": SILENT_DAYS_IN_A_ROW,
            "silent_days_total": SILENT_DAYS_TOTAL,
        },
        "near_land_delay": {"km": near_land_km, "hours": delay_h},
    }
    if tape.replay:
        voyage["replay"] = {"weather": tape.weather}
    return {
        "schema": SCHEMA,
        "updated": _iso(now),
        "voyage": voyage,
        "fixes": fixes,
        "routes": routes,
        "summary": summary,
    }


# ------------------------------------------------------------- replay voyage


class SyntheticWeather:
    """Spring-like weather with no data download: a mean state plus smooth
    random anomalies (the forecast-error patterns of oceandata.forecast used as
    weather), and a day/night cycle for the sun. For replay mode only."""

    def __init__(self, seed: int, t0: datetime):
        from boatsim.oceandata import ConstantEnvironment
        from boatsim.oceandata.forecast import ErrorModel, IssuedForecast

        mean = EnvState(wind_u=4.0, wind_v=1.0, current_u=0.05, hs=1.6, tp=7.5, ghi=0.0)
        # Issued 10 days "before" the voyage, so the anomalies are at full size from the start.
        self._f = IssuedForecast(
            ConstantEnvironment(mean), t0 - timedelta(days=10), ErrorModel(), seed
        )

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        s = self._f.sample(t, lat, lon)
        hour = (t.hour + t.minute / 60 + lon / 15.0) % 24  # local solar time
        sun = max(0.0, math.cos(math.pi * (hour - 12.0) / 12.0)) * math.cos(math.radians(lat - 15))
        wave_dir = (
            math.degrees(math.atan2(-s.wind_u, -s.wind_v))
        ) % 360.0  # waves come with the wind
        return replace(s, hs=max(s.hs, 0.2), tp=max(s.tp, 3.0), ghi=900.0 * sun, wave_dir=wave_dir)


def _flags(autopilot) -> int:
    from boatsim.autonomy.safemode import Mode

    mode = getattr(autopilot, "mode", None)
    f = 0
    if mode is not None and mode != Mode.NORMAL:
        f |= Status.SAFE_MODE
    if mode == Mode.LOST_COMMS:
        f |= Status.LOST_COMMS
    if getattr(autopilot, "_holding", False):
        f |= Status.MOTORS_OFF
    if getattr(autopilot, "_thrusters_ok", None) == 1:
        f |= Status.ONE_THRUSTER
    return int(f)


class _RecLink:
    """Wraps the link: keeps each delivered report as the bytes base receives."""

    def __init__(self, inner, tape: Tape, autopilot):
        self._inner, self._tape, self._ap = inner, tape, autopilot
        self.last_rx: datetime | None = None
        self.last_pos: tuple[float, float] | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def send(self, msg, env, rng):
        t_rx = self._inner.send(msg, env, rng)
        if t_rx is not None and msg.direction == "up":
            raw = pack_report({**msg.payload, "flags": _flags(self._ap)})
            self._tape.uplinks.append((_utc(msg.payload["t"]), _utc(t_rx), raw))
        return t_rx


class _RecPinger:
    def __init__(self, inner, tape: Tape):
        self._inner, self._tape = inner, tape

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def ping(self, t, lat, lon, env, rng):
        out = self._inner.ping(t, lat, lon, env, rng)
        if out is not None:
            # Globalstar's back office forwards within minutes. GUESS: 5 min.
            self._tape.pings.append(
                (_utc(t), _utc(t) + timedelta(minutes=5), out["lat"], out["lon"])
            )
        return out


class _RecFinish:
    """Wraps the finish target: remembers where the boat first got inside."""

    def __init__(self, inner):
        self._inner, self.where = inner, None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def reached(self, lat, lon):
        hit = self._inner.reached(lat, lon)
        if hit and self.where is None:
            self.where = (lat, lon)
        return hit


class _RecBase:
    """Wraps base: notes each route or ack it sends, and whether the fix it
    answered was near land (then the route is delayed like the fix)."""

    def __init__(self, inner, tape: Tape, near_land_km: float):
        self._inner, self._tape, self._near = inner, tape, near_land_km
        self._last: list | None = None

    def __getattr__(self, name):
        return getattr(self._inner, name)

    def on_report(self, report, forecast):
        new = self._inner.on_report(report, forecast)
        if new is not None:
            wps = [(w.lat, w.lon) for w in new.waypoints]
            rx = self._tape.uplinks[-1][1] if self._tape.uplinks else _utc(report["t"])
            self._tape.routes.append(
                {
                    "sent": rx,
                    "version": len(self._tape.routes) + 1,
                    "kind": "ack" if wps == self._last else "route",
                    "waypoints": wps,
                    "near_land": _land_km(report["lat"], report["lon"]) < self._near,
                }
            )
            self._last = wps
        return new


def _utc(t) -> datetime:
    if isinstance(t, str):
        t = datetime.fromisoformat(t)
    return t if t.tzinfo else t.replace(tzinfo=UTC)


def _components(design, env, forecast, seed_note=""):
    from boatsim.autonomy import SafeModeAutopilot
    from boatsim.basestation import ForecastReplanPolicy
    from boatsim.comms import GlobalstarPinger, IridiumSBDLink
    from boatsim.runner import Components
    from boatsim.runner.land import default_land
    from boatsim.runner.simulate import default_mission
    from boatsim.vessel import KayakVessel

    prop = design.propulsion
    return Components(
        env=env,
        forecast=forecast,
        vessel=KayakVessel(design),
        autopilot=SafeModeAutopilot(cruise_fraction=prop["cruise_drive_w"] / prop["max_drive_w"]),
        link=IridiumSBDLink(),
        pinger=GlobalstarPinger(),
        land=default_land(),
        base=ForecastReplanPolicy(route=default_mission().waypoints),
    )


def record_replay(
    start: datetime,
    seed: int = 0,
    design_path: str = "configs/v4_kayak.yaml",
    max_days: float = 150.0,
):
    """Sail one simulated voyage in synthetic weather; return (tape, log)."""
    from boatsim.config import load_design
    from boatsim.oceandata.forecast import ErrorForecast
    from boatsim.runner import simulate
    from boatsim.runner.arrival import TARGET_RADIUS_M
    from boatsim.runner.simulate import default_mission

    design = load_design(design_path)
    v = design.voyage
    lat, lon = float(v["drop_lat"]), float(v["drop_lon"])
    start = _utc(start)
    env = SyntheticWeather(seed, start)
    c = _components(design, env, ErrorForecast(env, seed=seed + 1))
    tape = Tape(
        start=start,
        start_lat=lat,
        start_lon=lon,
        finish=(float(v["finish_lat"]), float(v["finish_lon"]), TARGET_RADIUS_M / 1e3),
        replay=True,
        weather="synthetic",
    )
    c.link = _RecLink(c.link, tape, c.autopilot)
    c.pinger = _RecPinger(c.pinger, tape)
    c.base = _RecBase(c.base, tape, NEAR_LAND_KM)
    c.finish = _RecFinish(c.finish)
    vlog = simulate(c, start, lat, lon, default_mission(), seed=seed, max_days=max_days)
    if vlog.outcome == Outcome.ARRIVED and vlog.rows:
        # The real boat keeps reporting after it reaches the finish circle;
        # the simulator stops there. Add the one fix that shows it arrived,
        # from whichever radio is still working.
        end, last = vlog.end, vlog.rows[-1]
        lat_in, lon_in = c.finish.where or (last["lat"], last["lon"])
        rep = {"t": end.isoformat(timespec="minutes"), "lat": lat_in, "lon": lon_in}
        if last.get("iridium_ok", True):
            raw = pack_report({**rep, "soc": last["soc"], "hdg": last["heading"]})
            tape.uplinks.append((_utc(end), _utc(end) + timedelta(minutes=2), raw))
        elif last.get("beacon_ok", True):
            tape.pings.append((_utc(end), _utc(end) + timedelta(minutes=5), lat_in, lon_in))
    return tape, vlog


# ---------------------------------------------------------------------- ghost


def ahead_of(waypoints: list, lon: float, margin_deg: float = 0.05) -> list:
    """Waypoints still east of the boat (the route runs west to east); at
    least the last one, the finish."""
    return [w for w in waypoints if w.lon > lon + margin_deg] or [waypoints[-1]]


def ghost(
    tape: Tape,
    feed: dict,
    now: datetime,
    runs: int = 10,
    days: float = 150.0,
    design_path: str = "configs/v4_kayak.yaml",
) -> dict | None:
    """Simulated prediction from the latest published fix (report or ping).

    Each run sails from that fix with the battery last reported, with breakdowns
    off (so p_finish means "if nothing breaks"), the route base
    last sent, and a forecast with realistic error (never the truth, so in
    replay mode the ghost can't see the future either)."""
    from boatsim.config import load_design
    from boatsim.oceandata.forecast import ErrorForecast
    from boatsim.runner import simulate
    from boatsim.runner.simulate import default_mission
    from boatsim.types import Mission, Waypoint

    if not feed["fixes"] or feed["voyage"]["status"] != "at_sea":
        return None
    fix = dict(feed["fixes"][-1])
    if "soc" not in fix:  # a beacon ping: take the battery from the last report
        rep = next((f for f in reversed(feed["fixes"]) if f["src"] == "iridium"), None)
        fix["soc"] = rep["soc"] if rep else 1.0
    design = load_design(design_path)
    t0 = _dt(fix["t"])
    route = next((r for r in feed["routes"] if r["kind"] == "route"), None)
    wps = [Waypoint(a, b) for a, b in route["waypoints"]] if route else default_mission().waypoints
    # A route sent days ago can start with a detour point the boat has since
    # passed; the autopilot would turn back for it. Drop points behind the
    # boat, as base does (ForecastReplanPolicy._ahead).
    wps = ahead_of(wps, fix["lon"])
    tracks, arrivals = [], []
    for k in range(runs):
        truth = SyntheticWeather(7919 * (k + 1), t0) if tape.weather == "synthetic" else None
        if truth is None:
            raise NotImplementedError("live ghost needs Priya's live forecast feed")
        env = ErrorForecast(truth, seed=k).issue(now)
        c = _components(design, env, ErrorForecast(env, seed=100 + k))
        init = c.vessel.initial_state

        def start_with_soc(t, lat, lon, _init=init):
            s = _init(t, lat, lon)
            s.battery_wh = s.battery_capacity_wh * max(0.0, min(1.0, fix["soc"]))
            return s

        c.vessel.initial_state = start_with_soc
        # Predict where the boat goes if it keeps working: breakdown odds are
        # Ravi's to frame, and a fresh hull here would restart the early-life
        # failure rates as if the boat had just launched.
        c.vessel.hazards = replace(c.vessel.hazards, enabled=False, failures_enabled=False)
        vlog = simulate(c, t0, fix["lat"], fix["lon"], Mission(list(wps)), seed=k, max_days=days)
        daily = {}
        for r in vlog.rows:
            d = int((r["t"] - t0).total_seconds() // 86400)
            daily.setdefault(d, (r["t"], r["lat"], r["lon"]))
        tracks.append(daily)
        hit = vlog.end if vlog.outcome == Outcome.ARRIVED else None
        arrivals.append(hit)
    n_days = max(max(d) for d in tracks if d) + 1
    median, spread = [], []
    for d in range(1, n_days):
        pts = [tr[d] for tr in tracks if d in tr]
        if len(pts) < max(2, runs // 2):
            break
        la = float(np.median([p[1] for p in pts]))
        lo = float(np.median([p[2] for p in pts]))
        t = t0 + timedelta(days=d)
        radius = float(np.percentile([distance_m(la, lo, p[1], p[2]) for p in pts], 80)) / 1e3
        median.append([_iso(t), round(la, 3), round(lo, 3)])
        spread.append([_iso(t), round(la, 3), round(lo, 3), round(radius)])
    done = sorted(a for a in arrivals if a is not None)

    def pct(p):
        if len(done) < runs * p / 100:
            return None
        return done[min(len(done) - 1, math.ceil(runs * p / 100) - 1)].date().isoformat()

    return {
        "schema": SCHEMA,
        "from_fix": fix["t"],
        "made": _iso(now),
        "runs": runs,
        "median": median,
        "spread": spread,
        "eta": {"p10": pct(10), "p50": pct(50), "p90": pct(90)},
        "p_finish": round(len(done) / runs, 2),
    }


# ----------------------------------------------------------------------- CLI


def replay_now(
    start: datetime, wall: datetime, epoch: datetime, days_per_hour: float, length_days: float
) -> datetime:
    """Map real time onto voyage time: `days_per_hour` voyage days pass each
    real hour since `epoch`, looping once the voyage is over."""
    hours = (wall - epoch).total_seconds() / 3600.0
    day = (hours * days_per_hour) % (length_days + 3.0)  # hold the ending for ~3 voyage days
    return start + timedelta(days=day)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="python -m boatsim.comms.feed")
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("replay", help="simulated voyage -> voyage.json and ghost.json")
    r.add_argument(
        "--start", default="2020-05-01T12:00:00Z", help="launch time of the simulated voyage"
    )
    r.add_argument("--seed", type=int, default=1)
    r.add_argument(
        "--day", type=float, help="voyage day to publish as of (default: from the clock)"
    )
    r.add_argument("--days-per-hour", type=float, default=1.0, help="replay speed for the clock")
    r.add_argument(
        "--epoch", default="2026-11-10T00:00:00Z", help="real time the replay clock started"
    )
    r.add_argument("--ghost-runs", type=int, default=10)
    r.add_argument("--out", type=Path, default=Path("feed"))
    a = ap.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    start = _dt(a.start)
    tape, vlog = record_replay(start, seed=a.seed)
    length = vlog.days
    if a.day is not None:
        now = start + timedelta(days=a.day)
    else:
        now = replay_now(start, datetime.now(UTC), _dt(a.epoch), a.days_per_hour, length)
    feed = build_feed(tape, now)
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "voyage.json").write_text(json.dumps(feed, separators=(",", ":")) + "\n")
    g = ghost(tape, feed, now, runs=a.ghost_runs) if a.ghost_runs > 0 else None
    (a.out / "ghost.json").write_text(json.dumps(g, separators=(",", ":")) + "\n")
    log.info(
        "replay day %.1f of %.1f: %d fixes, %d routes, status %s, ghost %s",
        (now - start).total_seconds() / 86400,
        length,
        len(feed["fixes"]),
        len(feed["routes"]),
        feed["voyage"]["status"],
        "none" if g is None else f"p_finish {g['p_finish']}",
    )


if __name__ == "__main__":
    main()
