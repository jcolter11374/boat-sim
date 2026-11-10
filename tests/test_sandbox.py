"""Boatyard sandbox (boatsim.sandbox): the forcing bundle, the catalog mapping,
the odds grid, and a voyage run the way the browser runs it."""

import io
import json
import subprocess
import sys
import zipfile
from datetime import date, datetime, timedelta
from types import SimpleNamespace

import numpy as np
import pytest

from boatsim.config import load_design
from boatsim.mc import boatyard as Y
from boatsim.mc.months import launches as year_launches
from boatsim.oceandata.grid import GridSeries
from boatsim.sandbox import __main__ as M
from boatsim.sandbox import catalog as C
from boatsim.sandbox import forcing as F
from boatsim.sandbox import run as R

# --- Catalog -------------------------------------------------------------------


def test_the_default_build_is_the_kayak_file_untouched():
    assert C.design_changes(None) == ()
    assert C.design_changes({"cruise_w": 25}) == ()
    assert C.design_for({}) == load_design(C.KAYAK)
    # Options the simulator doesn't model change nothing either, and share the id.
    nothing = {"radar": "davis-echomaster", "lead": "lead-50-scrap", "spares": "none"}
    assert C.design_changes(nothing) == ()
    assert C.grid_id(nothing) == "k-p25"


def test_options_set_the_fields_they_say():
    d = C.design_for(
        {"thr": "one-t200", "sol": "solar-300", "bat": "one-50ah", "brain": "one-box",
         "beacon": "none", "ais": "none", "paint": "none", "cruise_w": 15}
    )  # fmt: skip
    assert d.propulsion["thruster_count"] == 1 and d.propulsion["max_drive_w"] == 50
    assert d.propulsion["cruise_drive_w"] == 15
    assert d.power["solar_wp"] == 300 and d.power["battery_wh"] == 640
    assert d.hazards["electronics_boxes"] == 1
    assert d.comms["beacon"] is False
    assert d.hazards["p_avoid_with_ais"] == d.hazards["p_avoid_without_ais"]
    assert d.hull["fouling_frac_per_day"] == 2 * load_design(C.KAYAK).hull["fouling_frac_per_day"]
    # Hotel load: 85 Wh/day less the default autopilot and AIS, plus the chosen ones.
    assert d.electronics["hotel_load_wh_per_day"] == 85 - 31 + 27 - 36 + 0


def test_every_slot_has_its_default_and_a_badge():
    assert set(C.SLOTS) == set(C.DEFAULTS) == set(C.SLOT_NAMES)
    for slot, opts in C.SLOTS.items():
        assert C.DEFAULTS[slot] in opts
        for o in opts.values():
            assert o.effect in ("wired", "no effect yet", "fixed") and o.basis
    e = C.effects({"radar": "davis-echomaster"})
    assert e["radar"] == {
        "option": "davis-echomaster", "effect": "no effect yet", "est": False,
        "basis": "how often ships see us doesn't depend on it yet",
    }  # fmt: skip
    with pytest.raises(ValueError, match="unknown option"):
        C.normalise({"thr": "three-t200"})
    with pytest.raises(ValueError, match="unknown slot"):
        C.normalise({"sails": "big"})


def test_odds_grid_is_twenty_catalog_builds_and_nearest_finds_them():
    ids = [C.grid_id(g) for g in C.GRID]
    assert len(set(ids)) == len(ids) == 19
    assert len(Y.BUILDS) == 21 and Y.CURRENT in Y.BUILDS
    for g in C.GRID:
        assert C.nearest(g) == (C.grid_id(g), True)
    assert C.nearest({"ais": "none", "cruise_w": 20}) in (
        ("k-p25-ais.none", False),
        ("k-p20", False),
    )
    assert C.nearest({"cruise_w": 28}) == ("k-p30", False)
    # The grid's builds run exactly the sandbox's designs.
    b = Y.BUILDS["k-p25-thr.one-t200"]
    assert b.variant.design == C.design_changes({"thr": "one-t200"})


# --- Forcing bundle --------------------------------------------------------------


def _fake_sources():
    """ERA5 day tiles at 0.5 deg (hourly, 25 stamps), GLORYS month tiles at 1/12
    deg (daily at noon) and a ship map, with values that vary by place and time."""
    lats, lons = np.arange(27.0, 51.01, 0.5), np.arange(-79.0, -6.99, 0.5)

    def day_tile(day):
        t = np.datetime64(day) + np.arange(25) * np.timedelta64(1, "h")
        hh = np.arange(25, dtype=np.float32)[:, None, None]
        base = np.ones((25, len(lats), len(lons)), np.float32)
        f = {
            "wind_u": base * (lons[None, None, :] + 80) / 10,
            "wind_v": base * -2.0,
            "hs": base * (lats[None, :, None] - 26) / 10,
            "tp": base * 8.0,
            "wave_dir": base * 350.0,
            "cloud_fraction": base * 0.5,
            "air_temp": base * 20.0 + hh / 24,
            "ghi": base * 300.0,
        }
        return GridSeries(t, lats, lons, f)

    glats, glons = np.arange(27.0, 51.0, 1 / 12), np.arange(-79.0, -7.0, 1 / 12)

    def month_tile(key):
        y, m = key
        d0 = date(y, m, 1) - timedelta(days=1)
        t = np.datetime64(d0) + np.timedelta64(12, "h") + np.arange(33) * np.timedelta64(1, "D")
        u = np.ones((33, len(glats), len(glons)), np.float32) * 0.25
        return GridSeries(t, glats, glons, {"current_u": u, "current_v": -u})

    era5 = SimpleNamespace(_tiles=SimpleNamespace(get=day_tile))
    glorys = SimpleNamespace(_tiles=SimpleNamespace(get=month_tile))
    s = np.full((1, 3, 3), 1e-4, np.float32)
    ships = SimpleNamespace(
        _g=GridSeries(np.array(["2000-01-01"], "datetime64[s]"), np.array([25.0, 40, 60]),
                      np.array([-82.0, -40, 5]), {"ship_density": s})
    )  # fmt: skip
    return era5, glorys, ships


@pytest.fixture(scope="module")
def bundle():
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2020, buf, era5, glorys, ships, log=lambda *_: None, first=(5, 1), last=(5, 4))
    return buf.getvalue()


def test_bundle_round_trips_through_the_quantised_store(bundle):
    env = F.BundleEnvironment(bundle)
    assert env.meta == {"year": 2020, "first": "2020-05-01", "last": "2020-05-04"}
    assert env.weather.lats[0] == 28 and env.weather.lats[-1] == 50
    assert env.weather.lons[1] - env.weather.lons[0] == 1.0  # 1 deg
    assert env.currents.lats[1] - env.currents.lats[0] == pytest.approx(0.25)
    e = env.sample(datetime(2020, 5, 2, 15), 36.65, -74.94)
    assert e.wind_u == pytest.approx((-74.94 + 80) / 10, abs=0.06)
    assert e.wind_v == pytest.approx(-2.0) and e.tp == pytest.approx(8.0)
    assert e.hs == pytest.approx((36.65 - 26) / 10, abs=0.02)
    assert e.wave_dir == pytest.approx(350.0, abs=0.01)
    assert e.cloud_fraction == pytest.approx(0.5, abs=0.02)
    assert e.current_u == pytest.approx(0.25) and e.current_v == pytest.approx(-0.25)
    assert e.ship_density == pytest.approx(1e-4)
    # Sunlight: the day's clearness (300 W/m^2 every hour, over the clear-sky sum)
    # times clear sky now; zero at night.
    assert e.ghi > 0
    assert env.sample(datetime(2020, 5, 2, 4), 36.65, -74.94).ghi == 0.0


def test_clear_sky_grid_matches_the_point_formula_and_is_dark_at_night():
    t = np.datetime64("2020-06-21T16:30")
    lats, lons = np.array([30.0, 45.0]), np.array([-70.0, -20.0])
    g = F.clear_sky_grid(t, lats, lons)
    for i, a in enumerate(lats):
        for j, b in enumerate(lons):
            assert g[i, j] == pytest.approx(F.clear_sky(t, a, b), abs=1e-9)
    assert 800 < F.clear_sky(np.datetime64("2020-06-21T16:30"), 39.0, -75.0) < 1100  # local noon
    assert F.clear_sky(np.datetime64("2020-06-21T05:00"), 39.0, -75.0) == 0.0  # 1 am local


# --- Voyages ---------------------------------------------------------------------


def test_launches_use_the_voyage_replays_seeds():
    every = year_launches(2020)
    got = R.launches(2020)
    assert len(got) == 6
    for start, seed in got:
        assert start.month in (4, 5, 6) and seed == 2020 * 1000 + every.index(start)
    assert got[0] == (datetime(2020, 4, 1, 12), 2020006)


def test_a_sandbox_voyage_runs_and_gives_a_slim_replay(bundle):
    env = R.open_bundle(bundle)
    out = R.run_voyage({"brain": "one-box"}, env, datetime(2020, 5, 1, 12), 7, max_days=1.0)
    res, rep = out["result"], out["replay"]
    assert res["outcome"] in ("timeout", "lost") and res["start"] == "2020-05-01T12:00"
    assert rep["build"] == "k-p25-brain.one-box" and rep["stride_h"] == 6
    assert "ghi" not in rep and len(rep["h"]) <= 6
    json.dumps(out)  # what the worker hands the page


def test_sandbox_runs_without_pandas_xarray_or_process_pools(bundle, tmp_path):
    """The browser has none of these: block them and run a voyage."""
    p = tmp_path / "b.npz"
    p.write_bytes(bundle)
    code = f"""
import sys
for m in ("pandas", "xarray", "multiprocessing", "concurrent.futures.process", "netCDF4", "zarr"):
    sys.modules[m] = None
from datetime import datetime
from boatsim.sandbox.run import open_bundle, run_voyage
r = run_voyage({{}}, open_bundle({str(p)!r}), datetime(2020, 5, 1, 12), 3, max_days=0.5)
print(r["result"]["outcome"])
"""
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert r.returncode == 0, r.stderr[-2000:]


def test_pack_has_the_simulator_and_the_files_a_voyage_reads(tmp_path):
    n = M.pack(tmp_path / "boatsim.zip")
    names = set(zipfile.ZipFile(tmp_path / "boatsim.zip").namelist())
    assert n == len(names)
    assert {"boatsim/sandbox/run.py", "boatsim/runner/simulate.py", *M.PACK_FILES} <= names
    assert not any("__pycache__" in x for x in names)


def test_compare_checks_outcome_days_events_across_runtimes_and_everything_exactly():
    a = [{"build": "k-p25", "start": "s", "outcome": "arrived", "days": 70.0, "events": 3,
          "end_lat": "39.5", "runtime": "python"}]  # fmt: skip
    b = [{**a[0], "end_lat": "39.50000001", "runtime": "pyodide"}]
    assert M.compare(a, b) == []
    assert M.compare(a, b, exact=True) == ["('k-p25', 's') end_lat: '39.5' vs '39.50000001'"]
    assert M.compare(a, [{**b[0], "days": 71.0}]) != []
    assert M.compare(a, []) == ["missing from the second run: ('k-p25', 's')"]


def test_slot_table_lists_every_option_with_its_effect():
    t = C.slot_table()
    assert [s["id"] for s in t] == list(C.SLOTS)
    ais = {o["id"]: o for o in next(s for s in t if s["id"] == "ais")["opts"]}
    assert ais["none"]["sim"] == [
        "hazards.p_avoid_with_ais", "electronics.hotel_load_wh_per_day", "hull.mass_kg",
    ]  # fmt: skip
    assert ais["none"]["kg"] == -1.2
    json.dumps(t)


def test_weight_from_the_catalog_reaches_the_hull():
    base = load_design(C.KAYAK)
    heavy = C.design_for({"bat": "two-100ah"})
    assert heavy.hull["mass_kg"] == base.hull["mass_kg"] + 10
    light = C.design_for({"lead": "lead-40", "ais": "none"})
    assert light.hull["mass_kg"] == base.hull["mass_kg"] - 11.2
    assert light.hazards["p_inverted_stuck"] > base.hazards["p_inverted_stuck"]
    assert C.matters("mppt", "one-mppt") and not C.matters("lead", "lead-50-scrap")
