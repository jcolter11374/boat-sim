import json
from datetime import date

from boatsim.oceandata import challenges as C


def test_challenges_are_unique_and_windows_cover_150_days():
    ids = [c.id for c in C.CHALLENGES]
    assert len(set(ids)) == len(ids)
    assert len({c.seed for c in C.CHALLENGES}) == len(ids)
    for c in C.CHALLENGES:
        a, b = c.window()
        assert a < c.start and (b - c.start).days >= 150
        assert c.story and len(c.story) < 300


def test_season_challenges_use_the_boatyard_bundle_and_fit_its_season():
    for c in C.CHALLENGES:
        if c.season:
            assert c.bundle == "forcing_2020.npz" and c.start.year == 2020
            assert date(2020, 4, 1) <= c.start <= date(2020, 6, 15)
        else:
            assert c.bundle == f"challenge_{c.id}.npz"


def test_matrix_lists_only_own_bundles_with_fetch_months(capsys):
    m = C.matrix()
    assert {x["id"] for x in m} == {c.id for c in C.CHALLENGES if not c.season}
    w = next(x for x in m if x["id"] == "winter-train")
    assert (w["first"], w["last"], w["months"]) == (
        "2013-11-30",
        "2014-05-05",
        ["2013-11", "2014-05"],
    )
    C.main(["matrix"])
    assert json.loads(capsys.readouterr().out) == m


def test_catalog_records_start_at_noon_and_hurricane_flags(tmp_path):
    C.main(["catalog", "--out", str(tmp_path / "c.json")])
    cat = json.loads((tmp_path / "c.json").read_text())
    recs = {r["id"]: r for r in cat["challenges"]}
    assert recs["sandys-shadow"]["start"] == "2012-10-22T12:00:00Z"
    assert recs["sandys-shadow"]["hurricane"] and not recs["winter-train"]["hurricane"]
    assert recs["gentle-june"]["bundle"] == "forcing_2020.npz"
