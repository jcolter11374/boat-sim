import json

import numpy as np
import pytest

from boatsim.oceandata import ports as P
from boatsim.runner.land import LandMask

pytest.importorskip("scipy")


def _bay():
    """0.1 degree cells, 30-40N, 70-60W. Land west of 66W, with a narrow bay
    running 3 degrees west into it along 35N; its only mouth faces east."""
    m = np.zeros((100, 100), bool)
    m[:, :40] = True  # the coast at 66W
    m[50:52, 10:40] = False  # the bay, 0.2 degrees (22 km) wide, running 3 degrees inland
    return LandMask(m, 30.0, -70.0, 0.1)


def test_launch_point_follows_the_water_out_of_the_bay(monkeypatch):
    monkeypatch.setattr(P, "SEARCH_KM", 800.0)
    mask = _bay()
    ocean = P.open_ocean(mask, seed=(35.0, -62.0))
    la, lo, km = P.launch_point(mask, ocean, 35.0, -68.9, clear_km=20.0)
    # Out through the mouth at 66W into open water, not across the land: the path
    # is the bay's length (about 270 km), not a short hop to the sea nearby.
    assert lo > -66.0 and abs(la - 35.0) < 0.3
    assert km > 250


def test_launch_point_moves_out_until_its_route_clears_land():
    """A headland across the way to the finish: the nearest open water would send
    the launch route over it (Placentia Bay, #246), so the launch point moves out
    along the water until the straight route to the finish misses it."""
    m = np.zeros((100, 100), bool)
    m[:, :20] = True  # the coast at 68W
    m[40:52, 20:45] = True  # a headland east along 34-35.2N to 65.5W
    mask = LandMask(m, 30.0, -70.0, 0.1)
    ocean = P.open_ocean(mask, seed=(31.0, -61.0))
    target = (35.6, -60.0)  # east-north-east, past the headland
    plain = P.launch_point(mask, ocean, 33.5, -67.9, clear_km=20.0)
    near = P.land_km(mask)
    assert not P.route_clear(mask, near, plain[0], plain[1], target)  # straight over it

    def ok(la, lo):
        return P.route_clear(mask, near, la, lo, target)

    la, lo, km = P.launch_point(mask, ocean, 33.5, -67.9, clear_km=20.0, route_ok=ok)
    assert ok(la, lo) and km > plain[2]


def test_great_circle_points():
    la, lo = P.great_circle((36.65, -74.94), P.FINISH)
    assert (la[0], lo[0]) == pytest.approx((36.65, -74.94)) and (la[-1], lo[-1]) == pytest.approx(
        P.FINISH
    )
    assert la.max() > 41.5  # it bows north (peaks near 42.6N)
    step = np.hypot(np.diff(la), np.diff(lo) * np.cos(np.radians(la[1:]))) * P.KM_PER_DEG
    assert step.max() <= P.ROUTE_STEP_KM * 1.01


def test_no_launch_point_for_a_lake():
    m = np.zeros((100, 100), bool)
    m[:, :40] = True
    m[60:65, 10:15] = False  # a lake inland
    mask = LandMask(m, 30.0, -70.0, 0.1)
    assert P.launch_point(mask, P.open_ocean(mask, seed=(35.0, -62.0)), 36.2, -68.8) is None


def test_corridor_and_duplicates(tmp_path, monkeypatch):
    feats = [
        {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [-62.0, 35.0]},
            "properties": {"name": n},
        }
        for n in ("Sea Port", "Sea Port")
    ]
    g = tmp_path / "p.geojson"
    g.write_text(json.dumps({"features": feats}))
    monkeypatch.setattr(P, "OCEAN_SEED", (35.0, -61.0))
    ports = P.build(g, _bay(), log=lambda *_: None)
    assert len(ports) == 1 and ports[0].in_corridor
    assert not P.in_corridor(49.0, -5.0) and P.in_corridor(36.6, -74.9)
    assert not P.in_corridor(49.5, -60.0)  # inside the bundles, but on their last weather cell
    assert not P.in_corridor(47.8, -52.5)  # off St John's: drifts north out of the weather
    assert P.route_inside(36.65, -74.94) and not P.route_inside(
        36.65, -74.94, box=(28, 40, -78, -8)
    )


def test_finish_is_the_race_target():
    from boatsim.runner.arrival import DEFAULT_TARGET

    assert P.FINISH == tuple(DEFAULT_TARGET)


def test_start_line_and_ids():
    assert P.crosses_start(36.65, -74.94)  # our drop, off the Bay mouth
    assert not P.crosses_start(38.51, -9.45)  # off Lisbon: east of the start line
    assert not P.crosses_start(37.57, -25.67)  # off the Azores
    assert P.slug("Saint-John's") == "saint-john-s" and P.slug("A Coruña") == "a-coruna"


def test_published_list():
    d = json.loads((P.Path(__file__).resolve().parents[1] / "sea3d/public/ports.json").read_text())
    names = {p["name"] for p in d["ports"]}
    assert {"Norfolk", "Baltimore", "Lisboa", "Horta"} <= names
    assert len({p["id"] for p in d["ports"]}) == len(d["ports"])
    for p in d["ports"]:
        inside = P.in_corridor(p["launch_lat"], p["launch_lon"])
        assert (inside and P.route_inside(p["launch_lat"], p["launch_lon"])) == p["in_corridor"]
        assert P.crosses_start(p["launch_lat"], p["launch_lon"]) == p["crosses_start"]
        assert 0 <= p["launch_km"] <= P.SEARCH_KM + 50


def test_published_launch_routes_clear_land():
    d = json.loads((P.Path(__file__).resolve().parents[1] / "sea3d/public/ports.json").read_text())
    mask = LandMask.load()
    near = P.land_km(mask)
    for p in d["ports"]:
        assert P.route_clear(mask, near, p["launch_lat"], p["launch_lon"]), p["id"]
