"""Ocean and weather data. Owner: Priya (thread 2).

Real data, fetched on demand and cached under data/ (see README.md here):
    ERA5Source       wind, waves, sunlight, cloud, air temp (ARCO-ERA5, no account)
    GlorysSource     surface currents (Copernicus Marine GLORYS12, free login)
    ShipDensitySource  ships per km^2 (EMODnet + World Bank AIS; built in Actions)
    ReanalysisEnvironment  all of them together, behind the Environment interface

    ErrorForecast    what the base station sees: truth plus error growing with lead time

Still to come: IBTrACS storm check (#13),
NDBC buoy check (#10), real coastline (#11).
"""

from boatsim.oceandata.base import ConstantEnvironment, Environment, Forecast, PerfectForecast
from boatsim.oceandata.era5 import ERA5Source
from boatsim.oceandata.forecast import ErrorForecast, ErrorModel
from boatsim.oceandata.glorys import GlorysSource
from boatsim.oceandata.grid import ROUTE_BOX, Box, OutsideCoverage
from boatsim.oceandata.reanalysis import ReanalysisEnvironment
from boatsim.oceandata.traffic import ShipDensitySource

__all__ = [
    "ROUTE_BOX",
    "Box",
    "ConstantEnvironment",
    "ERA5Source",
    "Environment",
    "ErrorForecast",
    "ErrorModel",
    "Forecast",
    "GlorysSource",
    "OutsideCoverage",
    "PerfectForecast",
    "ReanalysisEnvironment",
    "ShipDensitySource",
]
