"""The weather bundle split by month (sandbox.forcing.split): the page downloads
only the months a voyage sails through, and every value read from the parts is
the whole bundle's, bit for bit."""

import dataclasses
import io
import json
import struct
from datetime import datetime, timedelta

import numpy as np
import pytest
from test_sandbox import _fake_sources

from boatsim.oceandata.grid import OutsideCoverage
from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R
from boatsim.sandbox.__main__ import main
from boatsim.sandbox.helm import Game


def _bits(e) -> tuple:
    """An EnvState's numbers as their exact bytes (so -0.0 and NaN count too)."""
    return tuple(struct.pack("<d", float(v)) for v in dataclasses.astuple(e))


@pytest.fixture(scope="module")
def files(tmp_path_factory):
    """A bundle over two month ends (25 April to 8 June) whose stored values are
    random, missing values included, so any slip in a step or a weight shows."""
    d = tmp_path_factory.mktemp("bundle")
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(4, 25), last=(6, 8))
    z = dict(np.load(io.BytesIO(buf.getvalue())))
    rng = np.random.default_rng(7)
    for fields in F.AXES.values():
        for f in fields:
            v = rng.integers(-300, 300, z[f].shape[1:]).astype("<i2")
            v[rng.random(v.shape) < 0.02] = F.FILL
            z[f] = np.ascontiguousarray(np.moveaxis(v.view(np.uint8).reshape(*v.shape, 2), -1, 0))
    whole = d / "forcing_2020.npz"
    np.savez_compressed(whole, **z)
    index = F.split(whole, d / "parts")
    return whole, d / "parts", index


def _times(n=400):
    rng = np.random.default_rng(11)
    t0 = datetime(2020, 4, 25)
    out = [t0 + timedelta(seconds=int(s)) for s in rng.integers(0, 44 * 86400 + 18 * 3600, n)]
    # the first and last moments, and around each month end: midnight, the rain's
    # half hour and hour, the daily values' noon
    out += [t0, datetime(2020, 6, 8, 18)]
    for m in (5, 6):
        edge = datetime(2020, m, 1)
        out += [edge + timedelta(minutes=k) for k in (-720, -60, -31, -30, -29, -1, 0, 1, 29, 30, 31, 59, 60, 61, 360, 719, 720, 721)]  # fmt: skip
    return out


def test_split_writes_a_static_file_and_one_part_a_month(files):
    _whole, parts, index = files
    assert [p["key"] for p in index["parts"]] == ["2020-04", "2020-05", "2020-06"]
    assert index["static"] == "forcing_2020_static.npz" and index["whole"] == "forcing_2020.npz"
    assert json.loads((parts / "forcing_2020_parts.json").read_text()) == index
    for p in index["parts"]:
        assert (parts / p["file"]).stat().st_size == p["bytes"] > 0
    # the static file carries no weather: the page loads it before any month
    static = np.load(parts / index["static"])
    assert not {f for fs in F.AXES.values() for f in fs} & set(static.files)
    assert {"lat", "lon", "t_weather", "t_daily", "t_rain", "t_current", "ship_density"} <= set(static.files)  # fmt: skip


def test_the_parts_hold_the_bundles_own_bytes(files):
    whole, parts, index = files
    z = np.load(whole)
    for fields in F.AXES.values():
        for f in fields:
            pieces = []
            for n, p in enumerate(index["parts"]):
                a = np.load(parts / p["file"])[f]
                pieces.append(a if n == len(index["parts"]) - 1 else a[:, :-1])
            assert np.concatenate(pieces, axis=1).tobytes() == z[f].tobytes(), f


def test_every_sample_from_the_parts_is_the_whole_bundles_bit_for_bit(files):
    whole, parts, _index = files
    a = F.BundleEnvironment(whole)
    b = F.open_parts(parts / "forcing_2020_parts.json")
    assert b.meta == a.meta and b.loaded == set(b.parts)
    rng = np.random.default_rng(3)
    for t in _times():
        lat, lon = rng.uniform(28.0, 50.0), rng.uniform(-78.0, -8.0)
        assert _bits(b.sample(t, lat, lon)) == _bits(a.sample(t, lat, lon)), t
    for g, h in ((a.weather, b.weather), (a.daily, b.daily), (a.rain, b.rain), (a.currents, b.currents)):  # fmt: skip
        assert list(h.fields) == list(g.fields)
        assert (h.times == g.times).all() and (h.lats == g.lats).all() and (h.lons == g.lons).all()


def test_past_the_ends_of_the_season_is_outside_coverage_as_before(files):
    whole, parts, _index = files
    a = F.BundleEnvironment(whole)
    b = F.open_parts(parts / "forcing_2020_parts.json")
    for t in (datetime(2020, 4, 24, 23), datetime(2020, 6, 8, 18, 1)):
        with pytest.raises(OutsideCoverage):
            a.sample(t, 40.0, -40.0)
        with pytest.raises(OutsideCoverage):
            b.sample(t, 40.0, -40.0)


def test_a_month_that_isnt_loaded_is_never_taken_for_the_end_of_the_weather(files):
    whole, parts, index = files
    env = F.BundleEnvironment(parts / index["static"])
    assert env.parts == ["2020-04", "2020-05", "2020-06"] and env.loaded == set()
    with pytest.raises(F.WeatherNotLoaded, match="WEATHER_PART 2020-04") as err:
        env.sample(datetime(2020, 4, 26), 40.0, -40.0)
    assert not isinstance(err.value, (OutsideCoverage, ValueError))
    env.add_part("2020-04", (parts / "forcing_2020_2020-04.npz").read_bytes())
    env.add_part("2020-04", parts / "forcing_2020_2020-04.npz")  # again: nothing
    whole_env = F.BundleEnvironment(whole)
    t = datetime(2020, 4, 30, 17)
    assert _bits(env.sample(t, 40.0, -40.0)) == _bits(whole_env.sample(t, 40.0, -40.0))
    # 1 May 03:00: the wind is May's, and the daily values still read April's last step
    with pytest.raises(F.WeatherNotLoaded, match="2020-05"):
        env.sample(datetime(2020, 5, 1, 3), 40.0, -40.0)


def test_missing_names_the_months_a_span_could_read(files):
    whole, parts, index = files
    env = F.BundleEnvironment(parts / index["static"])
    assert env.missing(datetime(2020, 4, 26), datetime(2020, 4, 28)) == ["2020-04"]
    assert env.missing(datetime(2020, 4, 26), datetime(2020, 4, 30, 12)) == ["2020-04", "2020-05"]
    assert env.missing(datetime(2020, 5, 1, 6), datetime(2020, 5, 9)) == ["2020-04", "2020-05"]
    assert env.missing(datetime(2020, 5, 20), datetime(2020, 9, 1)) == ["2020-05", "2020-06"]
    env.add_part("2020-05", parts / "forcing_2020_2020-05.npz")
    assert env.missing(datetime(2020, 5, 5), datetime(2020, 5, 9)) == []
    env.require(datetime(2020, 5, 5), datetime(2020, 5, 9))
    with pytest.raises(F.WeatherNotLoaded, match="2020-06"):
        env.require(datetime(2020, 5, 5), datetime(2020, 6, 2))
    assert F.BundleEnvironment(whole).missing(datetime(2020, 1, 1), datetime(2021, 1, 1)) == []


def test_open_bundle_reads_a_split_bundle_and_a_game_sails_it_the_same(files):
    whole, parts, _index = files
    a = R.open_bundle(whole)
    b = R.open_bundle(parts / "forcing_2020_parts.json")
    out = []
    for env in (a, b):
        g = Game(env, day="2020-04-27", max_days=6.0)
        g.run(hours=96)
        out.append((g.save(), json.dumps(g.status(), default=float), json.dumps(g.forecast(hours=120), default=float)))  # fmt: skip
    assert out[0] == out[1]


def test_split_command(files, tmp_path, capsys):
    whole, _parts, index = files
    main(["split", "--bundle", str(whole), "--out", str(tmp_path)])
    assert "split by month (bytes unchanged)" in capsys.readouterr().out
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(
        [index["static"], "forcing_2020_parts.json", *(p["file"] for p in index["parts"])]
    )


def test_a_game_asks_for_its_months_before_it_moves(files):
    """The page's loop: a call that needs a month raises before anything has
    changed, the month is added, and the same call then gives the whole
    bundle's answer."""
    whole, parts, index = files
    env = R.open_bundle(parts / index["static"])

    def retry(call):
        asked = []
        while True:
            try:
                return call(), asked
            except F.WeatherNotLoaded as need:
                asked.append(need.part)
                env.add_part(need.part, parts / f"forcing_2020_{need.part}.npz")

    g, asked = retry(lambda: Game(env, day="2020-04-27", max_days=30.0))
    assert asked == []  # nothing is read until the boats move
    t0, n0 = g.mine.state.t, len(g.mine.log.events)
    with pytest.raises(F.WeatherNotLoaded, match="2020-04"):
        g.run(hours=24)
    env.add_part("2020-04", parts / "forcing_2020_2020-04.npz")
    with pytest.raises(F.WeatherNotLoaded, match="2020-05"):
        g.run(hours=24)  # 28 April + 7 days of forecasts reaches into May
    assert g.mine.state.t == t0 and g.ghost.state.t == t0 and len(g.mine.log.events) == n0
    with pytest.raises(F.WeatherNotLoaded, match="2020-05"):
        g.order(90.0, 0.5)
    assert g.orders == []
    _, asked = retry(lambda: g.run(hours=24))
    assert asked == ["2020-05"]
    g.order(90.0, 0.5)
    g.run(hours=20 * 24)  # to 18 May at the latest: June isn't needed yet
    assert env.loaded == {"2020-04", "2020-05"}
    with pytest.raises(F.WeatherNotLoaded, match="2020-06"):
        g.run(hours=45 * 24)
    code = g.save()

    ref = Game(R.open_bundle(whole), day="2020-04-27", max_days=30.0)
    ref.run(hours=24)
    ref.order(90.0, 0.5)
    ref.run(hours=20 * 24)
    assert ref.save() == code
    assert json.dumps(ref.status(), default=float) == json.dumps(g.status(), default=float)

    # Continue from a save on a fresh page: both months are asked for up front.
    env = R.open_bundle(parts / index["static"])
    back, asked = retry(lambda: Game.load(env, code))
    assert asked == ["2020-04", "2020-05"]
    assert back.save() == code
