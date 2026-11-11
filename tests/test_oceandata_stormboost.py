"""Storm boost (#117): hurricane cores blended into ERA5, off by default."""

import io
import math
from datetime import datetime

import pytest

from boatsim.oceandata import stormboost as SB
from boatsim.oceandata.base import ConstantEnvironment
from boatsim.types import EnvState

CSV = """SID,SEASON,NUMBER,NAME,ISO_TIME,LAT,LON,USA_WIND,USA_PRES,USA_RMW,USA_SSHS
 ,Year, , ,,degrees_north,degrees_east,kts,mb,nmile,1
A,2020,1,ALPHA,2020-09-01 00:00:00,30.0,-60.0,100,950,15,3
A,2020,1,ALPHA,2020-09-01 06:00:00,31.0,-60.0,100,950,15,3
A,2020,1,ALPHA,2020-09-01 12:00:00,32.0,-60.0,90,960, ,2
A,2020,1,ALPHA,2020-09-01 18:00:00,33.0,-60.0,30,1005, ,-1
B,2020,2,BRAVO,2020-09-03 00:00:00,20.0,-50.0,60, , ,0
B,2020,2,BRAVO,2020-09-03 12:00:00,21.0,-50.0,60, , ,0
C,2030,3,CHARLIE,2030-09-01 12:00:00,35.0,-60.0,50, , ,0
"""
T = datetime(2020, 9, 1, 3)  # ALPHA at 30.5N 60W, moving north at about 5 m/s
CALM = EnvState(wind_u=3.0, wind_v=0.0, hs=1.5, tp=8.0, wave_dir=270.0, ghi=500.0)


@pytest.fixture(scope="module")
def tracks():
    return SB.StormTracks(SB.load_storms(io.StringIO(CSV), 2012, 2021))


def test_loader_keeps_tropical_storm_fixes_in_years():
    storms = SB.load_storms(io.StringIO(CSV), 2012, 2021)
    assert [s.name for s in storms] == ["ALPHA", "BRAVO"]  # CHARLIE is too late
    a = storms[0]
    assert len(a.t) == 3  # the depression at 18Z is weaker than a tropical storm
    assert a.rmw[0] == pytest.approx(15 * 1.852) and math.isnan(a.rmw[2])
    assert a.vmax[0] == pytest.approx(100 * 0.514444)


def test_interpolates_between_fixes_and_stops_at_gaps(tracks):
    a, b = tracks.storms
    fx = SB.storm_at(a, (T - SB._EPOCH).total_seconds())
    assert fx.lat == pytest.approx(30.5) and fx.lon == pytest.approx(-60.0)
    assert fx.cv == pytest.approx(111e3 / 21600) and fx.cu == pytest.approx(0.0)
    assert SB.B_MIN <= fx.b <= SB.B_MAX
    assert SB.storm_at(a, (datetime(2020, 9, 2) - SB._EPOCH).total_seconds()) is None
    # BRAVO's fixes are 12 h apart: too far to interpolate across.
    assert SB.storm_at(b, (datetime(2020, 9, 3, 6) - SB._EPOCH).total_seconds()) is None
    # No RMW in the file: Willoughby's estimate.
    late = SB.storm_at(a, (datetime(2020, 9, 1, 9) - SB._EPOCH).total_seconds())
    assert late.rmax_km == pytest.approx(SB._lerp(15 * 1.852, math.nan, 0.5))
    assert SB.willoughby_rmax_km(50, 30) == pytest.approx(46.4 * math.exp(-0.775 + 0.507))


def test_wind_peaks_at_rmax_on_the_right_and_turns_anticlockwise(tracks):
    a = tracks.storms[0]
    fx = SB.storm_at(a, (T - SB._EPOCH).total_seconds())
    dlon = fx.rmax_km / (111.0 * math.cos(math.radians(fx.lat)))
    east = SB.vortex(fx, fx.lat, fx.lon + dlon)  # right of a north-moving storm
    west = SB.vortex(fx, fx.lat, fx.lon - dlon)
    v10 = 0.93 * fx.vmax
    # Peak = the 10-minute best-track wind (the inflow tilts it a little off the motion).
    assert math.hypot(east.wind_u, east.wind_v) == pytest.approx(v10, rel=0.01)
    assert math.hypot(west.wind_u, west.wind_v) < v10 - 2  # motion subtracts on the left
    assert east.wind_v > 0 and west.wind_v < 0  # anticlockwise
    assert east.wind_u < 0  # spiralling in toward the eye
    inner = SB.vortex(fx, fx.lat, fx.lon + dlon / 4)
    outer = SB.vortex(fx, fx.lat, fx.lon + 1.5 * dlon)
    assert math.hypot(inner.wind_u, inner.wind_v) < math.hypot(east.wind_u, east.wind_v)
    assert outer.weight == pytest.approx(0.5)
    assert SB.vortex(fx, fx.lat, fx.lon + 2.1 * dlon) is None
    # Rankine: (Rmax / r)^0.6 outside, about 0.78 of the peak at 1.5 Rmax (before motion).
    vs = v10 - SB.MOTION_SHARE * math.hypot(fx.cu, fx.cv)
    north = SB.vortex(fx, fx.lat + 1.5 * fx.rmax_km / 111.0, fx.lon)  # wind blows west there
    assert -north.wind_u == pytest.approx(vs * 1.5**-0.6 * math.cos(math.radians(20)), rel=0.01)


def test_holland_profile_is_still_there(monkeypatch, tracks):
    monkeypatch.setattr(SB, "PROFILE", "holland")
    fx = SB.storm_at(tracks.storms[0], (T - SB._EPOCH).total_seconds())
    dlon = fx.rmax_km / (111.0 * math.cos(math.radians(fx.lat)))
    east = SB.vortex(fx, fx.lat, fx.lon + dlon)
    assert math.hypot(east.wind_u, east.wind_v) == pytest.approx(0.93 * fx.vmax, rel=0.01)


def test_young_waves(monkeypatch):
    hs, tp = SB.young_hs_tp(0.93 * 50, 5.0, 30.0)  # a category 3 storm
    assert 11 < hs < 15 and 12 < tp < 16
    hs_weak, _ = SB.young_hs_tp(18.0, 5.0, 60.0)
    assert hs_weak < hs
    monkeypatch.setattr(SB, "HS_CAP_M", 9.0)
    assert SB.young_hs_tp(0.93 * 50, 5.0, 30.0)[0] == 9.0  # capped


def test_boosted_env_is_era5_far_away_and_never_weaker(tracks):
    env = SB.StormBoost(ConstantEnvironment(CALM), tracks)
    assert env.sample(T, 40.0, -40.0) is CALM  # far from any storm: untouched
    assert env.sample(datetime(2020, 6, 1), 30.5, -60.0) is CALM  # no storm then
    near = env.sample(T, 30.5, -59.8)
    assert math.hypot(near.wind_u, near.wind_v) > 30
    assert near.hs == CALM.hs and near.tp == CALM.tp  # waves are off by default
    assert near.ghi == CALM.ghi and near.air_temp == CALM.air_temp  # only wind and waves
    gale = EnvState(wind_u=60.0, hs=20.0, tp=18.0, wave_dir=10.0)
    strong = SB.StormBoost(ConstantEnvironment(gale), tracks).sample(T, 30.5, -59.8)
    assert strong.wind_u == 60.0 and strong.hs == 20.0 and strong.wave_dir == 10.0
    assert env.state is CALM  # other attributes are the wrapped environment's


def test_waves_when_switched_on(monkeypatch, tracks):
    monkeypatch.setattr(SB, "BOOST_WAVES", True)
    near = SB.StormBoost(ConstantEnvironment(CALM), tracks).sample(T, 30.5, -59.8)
    assert near.hs > 8 and near.tp > 10


def test_off_by_default_and_flag_wires_it(monkeypatch, tracks):
    from boatsim.mc.months import MonthlyVoyage
    from boatsim.runner import parallel as P

    assert P.StandardVoyage().storm_boost is False and MonthlyVoyage().storm_boost is False
    assert not isinstance(P._environment("constant", True), SB.StormBoost)
    monkeypatch.setattr(SB, "default_storm_tracks", lambda: tracks)
    P._environment.cache_clear()
    try:
        boosted = P._environment("constant", True, False, True)
        assert isinstance(boosted, SB.StormBoost)
    finally:
        P._environment.cache_clear()


def test_missing_tracks_is_an_error(tmp_path):
    with pytest.raises(FileNotFoundError):
        SB.default_storm_tracks(tmp_path / "nope.csv")


def test_check_pairs_and_summarises(tracks):
    a = tracks.storms[0]

    class Fake:
        def sample(self, t, lat, lon):
            return {"wind_u": 10.0, "wind_v": 0.0, "hs": 3.0, "tp": 9.0, "wave_dir": 270.0}

    hours = [(datetime(2020, 9, 1, h), 35.0, 9.0) for h in (1, 3, 5, 20)]
    rows = SB.pair_case(a, hours, Fake(), 30.5, -59.8, "x:41048")
    assert len(rows) == 3  # 20Z is past the track
    assert all(r["boost_ws10"] >= r["era5_ws10"] for r in rows)
    out = SB.summarise_check(rows, log=lambda *_: None)
    near = [r for r in out if r["band_rmax"] == "0-1" and r["field"] == "ws10"]
    assert near and near[0]["n"] >= 1 and near[0]["boost_rms"] < near[0]["era5_rms"]
