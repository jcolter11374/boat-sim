"""Sailing tactician (autonomy/sailing.py): best VMG angles, tacking and gybing."""

import itertools
import math
from datetime import datetime, timedelta

import pytest

from boatsim.autonomy.guidance import WaypointAutopilot
from boatsim.autonomy.sailing import (
    KN,
    LAND_CLEAR_KM,
    SailingAutopilot,
    TablePolar,
    Tactician,
    VmgAngles,
)
from boatsim.autonomy.sphere import wrap180
from boatsim.geo import bearing_deg, distance_m, move
from boatsim.types import Mission, Sensors, Waypoint

# ORC certificate 038800017LU (First 31.7, 2021), knots, from Theo's stock-vessels
# design note. The 40 deg row is the certificate's upwind VMG over cos(best
# angle) (its best angle is 38-43 deg); the 180 deg row is a GUESS (150 x 0.85).
TWS = (6.0, 8.0, 10.0, 12.0, 14.0, 16.0, 20.0)
ROWS = {
    40.0: (4.28, 5.06, 5.71, 6.12, 6.23, 6.29, 6.30),
    52.0: (4.82, 5.72, 6.37, 6.72, 6.89, 6.95, 6.97),
    75.0: (5.31, 6.25, 6.75, 7.03, 7.26, 7.45, 7.64),
    90.0: (5.24, 6.23, 6.85, 7.17, 7.33, 7.59, 8.06),
    110.0: (5.22, 6.35, 6.95, 7.33, 7.71, 8.07, 8.48),
    135.0: (4.58, 5.64, 6.52, 7.00, 7.37, 7.79, 8.72),
    150.0: (3.84, 4.88, 5.80, 6.56, 7.00, 7.34, 8.12),
    180.0: (3.26, 4.15, 4.93, 5.58, 5.95, 6.24, 6.90),
}
CRUISER = TablePolar(TWS, tuple(ROWS), tuple(ROWS.values()), factor=0.9)
T0 = datetime(2020, 5, 1, 12)


def test_table_polar_lookup():
    assert CRUISER.speed_ms(10 * KN, 90) == pytest.approx(6.85 * 0.9 * KN)
    assert CRUISER.speed_ms(10 * KN, -90) == CRUISER.speed_ms(10 * KN, 90)  # either side
    mid = CRUISER.speed_ms(9 * KN, 90)
    assert CRUISER.speed_ms(8 * KN, 90) < mid < CRUISER.speed_ms(10 * KN, 90)
    assert CRUISER.speed_ms(0.0, 90) == 0.0
    assert CRUISER.speed_ms(10 * KN, 30) == 0.0  # 10 deg closer than the table: luffing
    assert CRUISER.speed_ms(40 * KN, 90) == CRUISER.speed_ms(20 * KN, 90)
    with pytest.raises(ValueError):
        TablePolar(TWS, (40.0,), ((1.0,),))


def test_best_vmg_angles_and_the_no_go_limit():
    up, down = VmgAngles(CRUISER)(12 * KN)
    assert 40.0 <= up < 52.0
    assert 135.0 <= down < 180.0
    up, _ = VmgAngles(CRUISER, min_twa_deg=46.0)(12 * KN)
    assert up >= 46.0


def test_beat_reach_and_run():
    tac = Tactician(CRUISER, min_twa_deg=46.0)
    tws = 12 * KN
    # Mark dead upwind (wind from the east): close hauled, never inside 46 deg.
    h = tac.heading(90.0, 90.0, 90.0, tws, 45.0, T0)
    assert tac.mode == "beat" and 46.0 <= abs(wrap180(h - 90.0)) < 60.0
    # Mark on the beam: steer the autopilot's own heading, crab and all.
    assert tac.heading(0.0, 357.0, 90.0, tws, 0.0, T0) == 357.0 and tac.mode == "reach"
    # Mark dead downwind (wind from the west): broad reach, not a dead run.
    h = tac.heading(90.0, 90.0, 270.0, tws, 90.0, T0)
    assert tac.mode == "run" and 0.0 < abs(wrap180(h - 90.0)) <= 45.0


def test_tacks_only_when_the_mark_is_clearly_across_and_not_too_often():
    tac = Tactician(CRUISER, min_twa_deg=46.0, switch_deg=10.0, min_switch_h=2.0)
    tws, wind = 12 * KN, 90.0
    h = tac.heading(95.0, 95.0, wind, tws, 90.0, T0)  # mark 5 deg right of the wind
    side = tac.side
    assert side == 1 and wrap180(h - wind) > 0
    # Mark drifts 8 deg to the other side: inside the 10 deg band, keep going.
    tac.heading(82.0, 82.0, wind, tws, h, T0 + timedelta(hours=1))
    assert tac.side == side and tac.switches == 0
    # 12 deg across: tack.
    h2 = tac.heading(78.0, 78.0, wind, tws, h, T0 + timedelta(hours=3))
    assert tac.side == -side and tac.switches == 1 and wrap180(h2 - wind) < 0
    # A wind shift right after: too soon to tack back.
    tac.heading(105.0, 105.0, wind, tws, h2, T0 + timedelta(hours=4))
    assert tac.side == -side and tac.switches == 1
    tac.heading(105.0, 105.0, wind, tws, h2, T0 + timedelta(hours=5, minutes=1))
    assert tac.side == side and tac.switches == 2


def _sail_to(mark, wind_from, tws, hours=60, land_km=None, track=None, corridor_km=10.0):
    # land_km: distance to a test coast; the autopilot sees it as a mask (<= 0).
    """Flat-water point-mass boat at polar speed, through the full autopilot."""
    guidance = WaypointAutopilot(acceptance_radius_m=1_000.0)
    tac = Tactician(CRUISER, min_twa_deg=46.0, corridor_km=corridor_km)
    on_land = None if land_km is None else (lambda lat, lon: land_km(lat, lon) <= 0.0)
    ap = SailingAutopilot(guidance, tac, guidance=guidance, on_land=on_land)
    mission = Mission([Waypoint(*mark)])
    lat, lon, heading, t = 36.65, -74.94, 0.0, T0
    switches_at = []
    for _ in range(int(hours * 6)):
        s = Sensors(t, lat, lon, heading, 0.9, wind_from_deg=wind_from, wind_speed_ms=tws)
        n = tac.switches
        heading = ap.update(s, mission, t).heading
        if tac.switches > n:
            switches_at.append(t)
        twa = wrap180(heading - wind_from)
        assert abs(twa) >= 46.0 - 1e-9  # never asks for the no-go zone
        v = CRUISER.speed_ms(tws, twa) * 600.0
        lat, lon = move(lat, lon, *_east_north(heading, v))
        if track is not None:
            track.append((lat, lon))
        t += timedelta(minutes=10)
        if distance_m(lat, lon, *mark) < 1_000.0:
            return t - T0, switches_at, guidance
    raise AssertionError("never reached the mark")


def _east_north(heading, d):
    r = math.radians(heading)
    return d * math.sin(r), d * math.cos(r)


def test_beats_up_to_a_mark_dead_upwind():
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 1.0)  # ~89 km east, wind from the east
    took, switches_at, guidance = _sail_to(mark, bearing_deg(*start, *mark), 12 * KN)
    vmg = 89_000 / took.total_seconds()
    best = max(CRUISER.speed_ms(12 * KN, a) * math.cos(math.radians(a)) for a in range(46, 90))
    assert vmg > 0.8 * best  # zig-zagging costs little beyond the angle itself
    assert 1 <= len(switches_at) <= 20
    assert all(b - a >= timedelta(hours=2) for a, b in itertools.pairwise(switches_at))
    assert abs(guidance.crab_deg) < 0.01  # no current learnt from the zig-zag


def test_runs_down_to_a_mark_dead_downwind():
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 1.0)
    took, switches_at, _ = _sail_to(mark, (bearing_deg(*start, *mark) + 180.0) % 360.0, 12 * KN)
    assert 89_000 / took.total_seconds() > 0.9 * CRUISER.speed_ms(12 * KN, 180.0)
    assert len(switches_at) <= 20


def test_no_wind_vane_means_no_change():
    """Boats without a vane (the kayak) get the inner command untouched."""
    guidance = WaypointAutopilot()
    ap = SailingAutopilot(guidance, Tactician(CRUISER), guidance=guidance)
    mission = Mission([Waypoint(39.5, -13.5)])
    s = Sensors(T0, 36.65, -74.94, 90.0, 0.9)
    plain = WaypointAutopilot().update(s, Mission([Waypoint(39.5, -13.5)]), T0)
    assert ap.update(s, mission, T0) == plain


def test_helm_finish_order_tacks_on_a_sailboat():
    from boatsim.autonomy.helm import HelmAutopilot

    finish = (36.65, -73.94)  # due east
    h = HelmAutopilot(finish, heading="finish", power=0.7, tactician=Tactician(CRUISER, 46.0))
    route = Mission([Waypoint(*finish)])
    s = Sensors(T0, 36.65, -74.94, 45.0, 0.9, wind_from_deg=90.0, wind_speed_ms=12 * KN)
    cmd = h.update(s, route, T0)
    assert abs(wrap180(cmd.heading - 90.0)) >= 46.0 and h.guidance.tacking
    h.set_order(100, 0.7)  # a compass order is steered as given
    assert h.update(s, route, T0).heading == 100 and not h.guidance.tacking
    plain = HelmAutopilot(finish, heading="finish", power=0.7)  # no polar: straight at it
    assert 85 < plain.update(s, route, T0).heading < 95


def test_wrap_for_sailing_only_touches_boats_with_a_polar():
    from types import SimpleNamespace

    from boatsim.autonomy.sailing import tactician_for, wrap_for_sailing

    ap = WaypointAutopilot()
    assert wrap_for_sailing(ap, SimpleNamespace(sail=None)) is ap
    boat = SimpleNamespace(
        polar=CRUISER, sail=SimpleNamespace(min_upwind_twa_deg=45.0, min_downwind_twa_deg=170.0)
    )
    wrapped = wrap_for_sailing(ap, boat)
    assert isinstance(wrapped, SailingAutopilot) and wrapped.guidance is ap
    tac = tactician_for(boat)
    assert tac.min_twa_deg == 46.0 and tac.max_twa_deg == 169.0


def test_land_ahead_tacks_away_at_once():
    """Holding a tack onto land is never right, even inside min_switch_h."""
    tac = Tactician(CRUISER, min_twa_deg=46.0, min_switch_h=2.0)
    tws, wind = 12 * KN, 90.0
    h = tac.heading(90.0, 90.0, wind, tws, 90.0, T0)
    assert tac.side == 1  # heading ~140, south of east
    blocked = lambda heading: 8.0 if abs(wrap180(heading - h)) < 1.0 else math.inf
    h2 = tac.heading(90.0, 90.0, wind, tws, h, T0 + timedelta(minutes=10), open_water=blocked)
    assert tac.side == -1 and tac.switches == 1 and wrap180(h2 - wind) < 0
    # Land on both sides: keep the side with more room.
    tight = lambda heading: 5.0 if wrap180(heading - wind) < 0 else 9.0
    tac.heading(90.0, 90.0, wind, tws, h2, T0 + timedelta(minutes=20), open_water=tight)
    assert tac.side == 1


def test_beats_round_an_island_on_the_first_tack():
    """15 May 2020 cruiser replay: a healthy boat beat onto Pico (Azores) on
    one long tack. An island 30 km down the first tack must be avoided."""
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 1.0)  # dead upwind, wind from the east
    wind = bearing_deg(*start, *mark)
    blind: list = []  # without a chart it sails across the island (no grounding here)...
    _sail_to(mark, wind, 12 * KN, land_km=lambda lat, lon: math.inf, track=blind)
    island = blind[len(blind) // 6]  # a point on the first tack
    radius_km = 4.0

    def land_km(lat, lon):
        return max(0.0, distance_m(lat, lon, *island) / 1000.0 - radius_km)

    def closest(track):
        return min(land_km(*p) for p in track)

    assert closest(blind) == 0.0
    seen: list = []
    took, _, _ = _sail_to(mark, wind, 12 * KN, land_km=land_km, track=seen)
    assert closest(seen) >= LAND_CLEAR_KM - 1.0  # ...with one it keeps clear
    assert took < timedelta(hours=30)


@pytest.mark.parametrize(
    ("width_km", "max_tacks"), [(80.0, 7), (40.0, 8), (20.0, 20), (12.0, None)]
)
def test_beats_up_a_channel_without_dithering(width_km, max_tacks):
    """Ravi's check of #252: up a channel, both tacks see land inside the
    look-ahead, and "the other side is clearer" flipped almost every step (71
    tacks in 12 h at 40 km). Now only land within LAND_URGENT_KM tacks early."""
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 3.0)  # ~270 km up the channel, dead upwind
    wind = bearing_deg(*start, *mark)

    def land_km(lat, lon):
        off_axis = distance_m(lat, start[1], *start) / 1000.0  # km north or south
        return max(0.0, width_km / 2.0 - off_axis)

    track: list = []
    with pytest.raises(AssertionError, match="never reached"):  # 12 h is not enough
        _sail_to(mark, wind, 12 * KN, hours=12, land_km=land_km, track=track)
    assert min(land_km(*p) for p in track) >= LAND_CLEAR_KM - 1.0  # never ashore
    tacks = sum(
        1
        for a, b, c in zip(track, track[1:], track[2:], strict=False)
        if (b[0] - a[0]) * (c[0] - b[0]) < 0  # north-south direction reverses
    )
    # Wide water: the normal tack every min_switch_h. 20 km: wall to wall,
    # about 40 minutes a board. Narrower than ~2 x LAND_URGENT_KM of beat plus
    # the margins, the tacks come as fast as the walls force them, but it
    # still never touches land.
    if max_tacks is not None:
        assert tacks <= max_tacks
    # And it keeps working up the channel: Ravi's check of #252 had it turn
    # round and run 225 km back downwind once both tacks saw land.
    made_good_km = distance_m(*start, start[0], track[-1][1]) / 1000.0
    assert track[-1][1] > start[1] and made_good_km > 60.0


def test_never_holds_on_to_the_shore_between_two_islands():
    """15 May 2020 replay: beating between Pico and Faial, land close ahead on
    both tacks, it held on and ran aground. Now, with nothing clearer to tack
    onto, it steers for open water instead. Here the leg itself runs through a
    gap between two islands, which base never sends (the lane, corridor_km,
    keeps the boat away from such places), so this is the look-ahead alone,
    the backstop: it stays off the land and still gets through."""
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 1.0)
    wind = bearing_deg(*start, *mark)
    islands = [move(*start, *_east_north((wind + s * 50.0) % 360.0, 12_000.0)) for s in (1, -1)]
    radius_km = 3.0

    def land_km(lat, lon):
        return max(0.0, min(distance_m(lat, lon, *i) / 1000.0 - radius_km for i in islands))

    seen: list = []
    took, _, _ = _sail_to(
        mark, wind, 12 * KN, hours=30, land_km=land_km, track=seen, corridor_km=math.inf
    )
    assert min(land_km(*p) for p in seen) >= 1.0
    assert took < timedelta(hours=20)


def test_the_lane_keeps_the_zig_zag_near_the_leg():
    """Base checks each leg for land 20 km either side; the tactician tacks
    back before it is corridor_km off the line, whatever min_switch_h says."""
    start = (36.65, -74.94)
    mark = (36.65, -74.94 + 1.0)
    wind = bearing_deg(*start, *mark)
    seen: list = []
    _sail_to(mark, wind, 6 * KN, track=seen, corridor_km=5.0)
    off = max(abs(distance_m(p[0], start[1], *start)) for p in seen) / 1000.0
    assert off < 5.0 + 2.0  # one 10-minute step past the line at most


def test_a_sail_only_wing_boat_gets_the_tactician_on_its_own_speed_table():
    """The wind-powered drone has a wing and no motors: since 11 Nov 2026 it
    tacks and keeps a land look-ahead like the cruiser, from a speed table of
    its own physics. Ravi's 10-year runs had healthy drones beating ashore on
    Iberia and Morocco without it."""
    import numpy as np

    from boatsim.autonomy.sailing import tactician_for, wrap_for_sailing
    from boatsim.config import load_design
    from boatsim.types import Command, EnvState
    from boatsim.vessel import make_vessel
    from boatsim.vessel.kayak import SteadyPolar

    drone = make_vessel(load_design("configs/stock_sail_drone7.yaml"))
    tac = tactician_for(drone)
    assert isinstance(tac.polar, SteadyPolar) and tac.min_twa_deg == 51.0
    assert isinstance(wrap_for_sailing(WaypointAutopilot(), drone), SailingAutopilot)
    # Its wind vane: nothing before the first step, then the wind it sails in.
    s = drone.initial_state(T0, 36.65, -74.94)
    rng = np.random.default_rng(0)
    assert drone.sense(s, rng).wind_from_deg is None
    env = EnvState(wind_u=0.0, wind_v=-7.0, hs=1.0, wave_dir=0.0)  # from the north
    s2, _ = drone.step(s, Command(heading=90.0, thrust_fraction=0.0), env,
                       timedelta(minutes=10), rng)  # fmt: skip
    seen = drone.sense(s2, rng)
    assert seen.wind_from_deg == pytest.approx(0.0, abs=1.0) and seen.wind_speed_ms > 6.0
    # Randolph's Rev B/C keep their own autopilot's steering (configs: tactician false).
    for rev in ("b", "c"):
        assert tactician_for(make_vessel(load_design(f"configs/randolph_rev_{rev}.yaml"))) is None
    # A kayak with motors and no wing, and a hybrid wing-and-motor boat, are unchanged.
    kayak = make_vessel(load_design("configs/v4_kayak.yaml"))
    assert tactician_for(kayak) is None and kayak.steady_polar() is None
    d = load_design("configs/stock_sail_drone7.yaml")
    d.propulsion.update(thruster_count=2, cruise_drive_w=25, max_drive_w=50)
    assert tactician_for(make_vessel(d)) is None
