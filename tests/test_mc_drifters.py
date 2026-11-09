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


def test_shared_cases_start_in_the_shared_stretch():
    import re

    assert len(D.SHARED_CASES) == 20
    assert len({c.drifter_id for c in D.SHARED_CASES}) == 20
    for c in D.SHARED_CASES:
        lat, lon = map(float, re.search(r"\(([\d.]+)N ([\d.]+)W\)", c.note).groups())
        assert 36 <= lat <= 42 and 50 <= lon <= 75
    assert set(D.CASE_SETS) == {"hatteras", "shared", "smoc"}


def test_smoc_cases_are_in_the_smoc_era():
    import re
    from datetime import datetime

    assert len(D.SMOC_CASES) == 40
    keys = {(c.drifter_id, c.start) for c in D.SMOC_CASES}
    assert len(keys) == 40
    for c in D.SMOC_CASES:
        assert datetime.fromisoformat(c.start) >= datetime(2020, 11, 2)  # SMOC starts 1 Nov 2020
        lat, lon = map(float, re.search(r"\(([\d.]+)N ([\d.]+)W\)", c.note).groups())
        assert 36 <= lat <= 42 and 50 <= lon <= 75
    drogued = [c for c in D.SMOC_CASES if c.note.endswith(", drogued")]
    assert len(drogued) == 21
    # The two shared cases SMOC covers are in
    ids = {c.drifter_id for c in D.SMOC_CASES}
    assert {300534061551770, 300534061650930} <= ids


def test_load_track_can_start_mid_track():
    import numpy as np
    import xarray as xr

    t = np.arange(0, 5 * 86400, 3600, dtype=np.int64) + 1_600_000_000
    ds = xr.Dataset(
        {
            "id": ("traj", [7]),
            "rowsize": ("traj", [len(t)]),
            "time": ("obs", t),
            "lat": ("obs", np.full(len(t), 37.0)),
            "lon": ("obs", np.full(len(t), -60.0)),
            "drogue_status": ("obs", np.ones(len(t), bool)),
        }
    )
    full = D.load_track(7, ds)
    later = D.load_track(7, ds, days=1, start="2020-09-15")
    assert later["t"].iloc[0] >= pd.Timestamp("2020-09-15")
    assert len(later) < len(full) and later["t"].iloc[-1] - later["t"].iloc[0] <= pd.Timedelta(
        days=1
    )


def test_compare_markdown_pairs_the_two_sources():
    def rows(skill, gap, model):
        out = []
        for i, frac in enumerate((1.0, 0.0)):
            out.append(
                {
                    "drifter": f"d{i}",
                    "note": f"Nov 2020, {'west' if i else 'east'} band (37.0N 60.0W), x",
                    "drogued_frac": frac,
                    "model": model if model != "fair" else ("water" if frac >= 0.5 else "float"),
                    "skill": skill,
                    "stay_put_skill": 0.1,
                    "stay_put_km": 50.0,
                    **{f"sep_d{k}_km": gap for k in (1, 3, 5, 10)},
                }
            )
        return pd.DataFrame(out)

    md = D.compare_markdown(rows(0.6, 100.0, "fair"), rows(0.4, 150.0, "water"), 10)
    assert "| All | 2 | 0.60 | 0.40 | 100 | 150 | 2 / 2 | 0 of 2 |" in md
    assert "| Drogued | 1 |" in md and "| Undrogued | 1 |" in md


class _Currents:
    """Land (NaN) east of 69.9 W, sea west of it."""

    def sample(self, t, lat, lon):
        nan = float("nan")
        return {"current_u": nan if lon > -69.9 else 0.0, "current_v": 0.0}


def test_dead_boat_stops_at_first_land():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState(current_u=0.5))  # drifts east into "land"
    track, s = D.dead_boat(env, _Currents(), design, T0, 36.0, -70.0, days=5)
    assert s["aground"]
    assert s["end_lon"] > -69.9 and track["lon"].iloc[-2] <= -69.9
    assert 0.1 < s["days"] < 1.0  # ~9 km at 0.5 m/s plus wind/waves: a few hours
    assert s["path_km"] == pytest.approx(s["km_from_start"], rel=0.05)
    assert "first reached land" in D.dead_boat_markdown(s)


def test_dead_boat_at_sea_runs_the_full_time():
    design = load_design("configs/v4_kayak.yaml")
    env = ConstantEnvironment(EnvState())
    _, s = D.dead_boat(env, _Currents(), design, T0, 36.0, -75.0, days=1)
    assert not s["aground"] and s["days"] == pytest.approx(1.0)
    assert "still at sea" in D.dead_boat_markdown(s)


def test_stokes_split_markdown():
    def t(model, skill):
        return pd.DataFrame(
            [{"drifter": "u1", "model": model, "skill": skill, "sep_d10_km": 100 / skill}]
        )

    md = D.stokes_split_markdown(t("float", 0.6), t("water", 0.5), t("float", 0.7), 10)
    assert "| SMOC daily + ERA5 Stokes | 0.70 | 143 | 1 of 1 |" in md
    assert "| SMOC hourly total (its own Stokes and tides) | 0.50 | 200 | 0 of 1 |" in md
