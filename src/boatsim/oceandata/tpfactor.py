"""Peak period from mean period: the factor the 3D sea uses, checked on NDBC buoys.

ERA5 gives each wave system (wind sea, first and second swell) a MEAN period,
Tm01 = m0 / m1 (m_n = integral of f^n E(f) df). The 3D sea is drawn from a
JONSWAP spectrum set by its PEAK period Tp, so it needs Tp = factor x Tm01.
Theory says about 1.20 for JONSWAP (gamma 3.3) and 1.30 for a fully developed
Pierson-Moskowitz sea; narrow swell is nearer 1.1. This measures it.

Data: NOAA NDBC moored-buoy spectral wave density files ("swden",
https://www.ndbc.noaa.gov/data/historical/swden/), hourly E(f) in m^2/Hz on
47 bands, 0.02-0.485 Hz. Free, no account; reachable from GitHub Actions, not
from thread sandboxes. Wind from the same buoy's stdmet file (buoys.py).

Method, per hourly spectrum:
  1. Split it into wave systems at the troughs between peaks (1-D watershed on
     a 3-band running mean; a peak must hold Hs >= 0.2 m to count, otherwise it
     joins its neighbour). ERA5 splits its 2-D spectra the same way in spirit.
  2. Each system: Tp from a parabola through the peak band and its neighbours,
     Tm01 from its own bands.
  3. Wind sea or swell by wave age, as ERA5 does: the system is wind sea if its
     peak waves travel slower than 1.2 x the 10 m wind (c_p < 1.2 U10, GUESS:
     ERA5 uses 1.2 x 28 u*/c cos(angle) > 1, and 28 u* is about U10 here; the
     buoy has no wind-to-wave angle for each system, so the cosine is taken as 1).
Reported: median and quartiles of Tp / Tm01 for wind sea, first swell (the
largest swell system in the hour) and second swell.

Result, 2020 (8 buoys, 81k systems): wind sea 1.10, first swell 1.09, second
swell 1.06; every buoy within 0.03; the f^-5 tail moves the wind sea by 0.01.

era5_ratio() measures the same ratio inside ERA5 (its peak period over the
dominant system's Tm01). June 2020: wind sea 1.36, swell 1.14. Swell agrees with
the buoys; ERA5's wind-sea mean periods run short next to its own peaks. The 3D
sea draws ERA5's sea, so it uses ERA5's ratios (sea3d/src/seastate.ts).
"""

from __future__ import annotations

import gzip
import math
from concurrent.futures import ThreadPoolExecutor

import numpy as np

from boatsim.oceandata import buoys

SWDEN_URL = "https://www.ndbc.noaa.gov/data/historical/swden/{station}w{year}.txt.gz"
G = 9.81
MIN_HS = 0.2  # m: smaller peaks merge into their neighbour
WAVE_AGE = 1.2  # wind sea if c_p < WAVE_AGE x U10 (GUESS, see module doc)
STATIONS = ["44014", "41001", "41002", "41048", "41049", "44011", "44008", "41025"]
MONTHS = range(4, 12)  # April to November, the sea-state files' season


def parse_swden(text: str):
    """swden text -> (times as datetime64[h], freqs (nf,), E (nt, nf) with NaN)."""
    lines = [ln for ln in text.splitlines() if ln.strip()]
    head = lines[0].lstrip("#").split()
    ncol = 5 if head[4] == "mm" else 4
    freqs = np.array([float(x) for x in head[ncol:]])
    times, rows = [], []
    for ln in lines[1:]:
        if ln.startswith("#"):
            continue
        p = ln.split()
        y = int(p[0])
        y = y + 1900 if y < 100 else y
        mi = int(p[4]) if ncol == 5 else 0
        t = np.datetime64(f"{y:04d}-{int(p[1]):02d}-{int(p[2]):02d}T{int(p[3]):02d}:{mi:02d}")
        times.append((t + np.timedelta64(30, "m")).astype("datetime64[h]"))
        rows.append([float(x) for x in p[ncol : ncol + len(freqs)]])
    e = np.array(rows, dtype=float)
    e[e >= 999] = np.nan
    return np.array(times), freqs, e


def band_widths(f: np.ndarray) -> np.ndarray:
    """Width of each band from the midpoints between centres."""
    edges = np.concatenate([[f[0] - (f[1] - f[0]) / 2], (f[1:] + f[:-1]) / 2])
    edges = np.append(edges, f[-1] + (f[-1] - f[-2]) / 2)
    return np.diff(edges)


def peak_freq(f: np.ndarray, e: np.ndarray, k: int) -> float:
    """Parabola through the peak band and its neighbours (in f), else the band."""
    if 0 < k < len(f) - 1 and e[k - 1] > 0 and e[k + 1] > 0:
        x, y = f[k - 1 : k + 2], e[k - 1 : k + 2]
        a, b, _ = np.polyfit(x, y, 2)
        if a < 0:
            fp = -b / (2 * a)
            if x[0] <= fp <= x[2]:
                return float(fp)
    return float(f[k])


def systems(f: np.ndarray, e: np.ndarray, df: np.ndarray, min_hs: float = MIN_HS) -> list[dict]:
    """Split one spectrum into wave systems; each with hs, tp, tm01 (s)."""
    if not np.all(np.isfinite(e)):
        return []
    s = np.convolve(np.pad(e, 1, mode="edge"), np.ones(3) / 3, mode="valid")
    # each band climbs to its peak; bands that climb to the same peak are one system
    n = len(f)
    up = np.arange(n)
    for i in range(n):
        j = i
        while True:
            nb = [k for k in (j - 1, j + 1) if 0 <= k < n and s[k] > s[j]]
            if not nb:
                break
            j = max(nb, key=lambda k: s[k])
        up[i] = j
    groups = {p: np.flatnonzero(up == p) for p in np.unique(up)}

    def hs(idx):
        return 4 * math.sqrt(max(float(np.sum(e[idx] * df[idx])), 0.0))

    # merge small systems into the neighbour across their lower trough
    changed = True
    while changed and len(groups) > 1:
        changed = False
        for p in sorted(groups, key=lambda q: hs(groups[q])):
            if hs(groups[p]) >= min_hs:
                continue
            idx = groups[p]
            left, right = idx.min() - 1, idx.max() + 1
            cands = [(s[k], k) for k in (left, right) if 0 <= k < n]
            if not cands:
                continue
            _, k = max(cands)
            q = next(q for q, g in groups.items() if k in g)
            groups[q] = np.sort(np.concatenate([groups[q], idx]))
            del groups[p]
            changed = True
            break
    out = []
    for idx in groups.values():
        m0 = float(np.sum(e[idx] * df[idx]))
        m1 = float(np.sum(f[idx] * e[idx] * df[idx]))
        if m0 <= 0 or m1 <= 0 or len(idx) < 3:
            continue
        k = int(idx[np.argmax(e[idx])])
        # A system that runs to the top band goes on past what the buoy measures.
        # Add an f^-5 tail beyond it, as ECMWF's wave model does for its own
        # mean periods (ECMWF IFS documentation, Part VII, the WAM high-frequency
        # tail); without it short wind seas read too long a Tm01.
        t0, t1 = m0, m1
        if idx.max() == n - 1 and e[-1] > 0:
            fe = f[-1] + df[-1] / 2
            c = e[-1] * f[-1] ** 5
            t0 += c / (4 * fe**4)
            t1 += c / (3 * fe**3)
        out.append(
            {
                "hs": 4 * math.sqrt(m0),
                "tp": 1 / peak_freq(f, e, k),
                "tm01": m0 / m1,
                "tm01_tail": t0 / t1,
                "edge": k in (0, n - 1),
            }
        )
    return out


def classify(sys_list: list[dict], u10: float) -> dict[str, dict]:
    """Wind sea (largest wind-sea system), first and second swell (largest two
    swell systems), as ERA5 labels them. Systems peaking in the first or last
    band are dropped (their peak is outside what the buoy measures)."""
    sea, swell = [], []
    for s in sys_list:
        if s["edge"]:
            continue
        cp = G * s["tp"] / (2 * math.pi)
        (sea if np.isfinite(u10) and cp < WAVE_AGE * u10 else swell).append(s)
    out = {}
    if sea:
        out["ws"] = max(sea, key=lambda s: s["hs"])
    swell.sort(key=lambda s: -s["hs"])
    for name, s in zip(("s1", "s2"), swell):
        out[name] = s
    return out


def fetch(station: str, year: int):
    raw = buoys.fetch_text(SWDEN_URL.format(station=station, year=year))
    met = buoys.hourly(
        buoys.parse_stdmet(buoys.fetch_text(buoys.STDMET_URL.format(station=station, year=year)))
    )
    return parse_swden(raw), met


def run(year: int = 2020, stations=STATIONS, months=MONTHS, log=print):
    import pandas as pd

    def one(st):
        try:
            return st, fetch(st, year)
        except Exception as e:  # noqa: BLE001 - a missing year for one buoy shouldn't stop the rest
            log(f"{st}: {e!r}"[:200])
            return st, None

    rows = []
    with ThreadPoolExecutor(4) as ex:
        for st, got in ex.map(one, stations):
            if got is None:
                continue
            (times, f, e), met = got
            df = band_widths(f)
            u10 = buoys.to_10m(met["wspd"]).reindex(pd.DatetimeIndex(times)).to_numpy()
            months_of = pd.DatetimeIndex(times).month
            n0 = len(rows)
            for i in range(len(times)):
                if months_of[i] not in months:
                    continue
                for name, s in classify(systems(f, e[i], df), float(u10[i])).items():
                    rows.append({"station": st, "time": times[i], "system": name, **s})
            log(f"{st}: {len(times)} spectra, {len(rows) - n0} systems")
    return pd.DataFrame(rows)


def summary(df, log=print):
    """Median and quartiles of Tp / Tm01 per system, all buoys together, with
    and without the high-frequency tail, and by peak period."""
    import pandas as pd

    out = []
    bins = [(0, 5), (5, 8), (8, 12), (12, 99)]
    for name in ("ws", "s1", "s2"):
        d = df[df.system == name]
        if d.empty:
            continue
        r = d.tp / d.tm01
        rt = d.tp / d.tm01_tail
        row = {
            "system": name,
            "n": len(d),
            "median": r.median(),
            "q25": r.quantile(0.25),
            "q75": r.quantile(0.75),
            "tail_median": rt.median(),
            "tail_q25": rt.quantile(0.25),
            "tail_q75": rt.quantile(0.75),
            "median_hs": d.hs.median(),
            "median_tp": d.tp.median(),
        }
        for lo, hi in bins:
            b = (d.tp >= lo) & (d.tp < hi)
            row[f"tail_tp{lo}-{hi}"] = rt[b].median() if b.sum() >= 50 else float("nan")
            row[f"n_tp{lo}-{hi}"] = int(b.sum())
        out.append(row)
    t = pd.DataFrame(out)
    log(t.T.to_string(header=False, float_format=lambda x: f"{x:.3f}"))
    return t


def era5_ratio(stem, every: int = 6, share: float = 0.85, log=print) -> dict[str, np.ndarray]:
    """ERA5's own Tp / Tm01: its peak period (peak_wave_period, the peak of the
    whole spectrum) over a system's mean period, where that system holds more
    than `share` of the energy, so the peak is that system's. Reads a baked
    seastate_YYYY-MM month (stem without suffix) and the same hours from
    ARCO-ERA5 (every `every`-th 3-hour step)."""
    import json
    from pathlib import Path

    from boatsim.oceandata.era5 import ARCO_ERA5_URL, _open_store

    stem = Path(stem)
    h = json.loads(stem.with_suffix(".json").read_text())
    raw = np.frombuffer(gzip.decompress(stem.with_suffix(".bin.gz").read_bytes()), "<i2")
    q = raw.reshape(h["shape"])
    v = {
        f["name"]: np.where(q[:, i] == -32768, np.nan, q[:, i] * f["scale"])
        for i, f in enumerate(h["fields"])
    }
    st = _open_store(ARCO_ERA5_URL)
    lats, lons = st.latitude.values, st.longitude.values
    lons = ((lons + 180.0) % 360.0) - 180.0
    li = [int(np.argmin(abs(lats - (h["lat0"] + i * h["res"])))) for i in range(h["nlat"])]
    lj = [int(np.argmin(abs(lons - (h["lon0"] + j * h["res"])))) for j in range(h["nlon"])]
    tv = st.time.values
    t0 = np.datetime64(h["t0"].rstrip("Z"), "ns")
    out: dict[str, list] = {"ws": [], "s1": [], "s2": []}
    for k in range(0, h["nt"], every):
        ti = int(np.searchsorted(tv, t0 + np.timedelta64(h["step_h"] * k, "h")))
        pp = st["peak_wave_period"].isel(time=ti).values[np.ix_(li, lj)]
        e = {s: np.nan_to_num(v[f"{s}_hs"][k]) ** 2 for s in out}
        tot = sum(e.values())
        for s in out:
            tm = v[f"{s}_tm"][k]
            m = (e[s] > share * tot) & (tot > 0.04) & np.isfinite(pp) & np.isfinite(tm)
            out[s] += list(pp[m] / tm[m])
    res = {s: np.array(r) for s, r in out.items()}
    for s, r in res.items():
        if len(r):
            q25, q50, q75 = np.percentile(r, [25, 50, 75])
            log(f"ERA5 {s}: n {len(r)}, Tp/Tm01 median {q50:.3f} (middle half {q25:.3f}-{q75:.3f})")
    return res


def main(argv=None) -> None:
    import argparse
    from pathlib import Path

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("year", type=int, nargs="?", default=2020)
    p.add_argument("--out", default="runs/tpfactor")
    p.add_argument("--era5", help="a baked seastate month (stem, no suffix): ERA5's own ratio")
    a = p.parse_args(argv)
    if a.era5:
        era5_ratio(a.era5)
        return
    df = run(a.year)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    df.to_csv(out / f"systems_{a.year}.csv.gz", index=False)
    t = summary(df)
    t.to_csv(out / f"summary_{a.year}.csv", index=False)
    by = df.assign(r=df.tp / df.tm01).groupby(["station", "system"]).r.median().unstack()
    print("\nmedian Tp/Tm01 by buoy:")
    print(by.to_string(float_format=lambda x: f"{x:.3f}"))
    (out / f"by_station_{a.year}.txt").write_text(by.to_string())


if __name__ == "__main__":
    main()
