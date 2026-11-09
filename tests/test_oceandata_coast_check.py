"""Bay-mouth land-mask check (#11) on a small fake mask."""

import numpy as np
import pytest

from boatsim.oceandata import coast_check as K
from boatsim.runner.land import DEFAULT_PATH, LandMask


def test_reachable_follows_diagonals_but_not_through_land():
    water = np.array(
        [
            [1, 0, 0, 1],
            [0, 1, 0, 1],
            [0, 0, 0, 1],
        ],
        dtype=bool,
    )
    r = K.reachable(water, (0, 0))
    assert r[1, 1] and not r[0, 3]  # diagonal step ok; the right column is cut off
    assert not K.reachable(water, (0, 1)).any()  # starting on land reaches nothing


def test_committed_mask_keeps_the_bay_mouth_open():
    if not DEFAULT_PATH.exists():
        pytest.skip("land mask not in this checkout")
    sub, lats, lons = K.region_slice(LandMask.load())
    rows = K.check_points(sub, lats, lons)
    assert all(r["ok"] for r in rows), [r["name"] for r in rows if not r["ok"]]
    assert all(r["reachable_from_drop"] for r in rows if r["want"] == "water")


def test_compare_counts_disagreeing_cells():
    shapely = pytest.importorskip("shapely")
    lats = np.array([36.51, 36.53])
    lons = np.array([-76.59, -76.57, -76.55])
    land = shapely.box(-76.60, 36.50, -76.58, 36.54)  # the west column only
    frac = K.land_fraction(land, lats, lons, 0.02)
    assert frac[:, 0] == pytest.approx([1.0, 1.0]) and frac[:, 1:].max() == 0.0
    sub = np.array([[True, True, False], [True, False, False]])  # one cell too many
    c = K.compare(sub, frac, lats, lons)
    assert c["mask_land_ref_mostly_water"] == 1 and c["mask_water_ref_mostly_land"] == 0
    assert c["all_water_cells"] == [(36.51, -76.57)]
    assert "+" in K.ascii_map(sub, lats, lons, K.reference_mask(frac))
