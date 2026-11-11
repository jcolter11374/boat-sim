"""Check the weather-challenge storm dates against IBTrACS (display/game data only).

The draft challenge list (Priya, 11 Nov 2026) gives storm dates from memory:
Sandy 2012, Dorian 2019, Paulette and Teddy 2020, Lorenzo 2019, Ophelia 2017.
For each storm this prints its first and last best-track fix, its peak (wind and
Saffir-Simpson category, from NOAA's USA_ columns) and its closest pass to the
place the challenge names, with the date and distance.

The 2013-14 winter storms are extratropical lows, which IBTrACS doesn't track;
they need ERA5 instead.

    python -m boatsim.oceandata.storm_dates ibtracs.NA.list.v04r01.csv
"""

from __future__ import annotations

import math

PLACES = {
    "New Jersey coast": (39.4, -74.4),
    "Cape Hatteras": (35.25, -75.53),
    "Nova Scotia (Halifax)": (44.65, -63.57),
    "Bermuda": (32.31, -64.78),
    "Azores (Faial)": (38.55, -28.7),
    "Ireland (Cork)": (51.9, -8.47),
}

# (storm name, season, places the challenge mentions, draft claim)
CLAIMS = [
    ("SANDY", 2012, ["New Jersey coast", "Cape Hatteras"], "passes off VA/NJ 28-29 Oct"),
    ("DORIAN", 2019, ["Cape Hatteras", "Nova Scotia (Halifax)"], "Hatteras 6 Sep, then NS"),
    ("PAULETTE", 2020, ["Bermuda"], "crosses Bermuda 14 Sep"),
    ("TEDDY", 2020, ["Bermuda"], "passes Bermuda about a week after Paulette"),
    ("LORENZO", 2019, ["Azores (Faial)", "Ireland (Cork)"], "Cat 5, reaches the Azores 2 Oct"),
    ("OPHELIA", 2017, ["Azores (Faial)", "Ireland (Cork)"], "major near Azores, Ireland 16 Oct"),
]


def km(lat1, lon1, lat2, lon2) -> float:
    """Great-circle distance, km."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(a))


def load(csv):
    import pandas as pd

    df = pd.read_csv(
        csv,
        skiprows=[1],
        usecols=["SID", "SEASON", "NAME", "ISO_TIME", "LAT", "LON", "USA_WIND", "USA_SSHS"],
        na_values=[" ", ""],
        keep_default_na=False,
        low_memory=False,
    )
    df["time"] = pd.to_datetime(df["ISO_TIME"])
    for c in ("SEASON", "LAT", "LON", "USA_WIND", "USA_SSHS"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def check(df, name: str, season: int, places: list[str]) -> dict:
    t = df[(df.NAME == name) & (df.SEASON == season)].sort_values("time")
    if t.empty:
        return {"storm": f"{name} {season}", "found": False}
    peak = t.loc[t.USA_WIND.idxmax()] if t.USA_WIND.notna().any() else t.iloc[0]
    out = {
        "storm": f"{name} {season}",
        "found": True,
        "first": t.time.iloc[0].strftime("%Y-%m-%d"),
        "last": t.time.iloc[-1].strftime("%Y-%m-%d"),
        "peak_kt": None if peak.USA_WIND != peak.USA_WIND else int(peak.USA_WIND),
        "peak_cat": None if peak.USA_SSHS != peak.USA_SSHS else int(peak.USA_SSHS),
        "peak_date": peak.time.strftime("%Y-%m-%d"),
        "peak_lon": round(float(peak.LON), 1),
        "passes": [],
    }
    for place in places:
        plat, plon = PLACES[place]
        d = [km(a, b, plat, plon) for a, b in zip(t.LAT, t.LON)]
        i = min(range(len(d)), key=d.__getitem__)
        r = t.iloc[i]
        out["passes"].append(
            {
                "place": place,
                "km": round(d[i]),
                "date": r.time.strftime("%Y-%m-%d %H UTC"),
                "kt": None if r.USA_WIND != r.USA_WIND else int(r.USA_WIND),
                "cat": None if r.USA_SSHS != r.USA_SSHS else int(r.USA_SSHS),
            }
        )
    return out


def report(df, claims=CLAIMS, log=print) -> list[dict]:
    rows = []
    for name, season, places, claim in claims:
        r = check(df, name, season, places)
        rows.append({**r, "claim": claim})
        if not r["found"]:
            log(f"{r['storm']}: NOT FOUND in IBTrACS (draft: {claim})")
            continue
        log(
            f"{r['storm']}: {r['first']} to {r['last']}; peak {r['peak_kt']} kt "
            f"(category {r['peak_cat']}) on {r['peak_date']} at {r['peak_lon']} deg; draft: {claim}"
        )
        for p in r["passes"]:
            log(
                f"    closest to {p['place']}: {p['km']} km on {p['date']}, "
                f"{p['kt']} kt (category {p['cat']})"
            )
    log("Winter storm train 2013-14: extratropical lows, not in IBTrACS; check with ERA5.")
    return rows


def main(argv: list[str] | None = None) -> None:
    import argparse
    import json

    ap = argparse.ArgumentParser(description="Check challenge storm dates against IBTrACS")
    ap.add_argument("ibtracs_csv")
    ap.add_argument("--json", help="also write the rows here")
    a = ap.parse_args(argv)
    rows = report(load(a.ibtracs_csv))
    if a.json:
        with open(a.json, "w", encoding="utf-8") as f:
            json.dump(rows, f, indent=1)


if __name__ == "__main__":
    main()
