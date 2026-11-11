# Third-party notices

## drone-boat (Randolph team)

`src/boatsim/vessel/hazards.py` (the `sample_failures` part) and the matching
`hazards:` entries in `configs/v4_kayak.yaml` adapt the failure list, default
rates and sea-state multipliers from
[sheltonr2/drone-boat](https://github.com/sheltonr2/drone-boat),
`simulator/drone_sim/failures.py` and `simulator/drone_sim/sim.py`
(commit 5eebe9f). The failure rates, the near-land and open-ocean phases, the
comms-silent mode, the early-life multiplier and the three rate sets (#89) come
from their shared hazard table, `docs/Failure_Rates.md` (commit 25befa9). All
of it is used under this licence. The Rev B righting-arm curve and roll and
pitch inertias in `sea3d/src/motion.ts` come from their
`docs/data/revB_gz_curve.csv` (shared on our issue #50, 9 Nov 2026). The wing-sail
model in `src/boatsim/vessel/sail.py` (foil curve, wind at wing height, tacking
rules) follows their `simulator/drone_sim/vpp.py` and `autopilot.py`, and
`configs/randolph_rev_b.yaml` (our model of their boat) takes its numbers from
their `simulator/drone_sim/design.py`, `failures.py`, `build-files/source/design.py`
and docs. `configs/randolph_rev_c.yaml` was written by the Randolph team in our
format (their `designs/boat-sim/randolph_rev_c.yaml`, 10 Nov 2026, shared on #50) and is
kept as they wrote it; the Rev C righting-arm curve and point masses in
`sea3d/src/motion.ts` come from their `docs/data/revC_gz_curve.csv` and
`simulator/drone_sim/design.py`. The Boatyard's Randolph Rev B and Rev C
starting designs (`sea3d/src/yard/bases.ts`) take their parts, prices and weights
from the parts table in their `docs/Build_Plan.md` (Nov 2026). All under the same licence:

```
MIT License

Copyright (c) 2026 Randolph

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Ship-traffic map (`data/traffic/ship_density_v1.nc`)

This file is built by `src/boatsim/oceandata/traffic.py` (workflow "Build ship
density"). It is derived from two datasets, both under the
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/)
licence. We changed them: we averaged them onto a 0.1 degree grid, converted
them to ships per km², and filled the non-EMODnet water using a table fitted
between the two maps.

- **EMODnet Human Activities, Vessel Density Map**, annual averages 2022 and
  2023, all ship types. This data was downloaded from the
  [EMODnet Portal](https://emodnet.ec.europa.eu/en/). The data originator is
  Cogea Srl. Licence: CC BY 4.0
  ([catalogue record](https://emodnet.ec.europa.eu/geonetwork/srv/api/records/0f2f3ff1-30ef-49e1-96e7-8ca78d58a07c)).
- **Global Shipping Traffic Density**, World Bank Data Catalog, dataset 0037580
  (https://datacatalog.worldbank.org/search/dataset/0037580), from the IMF's
  World Seaborne Trade Monitoring System (Cerdeiro, Komaromi, Liu and Saeed,
  2020). Licence: CC BY 4.0.

## Weather and ocean data

The weather and current files in `data/era5/`, the voyage replays in
`sea3d/public/voyages/` and `sea3d/public/boatyard/`, and the `sandbox-data`
release all contain data derived from these sources. We thinned, regridded
and quantised it.

- **ERA5** hourly reanalysis (Hersbach et al. 2020, doi:10.1002/qj.3803), read
  from Google's public ARCO-ERA5 copy. Contains modified Copernicus Climate
  Change Service information. Neither the European Commission nor ECMWF is
  responsible for any use that may be made of the Copernicus information or
  data it contains. Licence: the
  [Copernicus licence](https://cds.climate.copernicus.eu/licences/licence-to-use-copernicus-products),
  which allows redistribution with this credit.
- **GLORYS12** and **SMOC** surface currents: E.U. Copernicus Marine Service
  Information. Licence: the
  [Copernicus Marine service licence](https://marine.copernicus.eu/user-corner/service-commitments-and-licence),
  which allows redistribution with this credit.
- **NOAA NDBC buoy records** and **IBTrACS** storm tracks, used only to check
  ERA5. They are US Government works in the public domain.

## Land

- **Natural Earth** 1:10m land, used for the land mask
  (`data/land/land_mask_v1.npz`) and the coastline on the 3D pages. Made with
  Natural Earth. Free vector and raster map data @ naturalearthdata.com. It is
  in the public domain.

## Software that ships in, or is loaded by, the 3D pages

- **three.js** (MIT, Copyright 2010-2024 Three.js Authors). It is bundled into
  the page scripts, and its licence header is kept in the built files.
- **Pyodide** (Mozilla Public License 2.0), with the CPython (PSF licence) and
  NumPy, pandas and PyYAML (BSD and MIT) builds it carries. The Boatyard loads
  them unmodified from the jsDelivr CDN at run time. We don't copy or change
  them.
- **Blender** (GPL) is used only as a tool in CI to build the boat models.
  Models made with Blender belong to whoever made them, so the GPL doesn't
  cover our `.glb` files. Our build scripts that call Blender's Python API are
  MIT, which is GPL-compatible.

The Python packages in `pyproject.toml` (NumPy, pandas, PyYAML, xarray,
netCDF4, zarr, gcsfs, copernicusmarine, rasterio, pyproj, requests, plotly,
folium, pytest, ruff) are dependencies that users install themselves. We don't
copy them into this repo. All of them use permissive licences (BSD, MIT,
Apache 2.0), apart from copernicusmarine, which uses the EUPL 1.2. All of
them can be used from MIT code.

## Adding a new data source

Before data from a new source is committed or published, check its licence
allows redistribution. Then add it here and on the 3D pages' Credits line.
Never use a source that needs an API key in the public pages. Known
requirements for sources we are trying out:

- **OpenStreetMap / Overture Maps** buildings and piers: ODbL. Credit
  "© OpenStreetMap contributors" (and Overture Maps Foundation). If we publish
  a derived *database* (for example a building tile set), it must stay under
  ODbL. Pictures and 3D scenes made from it are "produced works", which can be
  under any licence but must carry the credit.
- **Sentinel-2** imagery: "Contains modified Copernicus Sentinel data [year]".
- **AWS Terrain Tiles**: credit the underlying sources listed in the
  [tile attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
  (SRTM, GMTED, ETOPO1 and USGS 3DEP are public domain; Copernicus EU-DEM and
  some national surveys need a credit).
- **GEBCO** grid: "GEBCO Compilation Group (year) GEBCO year Grid". It is free
  to use and share.
- **NOAA ETOPO, nautical charts and NAIP** imagery: US Government works,
  public domain.

## Sea state and depth for the 3D view (`seastate-data` release)

Built by `src/boatsim/oceandata/seastate.py` and the "Sea state data" workflow;
not stored in git. Thinned and quantised by us.

- ERA5 wave partitions: Contains modified Copernicus Climate Change Service
  information (Hersbach et al. 2020, doi:10.1002/qj.3803), read from Google's
  ARCO-ERA5 public copy. Neither the European Commission nor ECMWF is
  responsible for any use that may be made of the Copernicus information or
  data it contains.
- Depth: GEBCO Compilation Group (2024) GEBCO 2024 Grid
  (doi:10.5285/1c44ce99-0a0d-5f4f-e063-7086abc0ea0f), free to use with this
  credit; or, if GEBCO's server didn't answer, NOAA NCEI ETOPO 2022 Global Relief
  Model (doi:10.25921/fd45-gt74), public domain. Each file's header names which.

## Today's weather for the 3D view (`forecast-data` release)

Built by `src/boatsim/oceandata/gfs.py` and the "Today's weather" workflow; not
stored in git. Thinned and quantised by us.

- NOAA Global Forecast System (GFS) and GFS-Wave (WAVEWATCH III),
  NOAA/NWS/NCEP, via the NOAA Open Data Dissemination program on AWS
  (https://registry.opendata.aws/noaa-gfs-bdp-pds/). US Government work,
  public domain; credited as a courtesy. A forecast, not observations.

## Land for the 3D views (`land-data` release)

Built by `src/boatsim/oceandata/landviews.py` and the "Land data" workflow; not
stored in git. Resampled by us.

- Terrain: AWS Terrain Tiles (Mapzen/Tilezen), from SRTM, GMTED2010, ETOPO1,
  USGS 3DEP and others; see
  https://github.com/tilezen/joerd/blob/master/docs/attribution.md.
- Colour of Pico and Faial: contains modified Copernicus Sentinel data 2023-2024
  (Sentinel-2 L2A, via the Registry of Open Data on AWS).
  Shown at voyage.html?place=pico ("Off Pico, Azores"), with both credits on the
  page's credit line.
- Annapolis buildings and piers (`annapolis.json`): contains information from
  OpenStreetMap and Overture Maps Foundation, available under the Open Database
  License (ODbL 1.0, https://opendatacommons.org/licenses/odbl/1-0/). The file
  is a derived database and stays under the ODbL, separate from this repo's MIT
  code; any public copy keeps this notice.
