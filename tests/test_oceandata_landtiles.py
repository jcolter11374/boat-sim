import json

import numpy as np
import pytest

from boatsim.oceandata import landtiles as lt


def test_squares_tile_the_first_box_from_the_north_west():
    sq = lt.squares(lt.FIRST_BOX)
    assert len(sq) == 12  # 3 across, 4 down
    assert sq[0].key == "3900n7655w" and sq[0].box == (-76.55, -76.5, 39.0, 39.05)
    assert sq[-1].key == "3885n7645w" and sq[-1].box == (-76.45, -76.4, 38.85, 38.9)
    assert len({s.key for s in sq}) == 12


def test_squares_refuse_a_box_off_the_grid():
    with pytest.raises(ValueError):
        lt.squares((-76.53, -76.40, 38.85, 39.05))


def test_neighbours_share_their_edges():
    a, b = lt.Square(3895, -7650), lt.Square(3895, -7645)  # b is east of a
    la, ya, _, _ = lt.square_grid(a)
    lb, yb, _, _ = lt.square_grid(b)
    assert la[-1] == pytest.approx(lb[0]) and np.allclose(ya, yb)
    c = lt.Square(3890, -7650)  # south of a
    _, yc, _, _ = lt.square_grid(c)
    assert ya[-1] == pytest.approx(yc[0])
    assert len(la) == len(ya) == lt.TILE_NX


LISTING = """<ListBucketResult>
<Key>dem/x/chesapeake_bay/ncei19_n39x00_w076x50_2019v1.tif</Key>
<Key>dem/x/chesapeake_bay/ncei19_n39x00_w076x75_2019v1.tif</Key>
<Key>dem/x/chesapeake_bay/ncei19_n39x00_w076x50_2023v1.tif</Key>
<Key>dem/x/chesapeake_bay/index.html</Key>
</ListBucketResult>"""


def test_cudem_files_by_corner_newest_first():
    f = lt.cudem_files(LISTING)
    assert set(f) == {(39.0, -76.5), (39.0, -76.75)}
    assert f[(39.0, -76.5)].endswith("2023v1.tif")


def test_cudem_heights_fill_from_every_file_that_touches_the_grid():
    files = lt.cudem_files(LISTING)
    lons, lats = np.linspace(-76.55, -76.45, 21), np.linspace(38.99, 38.96, 4)  # across 76.50W
    seen = []

    def read(key, lo, la):  # west file: 5 m; east file: -3 m (sea); each only on its side
        seen.append(key)
        lon_g, _ = np.meshgrid(lo, la)
        west = "w076x75" in key
        mine = lon_g <= -76.5 if west else lon_g >= -76.5
        return np.where(mine, 5.0 if west else -3.0, np.nan).astype(np.float32)

    h = lt.cudem_heights(lons, lats, files, read)
    assert len(seen) == 2 and not np.isnan(h).any()
    assert h[0, 0] == 5.0 and h[0, -1] == -3.0


def test_cudem_heights_leave_nan_where_no_file():
    lons, lats, _, _ = lt.square_grid(lt.Square(3700, -7600))
    h = lt.cudem_heights(lons, lats, lt.cudem_files(LISTING), read=lambda *a: pytest.fail("read"))
    assert np.isnan(h).all()


def test_fill_gaps_takes_the_nearest_seen_colour():
    pytest.importorskip("scipy")  # bake-time only (the Land data workflow installs it)
    col = np.full((4, 4, 3), 100, np.uint8)
    col[:, 3] = 0  # the scene's edge
    col[0, 0] = (10, 200, 30)
    out = lt.fill_gaps(col)
    assert (out[:, 3] == 100).all() and tuple(out[0, 0]) == (10, 200, 30)


def test_kind():
    assert lt.kind(np.full((3, 3), -2.0)) == "sea"
    assert lt.kind(np.full((3, 3), 4.0)) == "land"
    assert lt.kind(np.array([[-1.0, 2.0]])) == "shore"


def test_bake_square_writes_decimetres_depths_and_meta(tmp_path):
    pytest.importorskip("PIL")
    pytest.importorskip("scipy")
    sq = lt.Square(3895, -7650)

    def heights(lons, lats):
        lon_g, _ = np.meshgrid(lons, lats)
        return np.where(lon_g < -76.475, 12.34, -7.25)  # land to the west, Bay to the east

    def colour(lon_g, lat_g):
        return np.full(lon_g.shape + (3,), (40, 90, 60), np.uint8)

    e = lt.bake_square(sq, tmp_path, heights, colour)
    assert e == {"key": "3895n7650w", "box": [-76.5, -76.45, 38.95, 39.0], "kind": "shore"}
    meta = json.loads((tmp_path / "bay_3895n7650w_meta.json").read_text())
    assert meta["nx"] == meta["ny"] == lt.TILE_NX and meta["scale"] == 0.1 and meta["depths"]
    h = np.fromfile(tmp_path / "bay_3895n7650w_height.bin", "<i2").reshape(meta["ny"], meta["nx"])
    assert h[0, 0] == 123 and h[0, -1] == -72  # decimetres; the sea floor kept, not clamped
    from PIL import Image

    im = Image.open(tmp_path / "bay_3895n7650w_colour.jpg")
    assert im.size == (lt.COLOUR_PX, lt.COLOUR_PX)


def test_bake_square_refuses_missing_heights(tmp_path):
    pytest.importorskip("PIL")  # bake-time only (the Land data workflow installs it)

    def heights(lons, lats):
        h = np.zeros((len(lats), len(lons)))
        h[3, 3] = np.nan
        return h

    with pytest.raises(ValueError):
        lt.bake_square(lt.Square(3895, -7650), tmp_path, heights, lambda a, b: None)
