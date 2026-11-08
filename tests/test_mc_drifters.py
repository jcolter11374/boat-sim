"""Drift check (#19): offline tests with made-up data, no network."""

from __future__ import annotations

from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import pytest

from boatsim.config import load_design
from boatsim.geo import distance_m
from boatsim.mc import drifters as D
from boatsim.oceandata import ConstantEnvironment
from boatsim.types import EnvState

T0 = datetime(2020, 1, 1)


def _track(lat0, lon0, u, v, days, step_h=1.0):
    """Straight-line track moving at (u, v) m/s, as the GDP loader returns it."""
    from boatsim.geo import move

    rows, lat, lon = [], lat0, lon0
    n = int(days * 24 / step_h)
    for i in range(n + 1):
        rows.append({"t": T0 + timedelta(hours=i * step_h), "lat": lat, "lon": lon})
        lat, lon = move(lat, lon, u * 3600 * step_h, v * 3600 * step_h)
    df = pd.DataFrame(rows)
    df["t"] = pd.to_datetime(df["t"])
    df["drogued"] = True
    return df


def test_water_model_moves_with_the_current():
    env = ConstantEnvironment(EnvState(current_u=0.5, current_v=0.0))
    m = D.drift(env, T0, 36.0, -70.0, 2, "water")
    moved = distance_m(36.0, -70.0, m["lat"].iloc[-1], m["lon"].iloc[-1])
    assert moved == pytest.approx(0.5 * 2 * 86400, rel=0.01)
    assert m["t"].iloc[-1] == T0 + timedelta(days=2)


def test_float_model_adds_stokes_drift_downwave():
    # Waves coming FROM the west push the float east, on top of zero current.
    env = ConstantEnvironment(EnvState(hs=2.0, tp=8.0, wave_dir=270.0))
    m = D.drift(env, T0, 36.0, -70.0, 1, "float")
    assert m["lon"].iloc[-1] > -70.0
    assert m["lat"].iloc[-1] == pytest.approx(36.0, abs=1e-3)
    still = D.drift(env, T0, 36.0, -70.0, 1, "water")
    assert still["lon"].iloc[-1] == pytest.approx(-70.0)


def test_kayak_model_drifts_downwind_without_hazards():
    design = load_design("configs/v4_kayak.yaml")
    kayak = D.kayak_for_drift(design)
    assert kayak.hazards.enabled is False
    env = ConstantEnvironment(EnvState(wind_u=10.0, ghi=0.0))
    m = D.drift(env, T0, 36.0, -70.0, 1, "kayak", vessel=kayak)
    east = distance_m(36.0, -70.0, 36.0, m["lon"].iloc[-1])
    # A small boat lying beam-on drifts at a few percent of wind speed.
    assert 0.005 * 10 * 86400 < east < 0.08 * 10 * 86400


def test_unknown_model_is_an_error():
    with pytest.raises(ValueError):
        D.drift(ConstantEnvironment(), T0, 36.0, -70.0, 1, "rubber duck")
    with pytest.raises(ValueError):
        D.drift(ConstantEnvironment(), T0, 36.0, -70.0, 1, "kayak")


def test_perfect_model_scores_one_and_still_model_matches_stay_put():
    real = _track(36.0, -70.0, 1.0, 0.3, 5)
    s = D.score(real, real, 5)
    assert s["skill"] == pytest.approx(1.0)
    assert s["sep_d5_km"] == pytest.approx(0.0, abs=1e-6)
    still = pd.DataFrame({"t": real["t"], "lat": 36.0, "lon": -70.0})
    s2 = D.score(real, still, 5)
    assert s2["sep_d5_km"] == pytest.approx(s2["stay_put_km"])
    assert s2["skill"] == pytest.approx(s2["stay_put_skill"])
    # Straight track: gaps equal the path length, so staying put scores 0.
    assert s2["stay_put_skill"] == pytest.approx(0.0, abs=1e-3)
    assert {k for k in s if k.startswith("sep_")} == {"sep_d1_km", "sep_d3_km", "sep_d5_km"}


def test_score_handles_mixed_time_resolutions():
    # pandas may store the real track in us and the model track in ns.
    real = _track(36.0, -70.0, 1.0, 0.0, 2)
    model = real.copy()
    real["t"] = real["t"].astype("datetime64[us]")
    model["t"] = model["t"].astype("datetime64[ns]")
    assert D.score(real, model, 2)["skill"] == pytest.approx(1.0)


def test_load_track_reads_only_its_rows_of_the_ragged_array():
    xr = pytest.importorskip("xarray")
    t = np.array([0, 3600, 7200, 0, 3600], dtype=float) + 1.6e9
    ds = xr.Dataset(
        {
            "id": ("traj", np.array([11, 22])),
            "rowsize": ("traj", np.array([3, 2], dtype=np.int32)),
            "time": ("obs", t),
            "lat": ("obs", np.array([30.0, 30.1, 30.2, 40.0, 40.1])),
            "lon": ("obs", np.array([290.0, 290.1, 290.2, 300.0, 300.1])),
            "drogue_status": ("obs", np.array([1, 1, 1, 0, 0], dtype=np.int8)),
        }
    )
    tr = D.load_track(22, ds)
    assert list(tr["lat"]) == [40.0, 40.1]
    assert tr["lon"].iloc[0] == pytest.approx(-60.0)  # 0..360 turned into -180..180
    assert not tr["drogued"].any()
    with pytest.raises(KeyError):
        D.load_track(33, ds)


def test_glorys_months_span_year_end():
    assert D.glorys_months(datetime(2019, 12, 25), 10) == ["2019-12", "2020-01"]


def test_report_judges_drogued_against_water_and_undrogued_against_float():
    rows = []
    for drifter, frac in ((1, 1.0), (2, 0.0)):
        for model, skill in (("water", 0.6), ("float", 0.4), ("kayak", 0.2)):
            rows.append(
                {
                    "drifter": drifter,
                    "note": f"case {drifter}",
                    "drogued_frac": frac,
                    "model": model,
                    "skill": skill,
                    "stay_put_skill": 0.1,
                    "path_km": 300.0,
                    "stay_put_km": 250.0,
                    "sep_d1_km": 10.0,
                    "sep_d3_km": 30.0,
                    "sep_d5_km": 50.0,
                    "sep_d10_km": 100.0,
                }
            )
    md = D.report_markdown(pd.DataFrame(rows), 10)
    assert "| 1 | case 1 | water | 0.60 |" in md
    assert "| 2 | case 2 | float | 0.40 |" in md
    assert "beat 'stay put' in 2 of 2" in md
    header, sep = [ln for ln in md.splitlines() if ln.startswith("|")][:2]
    assert header.count("|") == sep.count("|")
