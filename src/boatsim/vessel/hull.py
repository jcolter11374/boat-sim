"""Hull forces for the v4 kayak: water drag, wind on the hull, waves, fouling.

All SI. Forces in newtons, speeds in m/s. "x" is along the boat's heading
(positive forward), "y" is across it (positive to starboard, the right side).

What is modelled, and why it is this simple:

* Calm-water drag uses the ITTC-1957 friction line with a form factor and a flat
  wave-making allowance, as in the design doc. The kayak moves at a Froude
  number of about 0.16, well below hull speed, so wave-making stays small.
* Waves at sea are mostly far longer than a 3 m boat, so classical added-
  resistance formulas (written for ships) give near zero or nonsense. Instead
  rough water adds a fraction of the calm drag that grows with wave height and
  is worst head-on. The fraction is a GUESS tuned to the design doc's +60 %
  "rough water" allowance until the Bay trial measures it.
* Wind pushes on the parts above water (hull topsides and the dome). Each axis
  is treated on its own with a drag coefficient: the standard "windage" model.
* Sideways, the water resists with broadside drag on the hull and keel, plus
  lift from the keel fin once the boat is moving forward. That gives leeway:
  the sideways slip downwind. With no thrust the boat lies beam-on to the wind
  (GUESS) and drifts at a few percent of wind speed, the usual range for small
  craft in search-and-rescue leeway tables.
* Stokes drift: waves carry floating things slowly downwave. The ocean current
  products (GLORYS) do not include it, so it is added here.
* Weight (the mass link): the drag numbers above are for the boat at its
  reference weight (hull.displacement_ref_kg). Loaded heavier, it sinks deeper
  by the extra mass over (water density x waterplane area), which adds a band of
  wetted skin around the waterline; wave-making grows with displacement. Lighter
  works the other way. With no reference weight, or the weight at it, nothing
  changes. Waterline length, windage and sideways drag are held fixed (the
  changes are a few millimetres of draft).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

G = 9.81  # m/s^2
RHO_WATER = 1025.0  # kg/m^3, sea water
RHO_AIR = 1.225  # kg/m^3
NU_WATER = 1.19e-6  # m^2/s, sea water at 15 C (ITTC 7.5-02-01-03)


@dataclass(frozen=True)
class HullParams:
    """Numbers that define the hull. Defaults are the v4 design doc values."""

    waterline_length_m: float = 2.9  # design doc speed model
    wetted_area_m2: float = 1.9  # design doc, hull plus keel, bulb and rudder
    form_factor: float = 1.3  # design doc (1 + k)
    wave_making_frac: float = 0.15  # design doc
    # Optional "hull speed" wall for short, blunt hulls pushed hard (joke fleet): the
    # wave-making share grows by (Fn / wave_wall_fn)^wave_wall_exp, Fn the Froude
    # number on the waterline length. 0 = off (the kayak and Rev B/C never get near it).
    wave_wall_fn: float = 0.0
    wave_wall_exp: float = 4.0
    # Wind on the hull and dome (GUESS until measured):
    air_side_area_m2: float = 0.9  # topsides ~0.2 m x 3 m plus dome 0.2 m x 2.2 m
    air_front_area_m2: float = 0.25  # beam 0.79 m and dome 0.46 m, ~0.2 m high
    air_cd_side: float = 0.9  # GUESS, bluff low body
    air_cd_front: float = 0.7  # GUESS
    # Water resisting sideways motion (GUESS):
    lateral_cd_area_m2: float = 0.6  # Cd x area: hull 0.35 m^2, keel 0.16 m^2, rudder
    keel_lift_slope_area_m2: float = 0.75  # dCL/dalpha (~3.5/rad) x keel+rudder area
    # Rough-water added drag (GUESS, tuned to design doc "+60 % in rough water"):
    wave_drag_frac_per_m2: float = 0.16  # fraction of calm drag per (Hs in m)^2, head seas
    wave_drag_beam_factor: float = 0.65  # beam seas relative to head seas
    wave_drag_following_factor: float = 0.3  # following seas relative to head seas
    wave_drag_max_frac: float = 3.0  # cap so a storm doesn't produce absurd numbers
    # Fouling (GUESS: design doc allows +30 % by ~50 days with copper antifouling):
    fouling_onset_days: float = 0.0
    fouling_frac_per_day: float = 0.006
    fouling_max_frac: float = 1.0
    # Drift attitude: angle between heading and the wind's "towards" direction
    drift_heading_offset_deg: float = 90.0  # GUESS: lies beam-on to the wind
    stokes_drift: bool = True
    # Mass link (0 = off): waterplane area, and waterline girth per metre of
    # waterline length (both sides plus the ends' flare: a little over 2).
    waterplane_area_m2: float = 0.0
    waterline_girth_factor: float = 2.1  # GUESS

    @classmethod
    def from_config(cls, hull: dict) -> HullParams:
        """Build from the `hull:` block of a design YAML. Unknown keys are ignored.
        If hull.mass_kg differs from hull.displacement_ref_kg, the wetted area and
        wave-making are moved to that weight (see with_mass)."""
        fields = cls.__dataclass_fields__
        p = cls(**{k: v for k, v in hull.items() if k in fields})
        ref, mass = hull.get("displacement_ref_kg"), hull.get("mass_kg")
        if ref and mass is not None and mass != ref:
            p = p.with_mass(float(mass), float(ref))
        return p

    def with_mass(self, mass_kg: float, ref_kg: float) -> HullParams:
        """These drag numbers (worked out at ref_kg) moved to mass_kg."""
        if self.waterplane_area_m2 <= 0.0 or mass_kg == ref_kg:
            return self
        from dataclasses import replace

        sink = (mass_kg - ref_kg) / (RHO_WATER * self.waterplane_area_m2)  # m deeper
        girth = self.waterline_girth_factor * self.waterline_length_m
        area = max(self.wetted_area_m2 + girth * sink, 0.5 * self.wetted_area_m2)
        # Wave-making drag goes with displacement at a given speed; it is stored
        # as a fraction of friction drag, which goes with wetted area.
        wave = self.wave_making_frac * (mass_kg / ref_kg) * (self.wetted_area_m2 / area)
        return replace(self, wetted_area_m2=area, wave_making_frac=wave)


def ittc57_cf(speed: float, length: float) -> float:
    """ITTC-1957 model-ship correlation line, Cf = 0.075 / (log10 Re - 2)^2.

    Re is clamped at 1e5 so the line stays finite near zero speed, where the
    drag is tiny anyway.
    """
    re = max(abs(speed) * length / NU_WATER, 1e5)
    return 0.075 / (math.log10(re) - 2.0) ** 2


def calm_drag(p: HullParams, speed: float) -> float:
    """Clean-hull, calm-water drag in N at `speed` (signed: opposes motion)."""
    cf = ittc57_cf(speed, p.waterline_length_m)
    wave = p.wave_making_frac
    if p.wave_wall_fn > 0.0:
        fn = abs(speed) / math.sqrt(9.81 * p.waterline_length_m)
        wave *= 1.0 + (fn / p.wave_wall_fn) ** p.wave_wall_exp
    coeff = cf * p.form_factor * (1.0 + wave)
    return 0.5 * RHO_WATER * p.wetted_area_m2 * coeff * speed * abs(speed)


def fouling_frac(p: HullParams, days_at_sea: float) -> float:
    """Extra drag from weed and barnacles, as a fraction of clean drag."""
    grow = p.fouling_frac_per_day * max(0.0, days_at_sea - p.fouling_onset_days)
    return min(grow, p.fouling_max_frac)


def wave_drag_frac(p: HullParams, hs: float, wave_from_rel_deg: float) -> float:
    """Rough-water added drag as a fraction of calm drag.

    wave_from_rel_deg: direction the waves come FROM, relative to the bow
    (0 = head seas, 90 = beam seas, 180 = following seas).
    """
    if hs <= 0.0:
        return 0.0
    c = math.cos(math.radians(wave_from_rel_deg))
    # Smooth curve through head (1), beam (beam_factor) and following (following_factor).
    head, beam, foll = 1.0, p.wave_drag_beam_factor, p.wave_drag_following_factor
    direction = beam + 0.5 * (head - foll) * c + (0.5 * (head + foll) - beam) * c * c
    return min(p.wave_drag_frac_per_m2 * hs * hs * direction, p.wave_drag_max_frac)


def air_force(p: HullParams, apparent_x: float, apparent_y: float) -> tuple[float, float]:
    """Wind force on the hull in boat axes, from the wind relative to the boat.

    apparent_x/y: air velocity relative to the boat (m/s), x forward, y starboard.
    A tailwind has apparent_x > 0 and pushes the boat forward.
    """
    fx = 0.5 * RHO_AIR * p.air_cd_front * p.air_front_area_m2 * apparent_x * abs(apparent_x)
    fy = 0.5 * RHO_AIR * p.air_cd_side * p.air_side_area_m2 * apparent_y * abs(apparent_y)
    return fx, fy


def lateral_speed(p: HullParams, wind_rel_water_y: float, forward_speed: float) -> float:
    """Sideways speed through the water (leeway) where wind force balances water.

    wind_rel_water_y: wind across the boat relative to the water (m/s). The
    boat's own sideways speed v reduces the apparent wind to (w - v). Balance:
        Ka (w - v)|w - v| = Kw v|v| + Kl |u| v
    with Ka the air side term, Kw the broadside water drag and Kl the keel lift
    term at forward speed u. Solved exactly (a quadratic on the branch 0 <= v <= w).
    """
    w = wind_rel_water_y
    if w == 0.0:
        return 0.0
    sign = 1.0 if w > 0 else -1.0
    w = abs(w)
    ka = 0.5 * RHO_AIR * p.air_cd_side * p.air_side_area_m2
    kw = 0.5 * RHO_WATER * p.lateral_cd_area_m2
    kl = 0.5 * RHO_WATER * p.keel_lift_slope_area_m2 * abs(forward_speed)
    # (ka - kw) v^2 - (2 ka w + kl) v + ka w^2 = 0, take the root in [0, w].
    a = ka - kw
    b = -(2.0 * ka * w + kl)
    c = ka * w * w
    if abs(a) < 1e-12:
        v = -c / b
    else:
        disc = b * b - 4.0 * a * c
        # Numerically stable form of the smaller root.
        v = (2.0 * c) / (-b + math.sqrt(disc))
    return sign * min(max(v, 0.0), w)


def lateral_speed_with_force(
    p: HullParams, wind_rel_water_y: float, forward_speed: float, extra_force_y: float
) -> float:
    """lateral_speed() with an extra side force (N, to starboard) on the boat,
    such as a sail's. Same balance plus the extra term, solved by bisection
    (the net side force falls steadily as the sideways speed rises)."""
    if extra_force_y == 0.0:
        return lateral_speed(p, wind_rel_water_y, forward_speed)
    w = wind_rel_water_y
    ka = 0.5 * RHO_AIR * p.air_cd_side * p.air_side_area_m2
    kw = 0.5 * RHO_WATER * p.lateral_cd_area_m2
    kl = 0.5 * RHO_WATER * p.keel_lift_slope_area_m2 * abs(forward_speed)

    def net(v: float) -> float:
        r = w - v
        return ka * r * abs(r) + extra_force_y - kw * v * abs(v) - kl * v

    lo, hi = -1.0, 1.0
    while net(lo) < 0.0 and lo > -64.0:
        lo *= 2.0
    while net(hi) > 0.0 and hi < 64.0:
        hi *= 2.0
    for _ in range(60):
        mid = 0.5 * (lo + hi)
        if net(mid) > 0.0:
            lo = mid
        else:
            hi = mid
        if hi - lo < 1e-7:
            break
    return 0.5 * (lo + hi)


def stokes_drift(hs: float, tp: float, wave_from_deg: float) -> tuple[float, float]:
    """Surface Stokes drift (east, north) in m/s, toward where the waves go.

    Monochromatic estimate u = omega^3 a^2 / g with a^2 = Hs^2 / 8 (same energy
    as the sea state) and the mean period taken as 0.8 Tp (GUESS, typical for
    wind seas). For Hs 2 m and Tp 8 s this gives about 5 cm/s.
    """
    if hs <= 0.0 or tp <= 0.0:
        return 0.0, 0.0
    omega = 2.0 * math.pi / (0.8 * tp)
    u = omega**3 * hs * hs / (8.0 * G)
    to = math.radians(wave_from_deg + 180.0)
    return u * math.sin(to), u * math.cos(to)
