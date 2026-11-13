"""Race view (boatsim.sandbox.race): two builds on the same launch, lockstep,
the odds-run voyages, and the paired season verdict."""

import io
import json
import subprocess
import sys
from datetime import timedelta

import pytest
from test_sandbox import _fake_sources

from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R
from boatsim.sandbox.race import Race, label, season, season_launch, season_verdict

MAY1 = 2  # launch index of 1 May 2020, inside the test bundle (1-4 May)
REVC = {"base": "revc"}


@pytest.fixture(scope="module")
def env():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 4))
    return R.open_bundle(buf.getvalue())


def test_names():
    assert label(None) == "Our kayak"
    assert label(REVC) == "Randolph Rev C (our model)"
    assert label({"thr": "one-t200"}) == "Our kayak, custom"


def test_each_boat_sails_its_odds_run_voyage(env):
    """Racing doesn't change either voyage: each is exactly run_voyage's."""
    r = Race(env, None, REVC, launch_index=MAY1, max_days=0.9)
    res = r.result()
    kayak_drop = (36.65, -74.94)
    assert r.drops == [kayak_drop, kayak_drop]  # same spot: A's drop
    for i, ch in enumerate((None, REVC)):
        start, seed = R.launches(env)[MAY1]
        odds = R.run_voyage(ch, env, start, seed, max_days=0.9, drop=kayak_drop)["result"]
        assert res["boats"][i]["outcome"] == odds["outcome"]
        v = r.boats[i]
        assert round(v.log.days, 2) == odds["days"]
        assert v.log.rows[-1]["lat"] == odds["end_lat"]
    assert res["verdict"] == "neither_finished" and res["winner"] is None
    assert json.loads(json.dumps(res)) == res


def test_own_drops_are_each_designs_and_match_the_boatyard_runs(env):
    r = Race(env, None, REVC, launch_index=MAY1, max_days=0.5, drop="own")
    assert r.drops == [(36.65, -74.94), (38.32, -74.97)]
    res = r.result()
    odds = R.run_voyage(REVC, env, *R.launches(env)[MAY1], max_days=0.5)["result"]
    assert round(r.boats[1].log.days, 2) == odds["days"]
    assert res["boats"][1]["outcome"] == odds["outcome"]


def test_lockstep_and_time_stops(env):
    r = Race(env, None, REVC, launch_index=MAY1, max_days=0.9)
    out = r.run(hours=6, lead_change=False, breakdown=False)
    assert out["stopped"] == "time"
    a, b = r.boats
    assert a.state.t == b.state.t == r.start + timedelta(hours=6)
    assert [x["t"] for x in out["track"][0]] == [x["t"] for x in out["track"][1]]
    st = out["status"]
    assert [x["name"] for x in st["boats"]] == ["Our kayak", "Randolph Rev C (our model)"]
    assert st["lead_km"] == pytest.approx(
        st["boats"][1]["km_to_finish"] - st["boats"][0]["km_to_finish"]
    )
    out = r.run(lead_change=False, breakdown=False)
    assert out["stopped"] in ("time", "finished", "over")
    assert json.loads(json.dumps(out)) == out


def test_the_first_status_has_the_weather_at_the_start(env):
    # Before any step the page still needs a wind to show at day 0.
    r = Race(env, None, REVC, launch_index=MAY1, max_days=0.9)
    before = [(v.state.t, v.state.lat, v.state.lon, v.env) for v in r.boats]
    for boat in r.status()["boats"]:
        w = boat["weather"]
        assert set(w) >= {
            "wind_u",
            "wind_v",
            "hs",
            "tp",
            "wave_dir",
            "current_u",
            "current_v",
            "ghi",
            "rain",
        }
        assert json.loads(json.dumps(w)) == w
    # Looking is not sailing: nothing about either boat has moved.
    assert [(v.state.t, v.state.lat, v.state.lon, v.env) for v in r.boats] == before


def test_same_build_twice_is_a_dead_heat(env):
    r = Race(env, None, None, launch_index=MAY1, max_days=0.9)
    r.run(hours=12, lead_change=False)
    assert r.lead_km() == 0.0
    assert r.status()["leader"] is None
    assert r.names == ("Our kayak (A)", "Our kayak (B)")


def test_season_verdict_is_ravis_paired_test(env):
    s = season(env, None, REVC, which=[MAY1])
    assert s["pair"]["n"] == 1 and not s["pair"]["clear"]
    assert "too close to call" in s["words"]
    assert s["enough_launches"] is False
    # one launch per worker, then the verdict: the same answer
    runs = [season_launch(env, None, REVC, MAY1)]
    assert season_verdict(None, REVC, runs)["words"] == s["words"]


def test_verdict_counts_flipped_launches():
    def run(i, a, b):
        start = f"2020-0{4 + i // 2}-{1 + 14 * (i % 2):02d}T12:00"
        return {
            "a": {"start": start, "seed": i, "outcome": a, "days": 70.0},
            "b": {"start": start, "seed": i, "outcome": b, "days": 80.0},
        }

    runs = [run(i, "arrived", "lost") for i in range(6)]
    v = season_verdict(None, REVC, runs)
    assert v["pair"]["a_only"] == 6 and v["pair"]["b_only"] == 0
    assert v["finished"] == [6, 0]
    assert v["words"].startswith("Our kayak beats Randolph Rev C")


def test_the_race_module_loads_without_pandas():
    """The browser (Pyodide) has numpy and pyyaml only."""
    code = "import sys, boatsim.sandbox.race; print('pandas' in sys.modules)"
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True)
    assert out.stdout.strip() == "False"
