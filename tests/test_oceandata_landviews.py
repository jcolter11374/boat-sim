import io
import math

import numpy as np
import pytest

from boatsim.oceandata import landviews as lv


def test_terrarium_decode():
    rgb = np.array([[[128, 0, 0], [128, 100, 128], [127, 156, 0]]], dtype=np.uint8)
    assert lv.terrarium_decode(rgb)[0].tolist() == [0.0, 100.5, -100.0]


def test_tile_xy_matches_slippy_map_formula():
    x, y = lv.tile_xy(-76.48, 38.97, 15)
    n = 2**15
    lat = math.radians(38.97)
    assert float(x) == pytest.approx((-76.48 + 180) / 360 * n)
    assert float(y) == pytest.approx(
        (1 - math.log(math.tan(lat) + 1 / math.cos(lat)) / math.pi) / 2 * n
    )


def test_bilinear_midpoint_and_clip():
    img = np.array([[0.0, 10.0], [20.0, 30.0]])
    assert float(lv.bilinear(img, np.array(0.5), np.array(0.5))) == pytest.approx(15.0)
    assert float(lv.bilinear(img, np.array(-5.0), np.array(-5.0))) == pytest.approx(0.0)


def test_terrain_from_fake_tiles():
    Image = pytest.importorskip("PIL.Image")

    def fetch(url):  # every tile is flat 12 m
        a = np.zeros((256, 256, 3), np.uint8)
        a[..., 0], a[..., 1] = 128, 12
        b = io.BytesIO()
        Image.fromarray(a).save(b, format="PNG")
        return b.getvalue()

    lons, lats, w, h = lv.grid(lv.ANNAPOLIS_BOX, 50)
    assert lats[0] > lats[-1] and lons[0] < lons[-1]
    assert w == pytest.approx(2858, abs=5) and h == pytest.approx(2441, abs=5)
    z = lv.terrain(lv.ANNAPOLIS_BOX, 15, lons, lats, fetch=fetch)
    assert z.shape == (len(lats), 50) and np.allclose(z, 12.0)


def test_local_frame_x_east_z_south():
    lat0, lon0 = lv.ANNAPOLIS_ORIGIN
    x, z = lv.local_xz(lon0 + 0.001, lat0 + 0.001)
    assert x == pytest.approx(86.6, abs=0.2) and z == pytest.approx(-110.95, abs=0.01)


def test_building_record_heights_roofs_and_guesses():
    geometry = pytest.importorskip("shapely.geometry")
    LineString, box = geometry.LineString, geometry.box

    lat0, lon0 = lv.ANNAPOLIS_ORIGIN
    small = box(lon0, lat0, lon0 + 0.0001, lat0 + 0.0001)  # ~8.7 x 11 m
    big = box(lon0, lat0, lon0 + 0.0005, lat0 + 0.0005)  # ~43 x 55 m
    ground = lambda lon, lat: 3.0
    r = lv.building_record(small, {"id": "a", "height": None, "num_floors": None}, ground)[0]
    assert (r["h"], r["r"], r["b"]) == (7.0, "gable", 3.0)
    r = lv.building_record(big, {"id": "b", "height": float("nan"), "num_floors": 4}, ground)[0]
    assert (r["h"], r["r"]) == (12.8, "flat")
    r = lv.building_record(big, {"id": "c", "names": {"primary": "Maryland State House"}}, ground)[
        0
    ]
    assert (r["h"], r["n"]) == (17.0, "Maryland State House")
    tiny = box(lon0, lat0, lon0 + 0.00002, lat0 + 0.00002)
    assert lv.building_record(tiny, {"id": "d"}, ground) == []
    strip = lv.pier_polygons(LineString([(lon0, lat0), (lon0 + 0.001, lat0)]))
    assert len(strip) == 1 and len(strip[0]) == 4


def test_fill_clouds_replaces_grey_on_land_only():
    pytest.importorskip("scipy")
    col = np.full((60, 60, 3), (60, 90, 40), np.uint8)
    col[25:35, 25:35] = 200  # a cloud over land
    col[0:5, 0:5] = 200  # bright, but at sea
    h = np.full((60, 60), 50.0)
    h[0:10, 0:10] = 0.0
    out = lv.fill_clouds(col, h)
    assert np.abs(out[30, 30].astype(int) - [60, 90, 40]).max() <= 1
    assert out[2, 2].tolist() == [200, 200, 200]


def test_scene_url():
    assert lv._scene_url("S2B_26SLH_20240626", "TCI").endswith(
        "/26/S/LH/2024/6/S2B_26SLH_20240626_0_L2A/TCI.tif"
    )


def test_coast_regions_fit_their_tiles_and_spacing():
    for key, reg in lv.REGIONS.items():
        zone = reg.epsg - 32600
        for names in reg.scenes.values():
            for sc in names:
                assert sc.split("_")[1][:2] == str(zone), (key, sc)
                assert lv._scene_url(sc, "TCI").startswith(lv.S2_COG)
        lons, _lats, w, h = lv.grid(reg.box, reg.nx)
        assert 10 < w / (len(lons) - 1) < 35, key  # metres between columns
        assert w < 100e3 and h < 100e3, key  # inside one 110 km Sentinel tile
    # The page's land files are named by these keys (sea3d/src/land/place.ts).
    assert {"pico", "baymouth", "lisbon", "annapolisbay"} <= set(lv.REGIONS)


def test_tag_height():
    assert lv.tag_height({"height": "12"}) == 12.0 and lv.tag_height({"height": "40 ft"}) == 12.2
    assert lv.tag_height({"height": "tall"}) is None and lv.tag_height(None) is None


def test_land_cover_greenness_then_osm_areas():
    """Greenness sorts land into trees, grass and built; OSM areas paint over
    it; water stays 0; OSM tree points and rows come back with heights."""
    pytest.importorskip("rasterio")
    from shapely.geometry import LineString, Point, box

    lons, lats = np.linspace(-76.5, -76.4, 11), np.linspace(39.0, 38.9, 11)
    hgt = np.full((11, 11), 5.0)
    hgt[:, 8:] = -3.0  # the Bay on the east
    ndvi = np.full((11, 11), 0.8)  # canopy
    ndvi[:, 8:] = -0.1
    ndvi[0:3, 0:3] = 0.45  # a lawn
    ndvi[8:, 0:3] = 0.1  # a car park
    rows = {
        "land": [
            {"subtype": "sand", "geometry": box(-76.435, 38.905, -76.425, 38.995).wkb},
            {
                "subtype": "tree",
                "geometry": Point(-76.47, 38.95).wkb,
                "source_tags": {"height": "9"},
            },
            {"subtype": "tree", "geometry": LineString([(-76.48, 38.95), (-76.46, 38.95)]).wkb},
        ],
        "land_use": [
            {"subtype": "golf", "geometry": box(-76.465, 38.965, -76.445, 38.985).wkb},
            {"subtype": "park", "geometry": box(-76.5, 38.9, -76.4, 39.0).wkb},  # not painted
        ],
    }
    cover, trees = lv.land_cover(
        None, lons, lats, hgt, ndvi, rows=lambda t: rows.get(t, []), log=lambda *_: None
    )
    assert cover.shape == (11, 11) and cover.dtype == np.uint8
    assert cover[5, 1] == 1 and cover[1, 1] == 2 and cover[9, 1] == 5  # trees, lawn, car park
    assert cover[3, 4] == 2  # golf over canopy (row 3 = 38.97N, column 4 = 76.46W)
    assert cover[5, 7] == 4 and (cover[:, 8:] == 0).all()  # beach on land; the Bay stays 0
    assert trees == {"points": [[-76.47, 38.95, 9.0]], "rows": [[[-76.48, 38.95], [-76.46, 38.95]]]}
