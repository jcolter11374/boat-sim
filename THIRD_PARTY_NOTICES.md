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
and docs. All under the same licence:

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
