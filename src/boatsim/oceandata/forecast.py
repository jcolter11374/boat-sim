"""A forecast with realistic error, for the base station (issue #12).

The base station must not see the future perfectly, or course corrections in
the simulator look better than they could ever be at sea. ErrorForecast takes
the true environment and adds error that:

* grows with lead time (the time between issuing the forecast and the moment
  it describes): small at day 0, large by day 7;
* is smooth in space and time, like real forecast error. A wrong storm track
  puts the whole storm in the wrong place, not every grid point independently.
  Each error field is a random smooth pattern with a set size (correlation
  length) and lifetime (correlation time);
* is fixed for one issued forecast. Asking the same forecast the same question
  twice gives the same answer, and a forecast issued the next day has fresh
  error.

How the smooth patterns are made: each field is a sum of N random plane waves
(the "random Fourier features" method; Rahimi & Recht 2007). With wavenumbers
drawn from a normal distribution, the sum has unit variance and a Gaussian
correlation in space and time, and it costs N cosines per sample.

Error sizes (ErrorModel below). These are GUESSES, set to the order of
magnitude of published verification of global forecasts over the open ocean,
and not yet calibrated against archived forecasts for our route:

* 10 m wind: vector RMS error of about 1.5 m/s at analysis, 2 at day 1, 3 at
  day 3, 4.5 at day 5, 5.5 at day 7, flattening towards day 10 (the size of
  day-to-day weather itself). Order of magnitude from ECMWF's yearly
  verification reports, e.g. https://www.ecmwf.int/en/publications/
  (series "Evaluation of ECMWF forecasts").
* Surface current: RMS error of about 0.15 m/s per component even at analysis,
  growing slowly. Ocean models place eddies and Gulf Stream meanders only
  roughly. Order of magnitude from Mercator Ocean's drifter comparisons of
  the global 1/12 degree system, e.g. Lellouche et al. 2018,
  doi:10.5194/os-14-1093-2018.
* Wave height: about 10% at day 1, rising to 30% by day 7.

To calibrate later, compare archived forecasts (ECMWF open data, NOAA GFS and
WAVEWATCH III) with ERA5 along the route, and replace the tables.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import UTC, datetime

import numpy as np

from boatsim.oceandata.base import Environment
from boatsim.types import EnvState

KM_PER_DEG_LAT = 110.57
REF_LAT = 40.0  # longitudes are scaled by cos(40N) everywhere; fine for 25-60N


@dataclass(frozen=True)
class FieldError:
    """Error for one quantity: RMS size by lead time, plus pattern size and life."""

    lead_days: tuple[float, ...]
    sigma: tuple[float, ...]  # RMS error at each lead time (units of the field, or relative)
    length_km: float  # correlation length of the error pattern
    time_h: float  # correlation time of the error pattern
    relative: bool = False  # True: multiplicative (lognormal) error

    def at(self, lead_days: float) -> float:
        # Before the issue time (the past) the error is the analysis error.
        return float(np.interp(max(lead_days, 0.0), self.lead_days, self.sigma))


# Per-component sigma = vector RMS / sqrt(2).
_R2 = 1.0 / math.sqrt(2.0)
_WIND = FieldError(
    lead_days=(0, 1, 3, 5, 7, 10),
    sigma=tuple(v * _R2 for v in (1.5, 2.0, 3.0, 4.5, 5.5, 6.5)),  # GUESS, see module doc
    length_km=500.0,  # GUESS: weather-system scale
    time_h=24.0,  # GUESS
)
_CURRENT = FieldError(
    lead_days=(0, 3, 7, 10),
    sigma=(0.15, 0.18, 0.22, 0.25),  # m/s per component, GUESS
    length_km=100.0,  # GUESS: eddy and meander scale at these latitudes
    time_h=120.0,  # GUESS: eddies move slowly
)
_HS = FieldError(
    lead_days=(0, 1, 3, 5, 7, 10),
    sigma=(0.08, 0.10, 0.15, 0.22, 0.30, 0.35),  # relative, GUESS
    length_km=500.0,
    time_h=24.0,
    relative=True,
)
_TP = FieldError((0, 7), (0.08, 0.20), 500.0, 24.0, relative=True)  # GUESS
_GHI = FieldError((0, 1, 7), (0.15, 0.25, 0.45), 300.0, 12.0, relative=True)  # GUESS: clouds
_AIR = FieldError((0, 7), (0.7, 2.0), 500.0, 24.0)  # deg C, GUESS


@dataclass(frozen=True)
class ErrorModel:
    wind: FieldError = _WIND
    current: FieldError = _CURRENT
    hs: FieldError = _HS
    tp: FieldError = _TP
    ghi: FieldError = _GHI
    air_temp: FieldError = _AIR
    n_modes: int = 24  # plane waves per field; more = closer to Gaussian

    def scaled(self, factor: float) -> ErrorModel:
        """Same model with every error multiplied by factor (for sensitivity runs)."""

        def s(f: FieldError) -> FieldError:
            return FieldError(
                f.lead_days, tuple(x * factor for x in f.sigma), f.length_km, f.time_h, f.relative
            )

        return ErrorModel(
            s(self.wind),
            s(self.current),
            s(self.hs),
            s(self.tp),
            s(self.ghi),
            s(self.air_temp),
            self.n_modes,
        )


# Order of the random fields; wind and current have one field per component.
_NAMES = ("wind_u", "wind_v", "current_u", "current_v", "hs", "tp", "ghi", "air_temp")


def _spec(model: ErrorModel, name: str) -> FieldError:
    return getattr(model, name.split("_")[0] if name.startswith(("wind", "current")) else name)


class _Patterns:
    """Unit-variance smooth random fields, one per name, fixed by the rng."""

    def __init__(self, model: ErrorModel, rng: np.random.Generator):
        n, f = model.n_modes, len(_NAMES)
        length = np.array([_spec(model, nm).length_km for nm in _NAMES])[:, None]
        life = np.array([_spec(model, nm).time_h for nm in _NAMES])[:, None]
        # A Gaussian correlation exp(-r^2 / 2L^2) has wavenumbers ~ Normal(0, 1/L).
        self.kx = rng.normal(0.0, 1.0, (f, n)) / length
        self.ky = rng.normal(0.0, 1.0, (f, n)) / length
        self.w = rng.normal(0.0, 1.0, (f, n)) / life
        self.phase = rng.uniform(0.0, 2.0 * math.pi, (f, n))
        self.norm = math.sqrt(2.0 / n)

    def values(self, x_km: float, y_km: float, t_h: float) -> np.ndarray:
        arg = self.kx * x_km + self.ky * y_km + self.w * t_h + self.phase
        return self.norm * np.cos(arg).sum(axis=1)


class IssuedForecast:
    """One forecast, issued at t_issue. Behaves like an Environment."""

    def __init__(self, truth: Environment, t_issue: datetime, model: ErrorModel, seed: int):
        self.truth = truth
        self.t_issue = t_issue
        self.model = model
        # Same minute, same forecast. Naive times are UTC: .timestamp() alone would
        # read them as the machine's local time, and a browser's is the visitor's.
        key = int(t_issue.replace(tzinfo=t_issue.tzinfo or UTC).timestamp() // 60)
        self._p = _Patterns(model, np.random.default_rng([seed & 0xFFFFFFFF, key]))
        self._sig_cache: dict[float, np.ndarray] = {}

    def _sigmas(self, lead_days: float) -> np.ndarray:
        k = round(lead_days, 3)
        if k not in self._sig_cache:
            self._sig_cache[k] = np.array([_spec(self.model, n).at(k) for n in _NAMES])
        return self._sig_cache[k]

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        s = self.truth.sample(t, lat, lon)
        lead_h = (t - self.t_issue).total_seconds() / 3600.0
        x = lon * KM_PER_DEG_LAT * math.cos(math.radians(REF_LAT))
        y = lat * KM_PER_DEG_LAT
        e = self._p.values(x, y, lead_h) * self._sigmas(lead_h / 24.0)
        wu, wv, cu, cv, ehs, etp, eghi, eair = e

        def mult(value: float, err: float, sigma_name: str) -> float:
            # Lognormal with mean 1, so the error doesn't bias the average.
            sig = _spec(self.model, sigma_name).at(lead_h / 24.0)
            return value * math.exp(err - 0.5 * sig * sig)

        return EnvState(
            wind_u=s.wind_u + wu,
            wind_v=s.wind_v + wv,
            current_u=s.current_u + cu,
            current_v=s.current_v + cv,
            hs=mult(s.hs, ehs, "hs"),
            tp=mult(s.tp, etp, "tp"),
            wave_dir=s.wave_dir,
            ghi=mult(s.ghi, eghi, "ghi"),
            cloud_fraction=s.cloud_fraction,
            rain=s.rain,
            air_temp=s.air_temp + eair,
            ship_density=s.ship_density,
        )


@dataclass
class ErrorForecast:
    """Forecast.issue(t) -> truth plus error that grows with lead time.

    seed: change it to give a voyage a different but repeatable set of
    forecast errors. scale: multiply all errors (0 = perfect forecast,
    2 = twice as bad) for sensitivity runs.
    """

    truth: Environment
    seed: int = 0
    scale: float = 1.0
    model: ErrorModel = field(default_factory=ErrorModel)

    def issue(self, t_issue: datetime) -> Environment:
        if self.scale == 0:
            return self.truth
        model = self.model if self.scale == 1 else self.model.scaled(self.scale)
        return IssuedForecast(self.truth, t_issue, model, self.seed)
