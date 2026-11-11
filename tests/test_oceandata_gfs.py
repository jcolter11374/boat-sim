import json
import urllib.error
from datetime import datetime

import numpy as np
import pytest

from boatsim.oceandata import gfs
from boatsim.oceandata.seastate import read_grid, unpack

CYCLE = datetime(2026, 11, 11, 6)


def _idx(hour: int, kind: str) -> str:
    """An index in NOAA's layout: the wanted fields with decoys around them."""
    fc = "anl" if hour == 0 else f"{hour} hour fcst"
    ave = f"0-{hour} hour ave fcst"
    rows = []
    for _, k, var, level, *_ in gfs.FIELDS:
        if k == kind:
            if var in ("PRATE", "TCDC") and hour:
                rows.append((var, level, ave))  # averages first: must be skipped
            rows.append((var, level, "0 hour fcst" if kind == "wave" and hour == 0 else fc))
    rows.insert(0, ("UGRD", "10 mb", fc))  # wrong level, same variable
    out, off = [], 0
    for n, (var, level, f) in enumerate(rows, 1):
        out.append(f"{n}:{off}:d=2026111106:{var}:{level}:{f}:")
        off += 100
    return "\n".join(out) + "\n"


def _fake_get(log):
    def get(u, byte_range=None):
        log.append((u, byte_range))
        kind = "wave" if "/wave/" in u else "atmos"
        hour = int(u.split(".f")[-1][:3])
        if u.endswith(".idx"):
            return _idx(hour, kind).encode()
        entries = gfs.parse_idx(_idx(hour, kind))
        e = next(e for e in entries if e.start == byte_range[0])
        return json.dumps({"var": e.var, "level": e.level, "fcst": e.fcst, "hour": hour}).encode()

    return get


def _fake_decode(msg):
    """Global 0.25 deg grid, lat 90..-90, lon 0..359.75; value = field number + lat/100,
    land (NaN) at 40N in the wave fields."""
    m = json.loads(msg)
    assert "ave" not in m["fcst"] and m["level"] != "10 mb"
    n = next(i for i, f in enumerate(gfs.FIELDS) if f[2] == m["var"] and f[3] == m["level"])
    lats = 90.0 - 0.25 * np.arange(721)
    lons = 0.25 * np.arange(1440)
    v = np.broadcast_to((n + lats / 100.0)[:, None], (721, 1440)).copy()
    if gfs.FIELDS[n][1] == "wave":
        v[lats == 40.0, :] = np.nan
    return lats, lons, v / gfs.FIELDS[n][6]  # undo the unit factor, so output = n + lat/100


def test_parse_idx_gives_byte_spans():
    e = gfs.parse_idx(
        "1:0:d=x:UGRD:10 m above ground:anl:\n2:250:d=x:VGRD:10 m above ground:anl:\n"
    )
    assert (e[0].start, e[0].end, e[1].start, e[1].end) == (0, 250, 250, None)
    assert e[1].var == "VGRD" and e[1].level == "10 m above ground"


def test_pick_takes_instantaneous_fields_not_averages():
    entries = gfs.parse_idx(_idx(6, "atmos"))
    e = gfs.pick(entries, "PRATE", "surface", 6)
    assert e.fcst == "6 hour fcst"
    assert gfs.pick(entries, "UGRD", "10 m above ground", 6).fcst == "6 hour fcst"
    assert gfs.pick(gfs.parse_idx(_idx(0, "wave")), "WVHGT", "surface", 0) is not None
    assert gfs.pick(entries, "PRATE", "surface", 9) is None


def test_latest_cycle_falls_back_until_complete():
    asked = []

    def get(u, byte_range=None):
        asked.append(u)
        if "gfs.20261111/12/" in u:
            raise urllib.error.HTTPError(u, 404, "not yet", None, None)
        return b"1:0:d=x:UGRD:10 m above ground:120 hour fcst:\n"

    c = gfs.latest_cycle(datetime(2026, 11, 11, 15, 40), get)
    assert c == datetime(2026, 11, 11, 6)
    assert all(u.endswith(".f120.idx") or ".f120.grib2.idx" in u for u in asked)


def test_bake_writes_seastate_layout_with_issue_time(tmp_path):
    log = []
    js = gfs.bake(CYCLE, tmp_path, get=_fake_get(log), dec=_fake_decode, workers=2)
    h, planes = read_grid(js.with_suffix(""))
    assert h["issued"] == h["t0"] == "2026-11-11T06:00Z"
    assert (h["nt"], h["step_h"], h["nlat"], h["nlon"]) == (41, 3, 23, 71)
    assert (h["lat0"], h["lon0"]) == (28.0, -78.0)
    assert planes.shape == (41, len(gfs.FIELDS), 23, 71)
    for n, f in enumerate(h["fields"]):
        v = unpack(planes[5, n], f["scale"])
        lat = 28.0 + np.arange(23)
        want = np.minimum(n + lat / 100.0, 1.0) if f["name"] == "cloud" else n + lat / 100.0
        if gfs.FIELDS[n][1] == "wave":
            assert np.isnan(v[12]).all()  # 40N is land in the fake
            v, want = np.delete(v, 12, 0), np.delete(want, 12)
        assert np.allclose(v, want[:, None], atol=f["scale"]), f["name"]
    idx = json.loads((tmp_path / "forecast_index.json").read_text())
    assert idx["issued"] == "2026-11-11T06:00Z" and idx["file"] == "forecast_latest"
    # Byte ranges only: every data request named a range.
    assert all(r is not None for u, r in log if not u.endswith(".idx"))
    # The f120 wave field is last in its file: open-ended range.
    assert any(r and r[1] is None for u, r in log if ".f120.grib2" in u)


def test_sample_corridor_rejects_grids_off_whole_degrees():
    lats = 90.1 - 0.25 * np.arange(721)
    lons = 0.25 * np.arange(1440)
    with pytest.raises(ValueError):
        gfs.sample_corridor(lats, lons, np.zeros((721, 1440)))


def test_main_skips_when_issue_time_unchanged(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(gfs, "bake", lambda *a, **k: pytest.fail("should not bake"))
    gfs.main(
        ["--out", str(tmp_path), "--cycle", "2026-11-11T06:00Z", "--previous", "2026-11-11T06:00Z"]
    )
    assert "already published" in capsys.readouterr().out
    assert not list(tmp_path.iterdir())


def test_decode_reads_a_real_grib_message():
    eccodes = pytest.importorskip("eccodes")
    gid = eccodes.codes_grib_new_from_samples("regular_ll_sfc_grib2")
    try:
        ni, nj = 16, 9
        for key, val in [
            ("Ni", ni),
            ("Nj", nj),
            ("latitudeOfFirstGridPointInDegrees", 50.0),
            ("longitudeOfFirstGridPointInDegrees", 280.0),
            ("latitudeOfLastGridPointInDegrees", 42.0),
            ("longitudeOfLastGridPointInDegrees", 295.0),
            ("iDirectionIncrementInDegrees", 1.0),
            ("jDirectionIncrementInDegrees", 1.0),
            ("bitmapPresent", 1),
        ]:
            eccodes.codes_set(gid, key, val)
        v = np.arange(ni * nj, dtype=float)
        v[3] = 9999.0  # missing
        eccodes.codes_set_values(gid, v)
        msg = eccodes.codes_get_message(gid)
    finally:
        eccodes.codes_release(gid)
    lats, lons, vals = gfs.decode(msg)
    assert lats[0] == 50.0 and lats[-1] == 42.0 and lons[0] == 280.0
    assert np.isnan(vals[0, 3]) and vals[1, 0] == pytest.approx(16.0, abs=0.01)
