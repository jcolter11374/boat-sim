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


def test_odds_grid_is_the_catalog_builds_and_nearest_finds_them():
    ids = [C.grid_id(g) for g in C.GRID]
    assert len(set(ids)) == len(ids) == 40
    assert len(Y.BUILDS) == 43 and Y.CURRENT in Y.BUILDS
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
            "rain": base * hh / 10,  # mm/h over the hour ending at each stamp
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


def test_diverge_finds_where_two_tracks_part_and_the_events_around_it():
    def row(outcome, lat2, ev):
        return {"build": "k-p25", "start": "s", "outcome": outcome, "days": 1.0, "events": 1,
                "track": {"h": [0.0, 6.0, 12.0], "lat": [36.0, 36.1, lat2],
                          "lon": [-74.0, -73.9, -73.8], "events": ev}}  # fmt: skip

    a = [row("arrived", 36.2, [[11.0, "capsize", "1 knockdown(s)"]])]
    b = [row("lost", 36.5, [])]
    (line,) = M.diverge(a, b)
    assert "hour 12" in line and "capsize" in line
    assert M.diverge(a, a) == []


def test_forecast_key_ignores_local_timezone():
    """A browser's Pyodide runs in the visitor's timezone; forecasts must not care."""
    import os
    import time
    from datetime import UTC, datetime

    from boatsim.oceandata.forecast import IssuedForecast

    if not hasattr(time, "tzset"):
        return
    t = datetime(2020, 4, 1, 12)
    want = int(t.replace(tzinfo=UTC).timestamp() // 60)
    old = os.environ.get("TZ")
    try:
        os.environ["TZ"] = "America/New_York"
        time.tzset()
        seen = {}

        class Grab:
            def __init__(self, model, rng):
                seen["state"] = rng.bit_generator.state

        import boatsim.oceandata.forecast as F

        real, F._Patterns = F._Patterns, Grab
        try:
            IssuedForecast(None, t, None, 7)
        finally:
            F._Patterns = real
        import numpy as np

        assert seen["state"] == np.random.default_rng([7, want]).bit_generator.state
    finally:
        if old is None:
            os.environ.pop("TZ", None)
        else:
            os.environ["TZ"] = old
        time.tzset()


def test_drive_and_material_options():
    base = load_design(C.KAYAK)
    hy = C.design_for({"drive": "hybrid"})
    assert hy.sail["area_m2"] == C.KAYAK_WING["area_m2"]
    assert hy.propulsion["thruster_count"] == 2
    assert hy.hazards["p_part"] == {**base.hazards["p_part"], "sail": C.WING_P_BREAK}
    assert hy.hull["mass_kg"] == base.hull["mass_kg"] + C.WING_KG
    hotel = base.electronics["hotel_load_wh_per_day"]
    assert hy.electronics["hotel_load_wh_per_day"] == hotel + C.WING_WH
    # Wing only: no thrusters, and the thruster and power choices don't apply.
    w = C.design_for({"drive": "wing-sail", "thr": "one-t200", "cruise_w": 15})
    assert w.propulsion["thruster_count"] == 0 and w.propulsion["cruise_drive_w"] == 0
    assert C.grid_id({"drive": "wing-sail", "thr": "one-t200"}) == "k-p0-drive.wing-sail"
    assert w.hull["mass_kg"] == round(base.hull["mass_kg"] + C.WING_KG - 2 * C.T200_KG, 3)
    carbon = C.design_for({"material": "carbon"})
    assert carbon.hull["mass_kg"] < base.hull["mass_kg"]
    assert carbon.hazards["leak_per_day"] > C.LEAK
    alu = C.design_for({"material": "aluminium"})
    assert alu.hull["fouling_frac_per_day"] > base.hull["fouling_frac_per_day"]
    for slot in ("drive", "material"):
        assert C.SLOTS[slot][C.DEFAULTS[slot]].changes == ()


def test_hybrid_motors_straight_upwind_where_the_wing_only_boat_tacks():
    from boatsim.types import Command, EnvState
    from boatsim.vessel import KayakVessel

    env = EnvState(wind_v=-7.0, hs=1.0, tp=6.0, wave_dir=0.0, ghi=300.0)  # northerly
    t = datetime(2020, 5, 1)
    rng = np.random.default_rng(0)
    step = timedelta(minutes=10)
    hy = KayakVessel(C.design_for({"drive": "hybrid"}))
    s, _ = hy.step(hy.initial_state(t, 38.0, -70.0), Command(0.0, 0.25), env, step, rng)
    assert s.heading == 0.0 and s.drive_w > 0  # straight into the wind on the motors
    # Reaching, the wing adds drive: faster than the kayak at the same power.
    kayak = KayakVessel(load_design(C.KAYAK))
    a, _ = hy.step(hy.initial_state(t, 38.0, -70.0), Command(90.0, 0.25), env, step, rng)
    b, _ = kayak.step(kayak.initial_state(t, 38.0, -70.0), Command(90.0, 0.25), env, step, rng)
    assert a.speed_through_water > b.speed_through_water + 0.1
    wing = KayakVessel(C.design_for({"drive": "wing-sail"}))
    s, _ = wing.step(wing.initial_state(t, 38.0, -70.0), Command(0.0, 0.0), env, step, rng)
    assert abs(abs(((s.heading + 180) % 360) - 180) - 50.0) < 1e-9  # tacks at 50 deg


def test_sandbox_workflow_builds_are_grid_ids():
    """The workflow's reference builds must be real grid ids (an id goes stale
    when an option starts to matter, as the charge controllers did)."""
    import re
    from pathlib import Path

    text = Path(".github/workflows/sandbox.yml").read_text()
    ids = {C.grid_id(g) for g in C.GRID}
    found = re.findall(r"\bk-p\d+[\w.\-]*", text)
    assert found
    for bid in found:
        assert bid in ids, bid


def test_hull_shapes_carry_their_own_weight_and_quirks():
    base = load_design(C.KAYAK)
    for s, kg in (("cat", 140.0), ("semisub", 175.0), ("board", 105.0)):
        d = C.design_for({"shape": s})
        # each shape's drag numbers are for its own weight: no mass-link change
        assert d.hull["mass_kg"] == d.hull["displacement_ref_kg"] == kg
        # other options' weight still goes through the mass link
        assert C.design_for({"shape": s, "bat": "two-100ah"}).hull["mass_kg"] == kg + 10
    cat = C.design_for({"shape": "cat"})
    assert cat.propulsion["rudder"] is False and cat.hazards["p_capsize_stays_over"] > 0
    assert cat.hazards["p_part"]["ais_whip"] == base.hazards["p_part"]["ais_whip"]
    semi = C.design_for({"shape": "semisub"})
    assert semi.power["mounting_mismatch"] == round(base.power["mounting_mismatch"] * 0.6, 3)


def test_a_rudderless_cat_needs_both_thrusters_and_stays_over_when_rolled():
    from boatsim.types import Command, EnvState
    from boatsim.vessel import KayakVessel
    from boatsim.vessel.hazards import K_DICE, SLOT, HazardParams, sample_hazards

    v = KayakVessel(C.design_for({"shape": "cat"}))
    t = datetime(2020, 5, 1)
    s0 = v.initial_state(t, 38.0, -70.0)
    assert s0.damage.get("rudder")  # no rudder fitted
    env = EnvState(wind_v=-7.0, hs=1.0, tp=6.0, wave_dir=0.0, ghi=300.0)
    rng = np.random.default_rng(0)
    step = timedelta(minutes=10)
    s, _ = v.step(s0, Command(90.0, 0.25), env, step, rng)
    assert s.heading == 90.0  # steers on differential thrust
    one = v.initial_state(t, 38.0, -70.0)
    one.damage["thruster_starboard"] = True
    s, _ = v.step(one, Command(90.0, 0.25), env, step, rng)
    assert s.heading != 90.0  # one thruster, no rudder: it can't steer
    # a knockdown that a self-righting boat shrugs off ends the cat half the time
    p = HazardParams.from_config(C.design_for({"shape": "cat"}).hazards)
    dice = np.full(K_DICE, 0.99)
    dice[SLOT["knockdown_count"]] = 0.999999  # at least one knockdown
    dice[SLOT["knockdown_inverted"]] = 0.4
    storm = EnvState(wind_u=25.0, hs=6.0, tp=10.0)
    out = sample_hazards(p, storm, 1.0, {}, t, dice)
    assert out.lost and "not self-righting" in out.events[-1].detail
    kayak = HazardParams.from_config(load_design(C.KAYAK).hazards)
    assert not sample_hazards(kayak, storm, 1.0, {}, t, dice).lost


def test_randolph_bases_start_from_their_own_yaml():
    for b, path in (
        ("revc", "configs/randolph_rev_c.yaml"),
        ("revb", "configs/randolph_rev_b.yaml"),
    ):
        assert C.design_changes({"base": b}) == ()
        assert C.grid_id({"base": b}) == b
        # The page always sends a cruise power; a sailboat ignores it.
        assert C.grid_id({"base": b, "cruise_w": 25, "paint": "none"}) == b
        assert C.nearest({"base": b, "keel": "bulb-8kg" if b == "revc" else "bulb-9kg"}) == (
            b,
            False,
        )
        d = C.design_for(
            {"base": b, "drive": "wing-thruster", "brain": "two-box", "tracker": "none"}
        )
        base = load_design(path)
        assert d.propulsion["thruster_count"] == 1 and d.propulsion["cruise_drive_w"] == 5
        assert d.hazards["electronics_boxes"] == 2 and d.comms["beacon"] is False
        assert (
            d.electronics["hotel_load_wh_per_day"] == base.electronics["hotel_load_wh_per_day"] + 5
        )
        assert d.hull["mass_kg"] == round(base.hull["mass_kg"] + 0.6 + 0.3 - 0.3, 3)
    # Rev C on Rev B's single rudder takes Rev B's steering rate and rudder areas.
    one = C.design_for({"base": "revc", "rudder": "single"})
    assert one.hazards["steering_per_day"] == 0.004
    assert one.hull["lateral_cd_area_m2"] == 0.19
    with pytest.raises(ValueError, match="for base 'revc'"):
        C.normalise({"base": "revc", "thr": "one-t200"})
    with pytest.raises(ValueError, match="unknown base"):
        C.normalise({"base": "raft"})
    t = C.base_table()
    assert {s["id"] for s in t["revc"]["slots"]} == {
        "drive",
        "brain",
        "rudder",
        "rsol",
        "rbat",
        "keel",
        "tracker",
        "sat",
        "light",
        "paint",
        "spares",
    }
    assert all(
        t[b]["defaults"][s["id"]] in {o["id"] for o in s["opts"]} for b in t for s in t[b]["slots"]
    )


def test_cut_takes_a_window_across_new_year():
    """Weather challenges run into the next year (winter-train: Dec 2013 - May 2014)."""
    era5, glorys, ships = _fake_sources()
    buf = io.BytesIO()
    F.cut(2013, buf, era5, glorys, ships, log=lambda *_: None,
          start=date(2013, 12, 30), end=date(2014, 1, 2))  # fmt: skip
    env = F.BundleEnvironment(buf.getvalue())
    assert env.meta == {"year": 2013, "first": "2013-12-30", "last": "2014-01-02"}
    assert len(env.weather.times) == 4 * 4 and len(env.currents.times) == 4
    s = env.sample(datetime(2014, 1, 1, 12), 40.0, -60.0)
    assert s.wind_v == pytest.approx(-2.0, abs=0.1)


def test_bundle_carries_hourly_rain_like_the_full_runs(bundle):
    """Rain stays hourly (squalls), sampled half an hour on as ERA5Source does."""
    env = F.BundleEnvironment(bundle)
    assert len(env.rain.times) == 4 * 24  # 1-4 May, every hour
    assert env.sample(datetime(2020, 5, 2, 10), 40.0, -60.0).rain == pytest.approx(1.05, abs=0.01)
    assert env.sample(datetime(2020, 5, 2, 23, 30), 40.0, -60.0).rain == pytest.approx(
        2.4, abs=0.01
    )


def test_a_bundle_without_rain_reads_dry(bundle):
    z = dict(np.load(io.BytesIO(bundle)))
    del z["rain"], z["t_rain"]
    buf = io.BytesIO()
    np.savez_compressed(buf, **z)
    assert (
        F.BundleEnvironment(buf.getvalue()).sample(datetime(2020, 5, 2, 10), 40.0, -60.0).rain
        == 0.0
    )
