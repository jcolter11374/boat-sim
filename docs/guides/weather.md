# Weather and ocean data

The boats sail in **real past weather**: what the wind, waves and currents
actually did on the day. The detailed reference is
[src/boatsim/oceandata/README.md](../../src/boatsim/oceandata/README.md)
(sources, units, measured sizes, every check against real buoys). This page
is the overview.

## Sources

| What | Source | Account |
| --- | --- | --- |
| Wind, waves, sunlight, cloud, air temperature, rain | ERA5 reanalysis, hourly, 0.25°, streamed from Google's public ARCO-ERA5 Zarr store | none |
| Surface currents (the Gulf Stream and the rest) | Copernicus Marine GLORYS12, daily, 1/12° | free login |
| Second-opinion currents, for checks only | Copernicus Marine SMOC | same login |
| Ship traffic | a fixed density map, `data/traffic/ship_density_v1.nc` (in git) | none |
| Storm tracks, for checks and challenges | IBTrACS | none |
| Today's weather (look only) | NOAA GFS | none |
| Land and coast | Natural Earth (mask), elevation and imagery for the 3D land | none |

Nothing is bulk-downloaded. A voyage fetches only the days it uses, cropped
to the route box (25-60N, 82W-5E), and caches them under `data/` (ignored by
git; set `BOATSIM_DATA` to move it). The Copernicus login lives only in
GitHub Actions secrets (`COPERNICUSMARINE_SERVICE_USERNAME`/`PASSWORD`) and
is never committed.

## How the simulator reads it

`oceandata/base.py` defines the `Environment` interface: one call,
`sample(t, lat, lon) -> EnvState`, gives everything at the boat. The real
one is `ReanalysisEnvironment` (`reanalysis.py`), built from `ERA5Source` and
`GlorysSource`. `Forecast.issue(t)` gives the shore base a forecast with
realistic error (`forecast.py`), so re-planning isn't done with perfect
knowledge. Tests use `ConstantEnvironment` and `PerfectForecast`.

```bash
python -m boatsim.oceandata sample 2020-10-15T12:00 37 -70 --no-currents
python -m boatsim.oceandata fetch-era5 2020-10-01 2020-12-31   # pre-warm the cache
```

## Weather in the browser

The browser can't stream ERA5, so a workflow cuts a **forcing bundle**: the
2020 season, thinned to the route corridor (1° every 6 hours for wind and
waves, hourly rain), about 18 MB (`sandbox/forcing.py`, workflow "Sandbox
data"). The site build splits it by month so the helm loads only the months
a voyage sails through, and checks the split changes no value. Pages that
show bundle results say "2020 weather", because thinned weather can end a
voyage a little differently from a full-resolution run. Details:
[../sandbox.md](../sandbox.md).

## Weather for the look

These change the picture, never the result:

- **Sea state** (`seastate.py`, workflow "Sea state data"): ERA5's wind sea
  and two swells, baked so the drawn sea matches the logged one.
- **Today's weather** (`gfs.py`, workflow "Today's weather").
- **Land** for the 3D views (`landviews.py`, `landtiles.py`, workflow
  "Land data").

## Weather challenges

`challenges.py` and `storm_dates.py` pick real past storms, cut a weather
bundle for each, and write the goals and debriefs the helm's challenge
picker shows (workflow "Challenge data", stars by "Challenge stars").

## Checks against the real world

Before trusting the data, we check it: ERA5 waves and wind against NOAA buoys
(`buoys.py`), our currents against real drifting buoys
(`mc/drifters.py`), GLORYS against SMOC (`currents_check.py`), storms against
IBTrACS (`storms.py`), and the land mask near the Bay (`coast_check.py`).
Write-ups are in [docs/qa/](../qa/).
