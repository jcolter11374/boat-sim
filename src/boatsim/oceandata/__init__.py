"""Ocean and weather data. Owner: Priya (thread 2).

Real implementation: ERA5 (wind, waves, sunlight, cloud), Copernicus Marine
GLORYS12 (currents), IBTrACS (storm check), AccessAIS/EMODnet (ship density).
Validated against NDBC buoys. See the plan doc, Data sources section.
"""

from boatsim.oceandata.base import ConstantEnvironment, Environment, Forecast, PerfectForecast

__all__ = ["ConstantEnvironment", "Environment", "Forecast", "PerfectForecast"]
