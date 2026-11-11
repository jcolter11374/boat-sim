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
