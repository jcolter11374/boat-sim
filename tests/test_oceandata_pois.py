import json
from urllib.parse import urlparse

from boatsim.oceandata import pois


def test_published_json_is_up_to_date():
    """sea3d/public/pois.json is generated: run python -m boatsim.oceandata.pois."""
    assert pois.OUT.read_text(encoding="utf-8") == pois.dumps()


def test_every_point_is_sourced_and_on_our_side_of_the_ocean():
    ids = [p.id for p in pois.POIS]
    assert len(ids) == len(set(ids))
    for p in pois.POIS:
        assert p.kind in pois.KINDS, p.id
        assert urlparse(p.url).scheme == "https" and p.source, p.id
        assert p.at and 0 < p.radius_km <= 500, p.id
        for lat, lon in p.at:
            assert 25 < lat < 50 and -80 < lon < -5, p.id  # the route's corridor
        # Short enough for a card, and plain text for textContent.
        assert 80 < len(p.text) < 500 and "<" not in p.text, p.id
    assert {p.kind for p in pois.POIS} == set(pois.KINDS)


def test_catalog_round_trips():
    d = json.loads(pois.dumps())
    assert [p["id"] for p in d["pois"]] == [p.id for p in pois.POIS]
    assert d["pois"][0]["at"] == [list(x) for x in pois.POIS[0].at]


def test_every_port_in_the_picker_starts_with_a_card():
    """Take the helm's "Start from" ports (oceandata/ports.py): a card near each
    launch point, so every start has something to read on day 0."""
    import math

    from boatsim.oceandata import ports

    def km(a, b):
        dy = (a[0] - b[0]) * 111.2
        dx = (a[1] - b[1]) * 111.2 * math.cos(math.radians(a[0]))
        return math.hypot(dx, dy)

    for p in ports.load().values():
        if not (p["in_corridor"] and p["crosses_start"]):
            continue
        at = (p["launch_lat"], p["launch_lon"])
        assert any(km(at, q) <= poi.radius_km for poi in pois.POIS for q in poi.at), p["id"]
