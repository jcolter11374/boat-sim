"""Storm boost: put a hurricane's core back into ERA5 (issue #117).

ERA5's 0.25 degree grid (about 25 km) is coarser than a hurricane's core,
so near the eye it is far too weak (storms.py measures by how much). This
wrapper blends a textbook hurricane wind field into ERA5 close to each
best-track storm centre and raises the waves to match. Far from a storm,
and whenever it is switched off (the default), the environment is exactly
ERA5's: simulate() and every replay are unchanged.

Plain terms: "radius of maximum wind" (Rmax) is the distance from the eye to
the ring of strongest wind, typically 20-60 km. "Translation speed" is how
fast the storm itself moves across the sea.

Data: IBTrACS v04r01 North Atlantic (Knapp et al. 2010, BAMS 91, 363-376,
doi:10.1175/2009BAMS2755.1), National Hurricane Center columns USA_WIND
(1-minute sustained wind, knots), USA_PRES (central pressure, hPa), USA_RMW
(radius of maximum wind, nautical miles) and USA_SSHS (category).

Wind. A modified Rankine vortex (Hughes 1952, Depperman 1947): wind rises
in a straight line from the eye to Rmax, then falls as (Rmax / r)^DECAY
(DECAY 0.6, GUESS: observed storms run 0.4-0.7):
    V(r) = Vs * r / Rmax inside Rmax,  Vs * (Rmax / r)^DECAY outside
    Vs = 0.93 * Vmax - 0.55 * c, so that adding 0.55 * c (the storm's
    motion, c) back on puts the peak at the 10-minute best-track wind on the
    storm's right-hand side. 0.93 converts 1-minute to 10-minute wind
    (WMO/TD-1555); ERA5's hourly winds are close to 10-minute means.
    Inflow: surface winds spiral inward, INFLOW_DEG off the circle.
    Rmax missing: Willoughby, Darling and Rahn (2006, Mon. Wea. Rev. 134,
    1102-1120) eq. 7a, Rmax = 46.4 exp(-0.0155 Vmax + 0.0169 lat) km.
PROFILE = "holland" uses Holland (1980, Mon. Wea. Rev. 108, 1212-1218) in
its cyclostrophic form instead, V = Vs sqrt((Rmax/r)^B exp(1 - (Rmax/r)^B)),
B = rho e Vmax^2 / dp clipped to 1-2.5. It was the first choice, but the
buoy check (PR #215) found it far too broad: +12 m/s at 1-2 Rmax.
Blend: weight 1 inside 1 Rmax, falling linearly to 0 at 2 Rmax (the buoys
say ERA5 is already about right beyond 2 Rmax); the result is never weaker
than ERA5's own wind at that point.

Waves. Young (1988, J. Waterway Port Coastal Ocean Eng. 114(5), 637-652,
doi:10.1061/(ASCE)0733-950X(1988)114:5(637)) "equivalent fetch" model, as
restated in Young (2017, Atmosphere 8, 194, doi:10.3390/atmos8100194,
eqs. 5-7; coefficients checked against that review):
    x / R' = a Vmax^2 + b Vmax Vfm + c Vfm^2 + d Vmax + e Vfm + f
    R' = 22.5e3 log10(R) - 70.8e3   (R = Rmax in metres)
    g Hs_max / Vmax^2 = 0.0016 (g x / Vmax^2)^0.5
Peak period from the same review's fetch-limited energy-frequency relation
(its eq. 4, Donelan et al. 1992): g^2 E / U^4 = 6.365e-6 (fp U / g)^-3.3,
with E = Hs^2 / 16. Young fitted Vmax 20-60 m/s and Vfm 0-12 m/s; inputs
are clipped to that range. Hs then scales with local wind / peak wind (at a
fixed fetch Hs grows in proportion to the wind) and Tp with sqrt(Hs), and is
never below ERA5's. Hs_max is capped at HS_CAP_M (Maya, 11 Nov: keep it
capped so we don't overshoot); `python -m boatsim.oceandata.stormboost
check` compares both against NDBC buoys so HS_SCALE and the cap can be set
from data. Waves are OFF by default (BOOST_WAVES): on Dorian 2019 the buoys
read ERA5's waves near the core as slightly HIGH already (+0.7 m inside
1 Rmax), and Young's symmetric field added another 3-4 m. Those buoys are
on the shelf, where depth limits waves, so the deep-water answer is still
open; the code stays for when a deep-water check says otherwise.
"""

from __future__ import annotations

import bisect
import csv
import math
from contextlib import nullcontext
from dataclasses import dataclass, replace
from datetime import datetime
from pathlib import Path

from boatsim.oceandata.storms import DEFAULT_TRACKS, KNOT, ONE_TO_TEN_MIN
from boatsim.types import EnvState

G = 9.81
RHO_AIR = 1.15  # kg/m^3, near-surface air in a hurricane
NMI_KM = 1.852
ENV_PRES_HPA = 1010.0  # GUESS: pressure far from the storm, for the Holland B
B_DEFAULT = 1.3  # GUESS: when the pressure is missing or the drop is tiny
B_MIN, B_MAX = 1.0, 2.5  # Holland's range for real storms
INFLOW_DEG = 20.0  # GUESS: typical surface inflow angle (about 20-25 deg over sea)
MOTION_SHARE = 0.55  # GUESS: share of the storm's motion added to its winds
INNER, OUTER = 1.0, 2.0  # blend: full vortex inside 1 Rmax, ERA5 beyond 2 Rmax
PROFILE = "rankine"  # or "holland" (too broad on the buoys, see above)
DECAY = 0.6  # GUESS: Rankine fall-off beyond Rmax
BOOST_WAVES = False  # see the module doc
MIN_WIND_MS = 17.0  # tropical-storm strength (34 kt): weaker points are left to ERA5
MAX_GAP_H = 7.0  # interpolate only between fixes at most this far apart
YOUNG = (-2.175e-3, 1.506e-2, -1.223e-1, 2.190e-1, 6.737e-1, 7.980e-1)  # a..f
HS_SCALE = 1.0  # tune from the buoy check
HS_CAP_M = 16.0  # GUESS: about the biggest hurricane Hs NDBC buoys have logged
_EPOCH = datetime(1970, 1, 1)


def _num(s: str) -> float:
    try:
        return float(s)
    except (TypeError, ValueError):
        return math.nan


@dataclass
class Storm:
    """One storm's best-track fixes, in time order."""

    sid: str
    name: str
    t: list[float]  # seconds since 1970 (UTC)
    lat: list[float]
    lon: list[float]
    vmax: list[float]  # m/s, 1-minute
    pres: list[float]  # hPa, NaN if missing
    rmw: list[float]  # km, NaN if missing


def load_storms(csv_path, first_year: int = 1980, last_year: int = 2100) -> list[Storm]:
    """Tropical-storm-strength fixes (USA_SSHS >= 0) from an IBTrACS CSV.
    Plain csv module, so it also runs where pandas is missing."""
    storms: dict[str, Storm] = {}
    if isinstance(csv_path, (str, Path)):
        f = open(csv_path, encoding="utf-8")  # noqa: SIM115  closed by the with below
    else:
        f = nullcontext(csv_path)
    with f as f:
        rows = csv.DictReader(f)
        next(rows, None)  # the second row holds units
        for r in rows:
            season = _num(r.get("SEASON"))
            if not first_year <= season <= last_year:
                continue
            wind, cat = _num(r.get("USA_WIND")), _num(r.get("USA_SSHS"))
            lat, lon = _num(r.get("LAT")), _num(r.get("LON"))
            if not (cat >= 0 and wind * KNOT >= MIN_WIND_MS and math.isfinite(lat + lon)):
                continue
            t = (datetime.fromisoformat(r["ISO_TIME"].strip()) - _EPOCH).total_seconds()
            sid = r["SID"].strip()
            s = storms.get(sid)
            if s is None:
                s = storms[sid] = Storm(sid, r.get("NAME", "").strip(), [], [], [], [], [], [])
            if s.t and t <= s.t[-1]:
                continue
            p, rm = _num(r.get("USA_PRES")), _num(r.get("USA_RMW"))
            s.t.append(t)
            s.lat.append(lat)
            s.lon.append(lon)
            s.vmax.append(wind * KNOT)
            s.pres.append(p if p > 800 else math.nan)
            s.rmw.append(rm * NMI_KM if rm > 0 else math.nan)
    return list(storms.values())


@dataclass(frozen=True)
class Fix:
    """A storm at one moment, interpolated between best-track fixes."""

    lat: float
    lon: float
    vmax: float  # m/s, 1-minute
    rmax_km: float
    b: float
    cu: float  # m/s, storm motion east
    cv: float  # m/s, storm motion north


def willoughby_rmax_km(vmax: float, lat: float) -> float:
    return 46.4 * math.exp(-0.0155 * vmax + 0.0169 * abs(lat))


def holland_b(vmax: float, pres_hpa: float) -> float:
    dp = (ENV_PRES_HPA - pres_hpa) * 100.0
    if not dp > 500.0:  # missing, or under 5 hPa
        return B_DEFAULT
    return min(max(RHO_AIR * math.e * vmax**2 / dp, B_MIN), B_MAX)


def _lerp(a: float, b: float, w: float) -> float:
    if math.isnan(a):
        return b
    if math.isnan(b):
        return a
    return a + (b - a) * w


def storm_at(s: Storm, secs: float) -> Fix | None:
    """Storm s at time secs, or None outside its track or across a gap."""
    i = bisect.bisect_right(s.t, secs) - 1
    if i < 0 or i >= len(s.t) - 1:
        if i == len(s.t) - 1 and s.t[i] == secs and i > 0:
            i -= 1  # exactly on the last fix: use the last segment
        else:
            return None
    dt = s.t[i + 1] - s.t[i]
    if dt > MAX_GAP_H * 3600.0:
        return None
    w = (secs - s.t[i]) / dt
    lat = s.lat[i] + (s.lat[i + 1] - s.lat[i]) * w
    lon = s.lon[i] + (s.lon[i + 1] - s.lon[i]) * w
    vmax = s.vmax[i] + (s.vmax[i + 1] - s.vmax[i]) * w
    rmax = _lerp(s.rmw[i], s.rmw[i + 1], w)
    if math.isnan(rmax):
        rmax = willoughby_rmax_km(vmax, lat)
    pres = _lerp(s.pres[i], s.pres[i + 1], w)
    cv = (s.lat[i + 1] - s.lat[i]) * 111.0e3 / dt
    cu = (s.lon[i + 1] - s.lon[i]) * 111.0e3 * math.cos(math.radians(lat)) / dt
    return Fix(lat, lon, vmax, rmax, holland_b(vmax, pres), cu, cv)


def young_hs_tp(v10max: float, vfm: float, rmax_km: float) -> tuple[float, float]:
    """Young (1988) peak significant wave height (m) and peak period (s)."""
    v = min(max(v10max, 20.0), 60.0)
    c = min(max(vfm, 0.0), 12.0)
    a, b, cc, d, e, f = YOUNG
    ratio = a * v * v + b * v * c + cc * c * c + d * v + e * c + f
    r_prime = 22.5e3 * math.log10(max(rmax_km, 5.0) * 1e3) - 70.8e3
    x = max(ratio, 0.5) * max(r_prime, 1e3)
    hs = 0.0016 * math.sqrt(G * x / v**2) * v**2 / G
    eps = G * G * (hs * hs / 16.0) / v**4
    nu = (eps / 6.365e-6) ** (-1.0 / 3.3)  # fp * U / g
    tp = v / (G * nu)
    hs *= min(v10max / v, 1.0)  # below Young's range: Hs in proportion to the wind
    return min(hs * HS_SCALE, HS_CAP_M), tp


@dataclass(frozen=True)
class Boost:
    """What the vortex adds at one point: blend weight, wind and waves."""

    weight: float
    wind_u: float
    wind_v: float
    hs: float
    tp: float


@dataclass(frozen=True)
class Shape:
    """The knobs the buoy check sweeps (module constants are the defaults)."""

    core: float = 1.0  # vortex Rmax = core x best-track Rmax
    inner: float = 1.0  # full vortex inside inner x best-track Rmax
    outer: float = 2.0  # ERA5 alone beyond outer x best-track Rmax
    peak: float = 1.0  # x the 10-minute best-track wind


SHAPE = Shape(inner=INNER, outer=OUTER)
# Shapes the buoy check also scores (round 2, Maya: smaller core, blend inside
# 1.5 Rmax, no worse than ERA5 in any band). Names: c<core>_o<outer>_p<peak>.
SWEEP = {
    f"c{c:g}_o{o:g}_p{pk:g}": Shape(core=c, inner=1.0, outer=o, peak=pk)
    for c in (1.0, 0.8, 0.65)
    for o in (2.0, 1.5)
    for pk in (1.0, 0.9, 0.8)
}


def vortex(fx: Fix, lat: float, lon: float, shape: Shape | None = None) -> Boost | None:
    """The parametric storm's wind and waves at (lat, lon), or None beyond OUTER Rmax."""
    sh = shape or SHAPE
    dy = (lat - fx.lat) * 111.0
    dx = (lon - fx.lon) * 111.0 * math.cos(math.radians(fx.lat))
    r = math.hypot(dx, dy)
    if r >= sh.outer * fx.rmax_km:
        return None
    w = 1.0 if r <= sh.inner * fx.rmax_km else (sh.outer - r / fx.rmax_km) / (sh.outer - sh.inner)
    r = max(r, 0.5)
    rmax = sh.core * fx.rmax_km
    c = math.hypot(fx.cu, fx.cv)
    v10max = ONE_TO_TEN_MIN * fx.vmax
    vs = max(sh.peak * v10max - MOTION_SHARE * c, 0.0)
    if PROFILE == "holland":
        x = (rmax / r) ** fx.b
        speed = vs * math.sqrt(x * math.exp(1.0 - x))
    elif r <= rmax:
        speed = vs * r / rmax
    else:
        speed = vs * (rmax / r) ** DECAY
    # Northern hemisphere: anticlockwise, spiralling in by the inflow angle.
    a = math.radians(INFLOW_DEG)
    tu, tv = -dy / r, dx / r  # tangential (anticlockwise)
    ru, rv = dx / r, dy / r  # outward
    u = speed * (math.cos(a) * tu - math.sin(a) * ru) + MOTION_SHARE * fx.cu
    v = speed * (math.cos(a) * tv - math.sin(a) * rv) + MOTION_SHARE * fx.cv
    hs_max, tp_max = young_hs_tp(v10max, c, fx.rmax_km)
    share = min(math.hypot(u, v) / max(v10max, 1.0), 1.0)
    hs = hs_max * share
    return Boost(w, u, v, hs, tp_max * math.sqrt(share))


class StormTracks:
    """Storms indexed by 6-hour slot, so a sample far from any storm costs one
    dict lookup."""

    SLOT = 21600.0

    def __init__(self, storms: list[Storm]):
        self.storms = storms
        self._slots: dict[int, list[Storm]] = {}
        for s in storms:
            for i in range(len(s.t) - 1):
                if s.t[i + 1] - s.t[i] > MAX_GAP_H * 3600.0:
                    continue
                for k in range(int(s.t[i] // self.SLOT), int(s.t[i + 1] // self.SLOT) + 1):
                    lst = self._slots.setdefault(k, [])
                    if not lst or lst[-1] is not s:
                        lst.append(s)

    @classmethod
    def from_csv(cls, csv_path=DEFAULT_TRACKS, first_year: int = 1980, last_year: int = 2100):
        return cls(load_storms(csv_path, first_year, last_year))

    def boost(
        self, t: datetime, lat: float, lon: float, shape: Shape | None = None
    ) -> Boost | None:
        """The strongest-weighted storm's boost at (t, lat, lon), or None."""
        secs = (t.replace(tzinfo=None) - _EPOCH).total_seconds()
        best = None
        for s in self._slots.get(int(secs // self.SLOT), ()):
            fx = storm_at(s, secs)
            if fx is None:
                continue
            b = vortex(fx, lat, lon, shape)
            if b is not None and (best is None or b.weight > best.weight):
                best = b
        return best


def _from_deg(u: float, v: float) -> float:
    """Direction the wind (and so the wind sea) comes FROM, degrees true."""
    return math.degrees(math.atan2(-u, -v)) % 360.0


def apply(e: EnvState, b: Boost | None) -> EnvState:
    """ERA5's state with the storm blended in. Never weaker than ERA5."""
    if b is None:
        return e
    w = b.weight
    u = w * b.wind_u + (1 - w) * e.wind_u
    v = w * b.wind_v + (1 - w) * e.wind_v
    if math.hypot(u, v) < math.hypot(e.wind_u, e.wind_v):
        u, v = e.wind_u, e.wind_v
    hs, tp, wave_dir = e.hs, e.tp, e.wave_dir
    boosted_hs = w * b.hs + (1 - w) * e.hs
    if BOOST_WAVES and boosted_hs > e.hs:
        hs = boosted_hs
        tp = max(e.tp, w * b.tp + (1 - w) * e.tp)
        if w >= 0.5:  # GUESS: inside the core the sea runs with the wind
            wave_dir = _from_deg(u, v)
    return replace(e, wind_u=u, wind_v=v, hs=hs, tp=tp, wave_dir=wave_dir)


class StormBoost:
    """Environment wrapper: env.sample() with hurricane cores put back in.

    Every other attribute is the wrapped environment's."""

    def __init__(self, env, tracks: StormTracks):
        self.env = env
        self.tracks = tracks

    def sample(self, t: datetime, lat: float, lon: float) -> EnvState:
        return apply(self.env.sample(t, lat, lon), self.tracks.boost(t, lat, lon))

    def __getattr__(self, name):
        return getattr(self.__dict__["env"], name)


_TRACKS: dict[str, StormTracks] = {}


def default_storm_tracks(path=DEFAULT_TRACKS) -> StormTracks:
    """The IBTrACS file the batch workflows download, read once per process.
    Missing file: an error, since asking for the boost and silently not
    getting it would be worse."""
    key = str(path)
    if key not in _TRACKS:
        if not Path(path).exists():
            raise FileNotFoundError(
                f"storm boost needs the IBTrACS tracks at {path} (the batch workflows download it)"
            )
        _TRACKS[key] = StormTracks.from_csv(path)
    return _TRACKS[key]


# ------------------------------------------------- check against NDBC buoys

CASES = {
    # storm season, IBTrACS name, buoys it passed near (NDBC station ids)
    "paulette2020": (2020, "PAULETTE", ("41048", "41049", "41047")),  # over Bermuda, Sept 2020
    "dorian2019": (2019, "DORIAN", ("41010", "41004", "41025")),  # up the US coast, Sept 2019
}
BANDS = ((0.0, 1.0), (1.0, 2.0), (2.0, 3.0), (3.0, 6.0))  # distance in Rmax units


def _sample(src, t: datetime, lat: float, lon: float) -> EnvState:
    w = src.sample(t, lat, lon)
    f = {k: w[k] if math.isfinite(w[k]) else 0.0 for k in ("wind_u", "wind_v", "hs", "tp")}
    return EnvState(wave_dir=w["wave_dir"] if math.isfinite(w["wave_dir"]) else 0.0, **f)


def pair_case(storm: Storm, buoy_hours, src, lat: float, lon: float, station: str) -> list[dict]:
    """One row per buoy hour while the storm is on its track: distance in km
    and in Rmax, buoy, ERA5 and boosted ERA5 wind (10 m) and Hs."""
    tracks = StormTracks([storm])
    rows = []
    for t, ws, hs in buoy_hours:
        secs = (t - _EPOCH).total_seconds()
        fx = storm_at(storm, secs)
        if fx is None:
            continue
        dy = (lat - fx.lat) * 111.0
        dx = (lon - fx.lon) * 111.0 * math.cos(math.radians(fx.lat))
        r = math.hypot(dx, dy)
        e = _sample(src, t, lat, lon)
        b = apply(e, tracks.boost(t, lat, lon))
        sweep = {
            f"sweep_{k}_ws10": math.hypot(bb.wind_u, bb.wind_v)
            for k, sh in SWEEP.items()
            for bb in [apply(e, tracks.boost(t, lat, lon, sh))]
        }
        rows.append(
            {
                "station": station,
                "time": t.isoformat(timespec="minutes"),
                "dist_km": r,
                "dist_rmax": r / fx.rmax_km,
                "rmax_km": fx.rmax_km,
                "vmax_ms": fx.vmax,
                "buoy_ws10": ws,
                "era5_ws10": math.hypot(e.wind_u, e.wind_v),
                "boost_ws10": math.hypot(b.wind_u, b.wind_v),
                "buoy_hs": hs,
                "era5_hs": e.hs,
                "boost_hs": b.hs,
                **sweep,
            }
        )
    return rows


def _bias_rms(obs, mod) -> tuple[int, float, float]:
    d = [m - o for o, m in zip(obs, mod, strict=True) if math.isfinite(o) and math.isfinite(m)]
    if not d:
        return 0, math.nan, math.nan
    return len(d), sum(d) / len(d), math.sqrt(sum(x * x for x in d) / len(d))


def summarise_check(rows: list[dict], log=print) -> list[dict]:
    """Bias and RMS error of ERA5 and boosted ERA5 against the buoys, by
    distance band (in Rmax), for wind and Hs; plus each buoy's peaks."""
    out = []
    log("distance   what  n    ERA5 bias/RMS    boosted bias/RMS   (model - buoy)")
    for lo, hi in BANDS:
        band = [r for r in rows if lo <= r["dist_rmax"] < hi]
        for what, unit in (("ws10", "m/s"), ("hs", "m")):
            obs = [r[f"buoy_{what}"] for r in band]
            n, eb, er = _bias_rms(obs, [r[f"era5_{what}"] for r in band])
            _, bb, br = _bias_rms(obs, [r[f"boost_{what}"] for r in band])
            out.append(
                {
                    "band_rmax": f"{lo:g}-{hi:g}",
                    "field": what,
                    "n": n,
                    "era5_bias": eb,
                    "era5_rms": er,
                    "boost_bias": bb,
                    "boost_rms": br,
                }
            )
            log(
                f"{lo:g}-{hi:g} Rmax  {what:4s} {n:4d}  {eb:+6.2f} / {er:5.2f} {unit:3s}"
                f"   {bb:+6.2f} / {br:5.2f} {unit}"
            )
    sweep_keys = [k for k in SWEEP if rows and f"sweep_{k}_ws10" in rows[0]]
    if sweep_keys:
        log("wind RMS (bias) by band for other shapes; ERA5 first:")
        log("shape" + "".join(f"  {lo:g}-{hi:g} Rmax     " for lo, hi in BANDS))
        for name, col in [("ERA5", "era5_ws10")] + [(k, f"sweep_{k}_ws10") for k in sweep_keys]:
            cells = []
            for lo, hi in BANDS:
                band = [r for r in rows if lo <= r["dist_rmax"] < hi]
                _, b, rms = _bias_rms([r["buoy_ws10"] for r in band], [r[col] for r in band])
                cells.append(f"  {rms:5.2f} ({b:+5.2f})  ")
            log(f"{name:5s}" + "".join(cells))
    for st in sorted({r["station"] for r in rows}):
        s = [r for r in rows if r["station"] == st]

        def peak(k, s=s):
            v = [r[k] for r in s if math.isfinite(r[k])]
            return max(v) if v else math.nan

        log(
            f"{st}: closest {min(r['dist_km'] for r in s):.0f} km; peak wind buoy "
            f"{peak('buoy_ws10'):.1f} ERA5 {peak('era5_ws10'):.1f} boosted "
            f"{peak('boost_ws10'):.1f} m/s; peak Hs buoy {peak('buoy_hs'):.1f} ERA5 "
            f"{peak('era5_hs'):.1f} boosted {peak('boost_hs'):.1f} m"
        )
    return out


def run_check(csv_path, cases=CASES, workers: int = 4, log=print) -> tuple[list[dict], list[dict]]:
    """Fetch ERA5 and the buoys for each case and compare (GitHub Actions only)."""
    from datetime import timedelta

    from boatsim.oceandata import buoys as BY
    from boatsim.oceandata import era5 as E

    pos = BY.parse_station_table(BY.fetch_text(BY.STATION_TABLE_URL))
    rows: list[dict] = []
    for key, (season, name, stations) in cases.items():
        storms = [s for s in load_storms(csv_path, season, season) if s.name.upper() == name]
        if not storms:
            log(f"{key}: {name} {season} not in the tracks")
            continue
        s = storms[0]
        t0 = _EPOCH + timedelta(seconds=s.t[0])
        t1 = _EPOCH + timedelta(seconds=s.t[-1])
        log(f"{key}: {len(s.t)} fixes {t0:%Y-%m-%d} to {t1:%Y-%m-%d}; fetching ERA5")
        E.fetch_days(E.days_between(t0.date(), t1.date() + timedelta(days=1)), workers=workers)
        src = E.ERA5Source(max_tiles=3)
        for sid in stations:
            if sid not in pos:
                log(f"  {sid}: no position in the station table, skipped")
                continue
            try:
                df = BY.parse_stdmet(BY.fetch_text(BY.STDMET_URL.format(station=sid, year=season)))
            except Exception as e:  # noqa: BLE001  a missing buoy-year is normal; report and go on
                log(f"  {sid}: no {season} data ({e!r})"[:160])
                continue
            h = BY.hourly(df[(df.time >= t0) & (df.time <= t1 + timedelta(hours=1))])
            hours = [
                (t.to_pydatetime(), BY.to_10m(ws), hs)
                for t, ws, hs in zip(h.index, h.wspd, h.wvht, strict=True)
            ]
            got = pair_case(s, hours, src, *pos[sid], station=f"{key}:{sid}")
            log(f"  {sid}: {len(got)} hours paired")
            rows += got
    return rows, summarise_check(rows, log=log)


def main(argv=None) -> None:
    import argparse

    p = argparse.ArgumentParser(prog="python -m boatsim.oceandata.stormboost")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("check", help="ERA5 and boosted ERA5 vs NDBC buoys in Paulette and Dorian")
    c.add_argument("ibtracs_csv")
    c.add_argument("--workers", type=int, default=4)
    c.add_argument("--out", default="runs/stormboost")
    a = p.parse_args(argv)
    rows, table = run_check(a.ibtracs_csv, workers=a.workers)
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for fname, data in (("pairs.csv", rows), ("by_distance.csv", table)):
        if data:
            with open(out / fname, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=list(data[0]))
                w.writeheader()
                w.writerows(data)
    print(f"wrote {out}/")


if __name__ == "__main__":
    main()
