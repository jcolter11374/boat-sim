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


def test_published_list():
    d = json.loads((P.Path(__file__).resolve().parents[1] / "sea3d/public/ports.json").read_text())
    names = {p["name"] for p in d["ports"]}
    assert {"Norfolk", "Baltimore", "Lisboa", "Horta"} <= names
    for p in d["ports"]:
        assert P.in_corridor(p["launch_lat"], p["launch_lon"]) == p["in_corridor"]
        assert 0 <= p["launch_km"] <= P.SEARCH_KM + 50
