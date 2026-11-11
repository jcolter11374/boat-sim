"""A small velocity prediction program (VPP) for keelboats: stock vessels.

A VPP works out how fast a sailboat goes for each wind speed and wind angle.
The answer is a "polar": a table of boat speed by true wind speed (TWS) and
true wind angle (TWA, the angle between the bow and where the wind comes
from). We run it once, offline, and the simulator looks the table up
(vessel/keelboat.py), which is what real navigation software does.

At each wind speed, wind angle and boat speed the program balances:

* Sails. The wind the moving boat feels (the "apparent wind") makes lift,
  square to it, and drag, along it. We model the whole rig as one soft wing
  whose angle to the apparent wind (alpha) the trimmer chooses. Lift rises
  in a straight line to cl_max at alpha_stall, then the sail stalls and falls
  away to pure drag (cd_max) at 90 deg. Drag = cd0 + lift^2 / (pi x aspect
  ratio), the induced drag of a wing, with the sea surface as a mirror that
  doubles the rig's effective height. The sheet can't pull the sail closer
  than sheet_min_deg to the centreline, and the boom can't swing past 90 deg.
  Heeling tips the sails out of the wind: forces fall with cos^2(heel)
  (the usual "effective angle" approximation).
  Two depowering knobs, as in ORC's VPP: "flat" (lower lift for the same
  angle, flattening the sails) and reefing (smaller sails, the sail plans).
* Windage: drag of hull, mast and rigging in the apparent wind.
* Hull. Friction from the ITTC-1957 line (vessel/hull.py) times a form
  factor, plus wave-making ("residuary") resistance that rises steeply with
  Froude number (speed / sqrt(g x waterline)); heel adds a little. The keel's
  sideways lift, which stops the boat sliding sideways, costs induced drag
  (side force^2 / (dynamic pressure x pi x effective draft^2)).
* Heel. The sails' heeling moment equals the righting moment: weight x GZ
  (the stability lever) plus any crew sitting on the high side.

The free numbers that can't be looked up (cl_max, cd0 and the size of the
wave-making term) are fitted to a published polar: the ORC certificate's
speeds, with the certificate's crew on the rail. Taking the crew off then
gives the autopilot boat's polar, so the "crew factor" comes out of the
physics, not out of a guess. Downwind, the certificate assumes a
spinnaker; our boat sails main and jib only, so it is slower there, on
purpose.

numpy only (it runs in the browser too). `python -m boatsim.vessel.vpp
configs/stock_cruiser31.yaml` fits, checks and writes the polar file.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass, field, replace
from pathlib import Path

import numpy as np

from boatsim.vessel.hull import NU_WATER, RHO_AIR, RHO_WATER, G

KNOT = 0.514444
TWS_KN = (4, 6, 8, 10, 12, 14, 16, 20, 25, 30, 35, 40)
TWA_DEG = tuple(range(30, 181, 5))
ALPHAS = 16  # trim angles tried per point
FLATS = (1.0, 0.85, 0.7, 0.55)  # depowering: share of full lift
HEEL_ITERS = 14
SPEED_ITERS = 10
SCAN_TOP, SCAN_STEP = 9.0, 0.25  # m/s: 17.5 kn is far past this boat's speed


@dataclass(frozen=True)
class SailPlan:
    name: str
    main: float  # share of full mainsail area
    jib: float  # share of full jib area


@dataclass(frozen=True)
class VPPParams:
    """The `vpp:` block of a keelboat design YAML (configs/stock_*.yaml)."""

    disp_kg: float
    lwl_m: float
    wetted_m2: float
    main_m2: float
    jib_m2: float
    rig_height_m: float  # mast top above the water: sets the induced drag
    ce_height_m: float  # sails' centre of effort above the water, full sail
    clr_depth_m: float  # centre of lateral resistance below the water
    keel_te_m: float  # effective draft for the keel's induced drag
    keel_slope_area_m2: float  # keel + rudder + hull lift per radian of leeway
    gz_deg: tuple[float, ...]
    gz_m: tuple[float, ...]
    form_factor: float = 1.1
    rr_at_fn04: float = 0.03  # wave-making resistance / weight at Froude 0.40
    rr_exp: float = 7.0
    heel_drag_k: float = 0.5  # resistance x (1 + k sin^2 heel)
    waves_k: float = 0.0  # added resistance in the sea the wind raises (fitted)
    cl_max: float = 1.4
    cd0: float = 0.03
    cd_max: float = 1.3  # fully stalled sail, square to the wind
    alpha_stall_deg: float = 20.0
    sheet_min_deg: float = 12.0
    windage_cda_m2: float = 2.0
    heel_max_deg: float = 35.0  # beyond this the boat rounds up: not a sailing state
    autopilot_factor: float = 1.0  # speed lost to autopilot steering and set-and-forget trim
    crew_kg: float = 0.0
    crew_arm_m: float = 0.0
    plans: tuple[SailPlan, ...] = field(default_factory=lambda: (SailPlan("full", 1.0, 1.0),))

    @classmethod
    def from_config(cls, v: dict) -> VPPParams:
        fields = cls.__dataclass_fields__
        kw = {k: val for k, val in v.items() if k in fields and k not in ("plans", "gz")}
        gz = v["gz"]
        kw["gz_deg"] = tuple(float(a) for a in gz["deg"])
        kw["gz_m"] = tuple(float(x) for x in gz["m"])
        if "plans" in v:
            kw["plans"] = tuple(SailPlan(p["name"], p["main"], p["jib"]) for p in v["plans"])
        return cls(**kw)


def _resistance(p: VPPParams, v, heel, side, waves=0.0):
    """Hull resistance (N) at speed v (m/s), heel (rad) and side force (N),
    plus `waves` (N), the added resistance in the sea."""
    re = np.maximum(v * 0.7 * p.lwl_m / NU_WATER, 1e3)
    cf = 0.075 / (np.log10(re) - 2.0) ** 2
    rf = 0.5 * RHO_WATER * v * v * p.wetted_m2 * cf * p.form_factor
    fn = v / math.sqrt(G * p.lwl_m)
    rr = p.disp_kg * G * p.rr_at_fn04 * (fn / 0.4) ** p.rr_exp
    q = 0.5 * RHO_WATER * np.maximum(v, 0.05) ** 2
    ri = side * side / (q * math.pi * p.keel_te_m**2)
    return (rf + rr) * (1.0 + p.heel_drag_k * np.sin(heel) ** 2) + ri + waves


def _sail_coeffs(p: VPPParams, alpha, flat):
    """Lift and drag coefficients of the rig at trim angle alpha (rad)."""
    a_s = math.radians(p.alpha_stall_deg)
    clm = p.cl_max * flat
    ar = (2.0 * p.rig_height_m) ** 2 / (p.main_m2 + p.jib_m2)  # sea surface mirror
    attached = alpha <= a_s
    s = np.clip((alpha - a_s) / (math.pi / 2 - a_s), 0.0, 1.0)
    cl = np.where(attached, clm * alpha / a_s, clm * np.cos(s * math.pi / 2))
    cd_top = p.cd0 + clm**2 / (math.pi * ar)
    cd = np.where(
        attached,
        p.cd0 + cl * cl / (math.pi * ar),
        cd_top + (p.cd_max - cd_top) * np.sin(s * math.pi / 2),
    )
    return cl, cd


def pm_hs(tws: float) -> float:
    """Wave height (m) of a fully grown sea for a wind (m/s): Pierson and
    Moskowitz (1964), Hs = 0.21 U^2 / g. The fit sails in this sea, as ORC's VPP
    sails in a sea that grows with the wind."""
    return 0.21 * tws * tws / G


def added_resistance(p: VPPParams, hs: float, wave_rel_deg: float) -> float:
    """Added resistance (N) in waves of height hs coming from wave_rel_deg off
    the bow (0 = head on). Grows as height^2 (GUESS shape, size fitted); it is
    largest heading into the sea and small running with it."""
    if p.waves_k <= 0.0 or hs <= 0.0:
        return 0.0
    head = 0.5 * (1.0 + math.cos(math.radians(wave_rel_deg)))
    return p.waves_k * p.disp_kg * G * hs * hs * (0.15 + 0.85 * head)


def _heel(p: VPPParams, m0):
    """Heel (rad) where the sails' heeling moment m0 cos^3(heel) (m0 = upright
    moment, N m) equals the righting moment, by bisection up to the peak of
    the GZ curve. NaN where it can't balance: knocked down."""
    deg = np.asarray(p.gz_deg)
    gz = np.asarray(p.gz_m)
    top = math.radians(deg[int(np.argmax(gz))])
    w = p.disp_kg * G

    def excess(phi):
        c = np.cos(phi)
        right = w * np.interp(np.degrees(phi), deg, gz) + p.crew_kg * G * p.crew_arm_m * c
        return m0 * c**3 - right

    lo = np.zeros_like(m0)
    hi = np.full_like(m0, top)
    for _ in range(HEEL_ITERS):
        mid = 0.5 * (lo + hi)
        up = excess(mid) > 0
        lo = np.where(up, mid, lo)
        hi = np.where(up, hi, mid)
    return np.where(excess(np.full_like(m0, top)) > 0, np.nan, 0.5 * (lo + hi))


def _balance(p: VPPParams, plan: SailPlan, tws: float, twa: float, v: float, waves: float):
    """Net forward force (N) for every trim at boat speed v, with heel and
    side force: arrays over (flat, alpha). `waves` is the added resistance (N)."""
    awx = tws * math.cos(twa) + v
    awy = tws * math.sin(twa)
    aws = math.hypot(awx, awy)
    awa = math.atan2(awy, awx)
    area = p.main_m2 * plan.main + p.jib_m2 * plan.jib
    share = area / (p.main_m2 + p.jib_m2)
    lo = max(0.0, awa - math.pi / 2)
    hi = max(awa - math.radians(p.sheet_min_deg), lo)
    alpha = np.linspace(lo, hi, ALPHAS)[None, :]
    flat = np.asarray(FLATS)[:, None]
    cl, cd = _sail_coeffs(p, alpha, flat)
    q = 0.5 * RHO_AIR * aws * aws
    lift, drag = q * area * cl, q * area * cd
    drag = drag + q * p.windage_cda_m2
    drive0 = lift * math.sin(awa) - drag * math.cos(awa)
    heel0 = lift * math.cos(awa) + drag * math.sin(awa)
    arm = p.ce_height_m * math.sqrt(share) + p.clr_depth_m  # reefing lowers the sails
    heel = _heel(p, heel0 * arm)
    c = np.cos(heel)
    drive = drive0 * c * c
    side = heel0 * c * c * c
    net = drive - _resistance(p, v, heel, side, waves)
    net = np.where(np.isnan(heel) | (heel > math.radians(p.heel_max_deg)), -np.inf, net)
    return net, heel, side, alpha, flat


@dataclass(frozen=True)
class Point:
    speed: float  # m/s through the water
    heel_deg: float
    leeway_deg: float
    flat: float
    plan: str
    resist_n: float = 0.0  # hull resistance at this speed (= the sails' drive)
    r_exp: float = 2.0  # resistance grows as speed^r_exp here (for the sea penalty)
    m0_nm: float = 0.0  # the sails' heeling moment if the boat stood upright (gust capsize)


def solve(
    p: VPPParams, tws: float, twa_deg: float, plan: SailPlan, hs: float | None = None
) -> Point:
    """Steady boat speed for one wind and sail plan: the fastest speed at
    which the best trim still balances the forces. hs: wave height (m), from
    the wind's direction; None = the fully grown sea of that wind (pm_hs)."""
    twa = math.radians(twa_deg)
    if tws <= 0.0:
        return Point(0.0, 0.0, 0.0, 1.0, plan.name)
    waves = added_resistance(p, pm_hs(tws) if hs is None else hs, twa_deg)
    # Scan down from fast to slow for the fastest speed that still balances;
    # very slow speeds don't balance (the keel stalls), so a plain bisection
    # from zero would miss it.
    ok = lambda v: np.max(_balance(p, plan, tws, twa, v, waves)[0]) >= 0
    grid = np.arange(SCAN_TOP, 0.0, -SCAN_STEP)
    lo = next((float(v) for v in grid if ok(v)), 0.0)
    if lo == 0.0:
        return Point(0.0, 0.0, 0.0, 1.0, plan.name)
    hi = lo + SCAN_STEP
    for _ in range(SPEED_ITERS):
        mid = 0.5 * (lo + hi)
        if ok(mid):
            lo = mid
        else:
            hi = mid
    net, heel, side, _, flat = _balance(p, plan, tws, twa, lo, waves)
    i = np.unravel_index(int(np.argmax(net)), net.shape)
    h, sd = float(heel[i]), float(side[i])
    q = 0.5 * RHO_WATER * lo * lo
    leeway = math.degrees(sd / (q * p.keel_slope_area_m2))
    r0 = float(_resistance(p, lo, h, sd))
    r1 = float(_resistance(p, lo * 1.02, h, sd))
    share = (p.main_m2 * plan.main + p.jib_m2 * plan.jib) / (p.main_m2 + p.jib_m2)
    m0 = sd / math.cos(h) ** 3 * (p.ce_height_m * math.sqrt(share) + p.clr_depth_m)
    return Point(
        lo,
        math.degrees(h),
        min(leeway, 15.0),
        float(flat[i[0], 0]),
        plan.name,
        r0,
        math.log(r1 / r0) / math.log(1.02),
        m0,
    )


def beat(
    p: VPPParams, tws: float, plan: SailPlan, angles=range(30, 66, 2), hs: float | None = None
) -> tuple[float, float]:
    """Best upwind angle (deg) and the speed made straight upwind (VMG, m/s)."""
    best = (0.0, float(angles[0]))
    for a in angles:
        vmg = solve(p, tws, a, plan, hs).speed * math.cos(math.radians(a))
        if vmg > best[0]:
            best = (vmg, float(a))
    return best[1], best[0]


def polar(p: VPPParams, tws_kn=TWS_KN, twa_deg=TWA_DEG) -> dict:
    """The simulator's polar: flat water (it adds the real sea itself, with
    resist_n, r_exp and waves_k). Speed (kn), heel and leeway (deg) by plan,
    TWS and TWA, plus the best beat angle per TWS and plan. JSON-ready."""
    out = {"tws_kn": list(tws_kn), "twa_deg": list(twa_deg), "waves_k": p.waves_k}
    out["disp_kg"] = p.disp_kg
    out["crew_kg"], out["crew_arm_m"] = p.crew_kg, p.crew_arm_m
    out["gz"] = {"deg": list(p.gz_deg), "m": list(p.gz_m)}
    out["plans"] = {}
    for plan in p.plans:
        cols = {k: [] for k in ("speed_kn", "heel_deg", "leeway_deg", "resist_n", "r_exp", "m0_nm")}
        beats = []
        for w in tws_kn:
            row = [solve(p, w * KNOT, a, plan, 0.0) for a in twa_deg]
            cols["speed_kn"].append([round(x.speed * p.autopilot_factor / KNOT, 3) for x in row])
            cols["heel_deg"].append([round(x.heel_deg, 1) for x in row])
            cols["leeway_deg"].append([round(x.leeway_deg, 1) for x in row])
            cols["resist_n"].append([round(x.resist_n, 1) for x in row])
            cols["r_exp"].append([round(x.r_exp, 2) for x in row])
            cols["m0_nm"].append([round(x.m0_nm, 1) for x in row])
            beats.append(beat(p, w * KNOT, plan, hs=0.0)[0])
        out["plans"][plan.name] = {"main": plan.main, "jib": plan.jib, **cols, "beat_deg": beats}
    return out


# ------------------------------------------------- fitting to a published polar


def compare(p: VPPParams, ref: dict, tws_min: float = 0.0, tws_max: float = 99.0) -> list[dict]:
    """Model vs a reference speed table (the `orc:` block of the design file):
    rows with tws, what ("beat" or a TWA), reference and model speed (kn)."""
    rows = []
    full = p.plans[0]
    for j, w in enumerate(ref["tws_kn"]):
        if not tws_min <= w <= tws_max:
            continue
        _, vmg = beat(p, w * KNOT, full)
        rows.append({"tws": w, "what": "beat", "ref": ref["beat_vmg"][j], "model": vmg / KNOT})
        for a, speeds in ref["speeds"].items():
            v = solve(p, w * KNOT, float(a), full).speed / KNOT
            rows.append({"tws": w, "what": int(a), "ref": speeds[j], "model": v})
    return rows


def _nelder_mead(f, x0, step, iters=120):
    """Plain Nelder-Mead (no scipy in the browser build)."""
    n = len(x0)
    pts = [np.asarray(x0, float)]
    for i in range(n):
        x = np.asarray(x0, float).copy()
        x[i] += step[i]
        pts.append(x)
    vals = [f(x) for x in pts]
    for _ in range(iters):
        order = np.argsort(vals)
        pts = [pts[i] for i in order]
        vals = [vals[i] for i in order]
        c = np.mean(pts[:-1], axis=0)
        xr = c + (c - pts[-1])
        fr = f(xr)
        if fr < vals[0]:
            xe = c + 2 * (c - pts[-1])
            fe = f(xe)
            pts[-1], vals[-1] = (xe, fe) if fe < fr else (xr, fr)
        elif fr < vals[-2]:
            pts[-1], vals[-1] = xr, fr
        else:
            xc = c + 0.5 * (pts[-1] - c)
            fc = f(xc)
            if fc < vals[-1]:
                pts[-1], vals[-1] = xc, fc
            else:
                pts = [pts[0] + 0.5 * (x - pts[0]) for x in pts]
                vals = [f(x) for x in pts]
    i = int(np.argmin(vals))
    return pts[i], vals[i]


FIT_KEYS = ("cl_max", "cd0", "rr_at_fn04", "waves_k")


def fit(p: VPPParams, ref: dict, fit_angles=(52, 75, 90), iters: int = 80, log=print):
    """Fit cl_max, cd0 and rr_at_fn04 to the reference upwind and reaching
    speeds (with the reference's crew on the rail). Returns the fitted params."""
    sub = {**ref, "speeds": {a: ref["speeds"][a] for a in ref["speeds"] if int(a) in fit_angles}}

    def cost(x):
        if x[0] < 0.6 or not 0.015 <= x[1] < 0.2 or not 0.002 < x[2] < 0.2 or x[3] < 0:
            return 1e9
        q = replace(p, **dict(zip(FIT_KEYS, map(float, x), strict=True)))
        rows = compare(q, sub, 6, 20)
        return float(sum((r["model"] / r["ref"] - 1.0) ** 2 for r in rows))

    x0 = [getattr(p, k) for k in FIT_KEYS]
    x, c = _nelder_mead(cost, x0, [0.1, 0.005, 0.005, 0.002], iters)
    log(f"fit: {dict(zip(FIT_KEYS, np.round(x, 4).tolist(), strict=True))} cost {c:.4f}")
    return replace(p, **dict(zip(FIT_KEYS, map(float, x), strict=True)))


def report(rows: list[dict], log=print) -> float:
    """Print model / reference and return the worst relative error."""
    worst = 0.0
    for r in rows:
        e = r["model"] / r["ref"] - 1.0
        worst = max(worst, abs(e))
        log(
            f"  {r['tws']:>3} kn {r['what']!s:>5}: ref {r['ref']:5.2f} model {r['model']:5.2f} ({e:+.1%})"
        )
    return worst


def main(argv=None) -> None:
    import argparse

    import yaml

    ap = argparse.ArgumentParser(prog="python -m boatsim.vessel.vpp")
    ap.add_argument("design")
    ap.add_argument("--fit", action="store_true", help="refit cl_max, cd0, rr_at_fn04 first")
    ap.add_argument("--out", help="polar JSON (default: the design's vpp.polar_file)")
    a = ap.parse_args(argv)
    raw = yaml.safe_load(Path(a.design).read_text())
    v = raw["vpp"]
    ref = v.get("orc")
    solo = VPPParams.from_config(v)
    source = f"boatsim.vessel.vpp on {a.design}: no published polar to fit, all GUESS inputs"
    if ref:
        crewed = replace(solo, crew_kg=ref["crew_kg"], crew_arm_m=ref["crew_arm_m"])
        if a.fit:
            crewed = fit(crewed, ref)
        print("With the certificate's crew on the rail (fit, 8-20 kn):")
        worst = report(compare(crewed, ref, 8, 20))
        print(f"worst {worst:.1%}")
        solo = replace(crewed, crew_kg=0.0)
        print("Autopilot, nobody on the rail:")
        rows = compare(solo, ref, 6, 20)
        report(rows)
        ratios = [r["model"] / r["ref"] for r in rows if r["what"] in ("beat", 52, 75, 90)]
        print(f"crew factor upwind and reaching: {np.mean(ratios):.3f} (min {min(ratios):.3f})")
        source = (
            f"boatsim.vessel.vpp on {a.design}: fitted to the ORC certificate with its crew, "
            "then sailed with nobody on the rail (autopilot)"
        )
    out = Path(a.out or Path(a.design).parent / v["polar_file"])
    table = polar(solo)
    table["source"] = source
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(table, separators=(",", ":")) + "\n")
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
