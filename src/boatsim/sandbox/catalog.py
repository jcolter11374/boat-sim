"""Sam's parts catalog (build-plan/parts-catalog.json) mapped onto the simulator.

A sandbox design is the catalog's slot id -> option id, plus the cruise power in
watts (10 to 30). Every option is mapped as a change from the v4 kayak as it
stands, so the default choice in every slot is exactly configs/v4_kayak.yaml
(test: the default build patches nothing).

Each option says what it does in the simulator:

* ``wired``: it changes the design the simulator runs.
* ``no effect yet``: it is in the catalog but the simulator doesn't model it yet
  (the page shows it greyed with that label, rather than hiding it).
* ``fixed``: only one option, nothing to choose.

and whether the numbers behind it are ``est`` (estimated: a GUESS in a design
file, scaled or borrowed, or engineering judgement) or measured (datasheet,
published data, a test, or arithmetic on those). An option is estimated if any
sim field it sets is. ``basis`` says why, in a few words.

Only the fields the simulator needs are copied from the catalog; prices,
masses and part names stay in Sam's file.
"""

from __future__ import annotations

from dataclasses import dataclass

from boatsim.config import Design, load_design, patched_design

KAYAK = "configs/v4_kayak.yaml"
CRUISE_W = (10, 15, 20, 25, 30)
DEFAULT_CRUISE_W = 25

# Daily energy the catalog lists for the two parts with a choice (Wh/day). The
# kayak's hotel_load_wh_per_day (85, design doc) includes the defaults, so other
# options change it by the difference.
BASE_BRAIN_WH = 31
BASE_AIS_WH = 36


@dataclass(frozen=True)
class Option:
    changes: tuple = ()  # (section, key, value); hotel load and weight are added up separately
    effect: str = "wired"  # wired | no effect yet | fixed
    est: bool = False
    basis: str = ""
    wh: float | None = None  # brain/AIS daily energy (catalog), for the hotel load
    kg: float = 0.0  # weight against the default option (catalog), for the mass link
    hotel_wh: float = 0.0  # extra daily energy (Wh/day) for parts with no catalog figure
    cost: float = 0.0  # price against the default option, USD (parts list), for the page


def _thr(n: int, kg: float = 0.0) -> Option:
    return Option(
        (("propulsion", "thruster_count", n), ("propulsion", "max_drive_w", 50 * n)),
        basis="Blue Robotics T200 datasheet, 50 W burst each",
        kg=kg,
    )


def _no_effect(why: str) -> Option:
    return Option(effect="no effect yet", basis=why)


MPPT_BASIS = "weight only: charge-controller failure isn't modelled yet"
BULB_BASIS = "weight from the catalog; how a lighter bulb rights the boat is a GUESS"
# GUESS: the bulb's righting moment goes with its weight, and the odds of
# staying upside down after a knockdown with the square of the shortfall.
P_STUCK_40KG = round(4.0e-5 * (50 / 40) ** 2, 9)

# --- Drive: a wing sail on the kayak ------------------------------------------
# A free-rotating wing with a tail flap, the Randolph team's design (vessel/sail.py)
# scaled up for a 3 m kayak. All GUESSes until one is built and weighed:
# 2.0 m span x 0.5 m chord on a mast, its centre of effort 1.3 m up. The righting
# moment at 25 deg heel: 129 kg x g x GZ ~0.2 m (50 kg bulb 0.9 m down, plus the
# hull's own form stability) = ~250 N m.
KAYAK_WING = {
    "area_m2": 1.0,
    "aspect_ratio": 5.0,
    "cd0": 0.012,
    "max_alpha_deg": 20,
    "ce_height_m": 1.3,
    "heel_arm_m": 1.5,
    "max_heel_moment_nm": 250.0,
    "storm_wind_ms": 20,
    "storm_run_twa_deg": 140,
    "min_upwind_twa_deg": 50,
    "min_downwind_twa_deg": 165,
    "tack_hysteresis_deg": 20,
    "unsteered_twa_deg": 110,
}
WING_KG = 6.0  # GUESS: carbon tube mast, foam-and-glass wing, tail and servo
WING_WH = 5.0  # GUESS: tail-flap servo, Wh/day
# GUESS: rig damage per knockdown at Hs 3 m. Randolph's published 0.003 is, by
# their own account (#153), too high for the hundreds of knockdowns real seas
# give; we take a sixth of it until they re-tune.
WING_P_BREAK = 5.0e-4
_WING = (
    *(("sail", k, v) for k, v in KAYAK_WING.items()),
    ("hazards", "p_part", {"sail": WING_P_BREAK}),
    # Rudder servo plus tail servo (Randolph's table: 0.002 each).
    ("hazards", "steering_per_day", 0.004),
)
WING_BASIS = "wing scaled from Randolph's Rev B; size, weight and breakage are GUESSes"
T200_KG = 0.45  # one thruster, as the thr slot's one-t200 option

# --- Hull material ---------------------------------------------------------------
# The as-built kayak is rotomoulded polyethylene: tough, flexes rather than cracks,
# and is foam-filled. Every material keeps the foam, so a hole still can't sink it.
# GUESSES all (no fleet data per material): hull weight from typical 10 ft hulls
# (~20 kg in PE), leaks from fittings and cracks relative to PE, and the share of
# ship strikes that end the voyage.
LEAK = 0.0025  # planning set's leak_per_day for the as-built hull


def _material(kg: float, leak: float, strike: float, basis: str, *extra) -> Option:
    return Option(
        (
            ("hazards", "leak_per_day", round(LEAK * leak, 6)),
            ("hazards", "p_lost_given_strike", strike),
            *extra,
        ),
        est=True,
        basis=basis,
        kg=kg,
    )


# --- Hull shape -------------------------------------------------------------------
# Sizes agreed with Iris (the 3D models), 10 Nov 2026; each carries today's kit.
# Every drag, windage and hazard number below is a GUESS scaled from the kayak
# (configs/v4_kayak.yaml) by area and shape; mass is each shape's own, so its
# drag numbers are for that weight (displacement_ref_kg) and only other options'
# weight goes through the mass link. Displacement checked: volume below the
# waterline x ~0.6 block coefficient x seawater ~= mass.
KAYAK_KG = 123.0


def _shape(kg: float, hull: dict, hazards: dict, basis: str, other: tuple = ()) -> Option:
    return Option(
        (
            *(("hull", k, v) for k, v in {**hull, "displacement_ref_kg": kg}.items()),
            *(("hazards", k, v) for k, v in hazards.items()),
            *other,
        ),
        est=True,
        basis=basis,
        kg=kg - KAYAK_KG,
    )


SHAPES = {
    # Two 3.0 x 0.30 m hulls 1.30 m apart (1.60 m overall), 140 kg, 0.16 m draft,
    # bridge deck with the electronics pod and panels. No rudder (differential
    # thrust) and no keel. Very stiff but not self-righting: a capsize is final.
    "cat": _shape(
        140.0,
        {
            "length_m": 3.0,
            "beam_m": 1.6,
            "waterline_length_m": 2.9,
            "wetted_area_m2": 3.0,  # two hulls, (0.30 + 2 x 0.16) m girth x 0.85
            "form_factor": 1.2,  # slender hulls
            "wave_making_frac": 0.08,  # slender hulls make smaller waves
            "waterplane_area_m2": 1.3,  # 2 x 2.9 x 0.30 x 0.75
            "waterline_girth_factor": 4.2,  # two waterlines
            "air_side_area_m2": 1.0,  # two hulls' topsides plus the bridge-deck pod
            "air_front_area_m2": 0.5,
            "lateral_cd_area_m2": 0.9,  # two hulls broadside, no keel
            "keel_lift_slope_area_m2": 0.3,  # hulls only: more leeway than the kayak
            "wave_drag_frac_per_m2": 0.12,
            "wave_drag_beam_factor": 0.5,
            "self_righting_dome": False,
            "keel_bulb_kg": 0,
        },
        {
            "hull_length_m": 3.0,
            "hull_beam_m": 1.6,  # it takes a ~1.9 m breaker to roll it
            "p_capsize_stays_over": 0.5,  # GUESS: half the breakers that roll it past ~70 deg
            "p_part": {"rudder": 0.0},
            "steering_per_day": 0.0,  # no rudder servo
        },
        "GUESS: twin hulls scaled from the kayak; not self-righting, so a capsize ends it",
        (("propulsion", "rudder", False),),
    ),
    # 3.2 x 0.50 m hull riding low (0.18 m draft, 0.10 m freeboard), 175 kg with
    # 35 kg of lead, a 0.55 m buoyant tower. Waves wash over the deck panels.
    "semisub": _shape(
        175.0,
        {
            "length_m": 3.2,
            "beam_m": 0.5,
            "waterline_length_m": 3.1,
            "wetted_area_m2": 2.5,  # (0.50 + 2 x 0.18) m girth x 0.85, plus skeg and rudder
            "form_factor": 1.25,
            "wave_making_frac": 0.12,
            "waterplane_area_m2": 1.16,  # 3.1 x 0.50 x 0.75
            "air_side_area_m2": 0.5,  # 0.10 m freeboard plus the tower
            "air_front_area_m2": 0.15,
            "lateral_cd_area_m2": 0.6,
            "keel_lift_slope_area_m2": 0.5,
            "wave_drag_frac_per_m2": 0.10,  # waves wash over rather than lift it
            "self_righting_dome": False,
            "keel_bulb_kg": 35,
        },
        {
            "hull_length_m": 3.2,
            "hull_beam_m": 0.5,
            "leak_per_day": round(0.0025 * 1.5, 6),  # GUESS: hatches often under water
        },
        "GUESS: low hull scaled from the kayak; deck panels awash give 60 % solar",
        (("power", "mounting_mismatch", round(0.8 * 0.6, 3)),),  # Iris's 60 % yield
    ),
    # 3.0 x 0.85 x 0.18 m board, 105 kg, 0.06 m draft, 0.9 m fin with a 25 kg
    # bulb, and a ~60 L buoyant deck pod (without it a wide flat board is as
    # stable upside down as right way up).
    "board": _shape(
        105.0,
        {
            "length_m": 3.0,
            "beam_m": 0.85,
            "waterline_length_m": 2.9,
            "wetted_area_m2": 2.6,  # flat bottom 2.9 x 0.85 x 0.9, plus fin, bulb, rudder
            "form_factor": 1.2,
            "wave_making_frac": 0.12,
            "waterplane_area_m2": 1.97,  # 2.9 x 0.85 x 0.8
            "air_side_area_m2": 0.5,  # 0.12 m of board edge plus the pod
            "air_front_area_m2": 0.25,
            "lateral_cd_area_m2": 0.5,
            "keel_lift_slope_area_m2": 0.75,  # same fin as the kayak
            "wave_drag_frac_per_m2": 0.2,  # a flat wide bottom slams in a seaway
            "keel_bulb_kg": 25,
        },
        {
            "hull_length_m": 3.0,
            "hull_beam_m": 0.85,
            # half the kayak's bulb: the 40 kg bulb rule, (50/25)^2
            "p_inverted_stuck": round(4.0e-5 * (50 / 25) ** 2, 9),
        },
        "GUESS: flat board scaled from the kayak; half the bulb, so more often stuck inverted",
    ),
}

SLOTS: dict[str, dict[str, Option]] = {
    "thr": {"two-t200": _thr(2), "one-t200": _thr(1, -0.45)},
    "sol": {
        "solar-250": Option((("power", "solar_wp", 250),), basis="panel datasheets"),
        "solar-200": Option((("power", "solar_wp", 200),), basis="panel datasheets", kg=-1.2),
        "solar-300": Option(
            (("power", "solar_wp", 300),),
            est=True,
            basis="needs a panel that fits the deck; layout not checked",
            kg=1.2,
        ),
    },
    "bat": {
        "two-50ah": Option((("power", "battery_wh", 1280),), basis="2 x 12.8 V 50 Ah"),
        "one-50ah": Option((("power", "battery_wh", 640),), basis="1 x 12.8 V 50 Ah", kg=-5.1),
        "two-100ah": Option(
            (("power", "battery_wh", 2560),),
            est=True,
            basis="2 x 12.8 V 100 Ah; fit in the hull not checked",
            kg=10.0,
        ),
    },
    "mppt": {
        "two-mppt": Option(basis=MPPT_BASIS),
        "one-mppt": Option(basis=MPPT_BASIS, kg=-0.5),
    },
    "brain": {
        "two-box": Option(  # the hazard model's default: two boxes
            est=True,
            basis="box failure rates are GUESSes (Randolph's table)",
            wh=31,
        ),
        "one-box": Option(
            (("hazards", "electronics_boxes", 1),),
            est=True,
            basis="box failure rates are GUESSes (Randolph's table)",
            wh=27,
            kg=-0.4,
        ),
    },
    "sat": {"rockblock-9603n": Option(effect="fixed", basis="RockBLOCK 9603N datasheet")},
    "beacon": {
        "smartone-solar": Option(est=True, basis="beacon failure rate is a GUESS"),  # default
        "none": Option((("comms", "beacon", False),), basis="no backup tracker", kg=-0.3),
    },
    "ais": {
        "emtrak-b921": Option(est=True, basis="ships' avoidance odds are a GUESS", wh=36),
        "dy-ait1500": Option(est=True, basis="ships' avoidance odds are a GUESS", wh=40, kg=0.1),
        # No AIS: ships avoid the boat only as often as without a working AIS today.
        "none": Option(
            (("hazards", "p_avoid_with_ais", 0.95),),
            basis="design doc: losing AIS roughly doubles collision risk",
            wh=0,
            kg=-1.2,
        ),
    },
    "radar": {
        "echomax-230br": _no_effect("how often ships see us doesn't depend on it yet"),
        "davis-echomaster": _no_effect("how often ships see us doesn't depend on it yet"),
    },
    "light": {"hella-naviled-360": Option(effect="fixed", basis="design doc, 0.5 W at night")},
    "lead": {
        "lead-50-new": Option(basis="design doc: 50 kg bulb"),
        "lead-50-scrap": Option(basis="same weight as new; only the price differs"),
        "lead-40": Option(
            (("hazards", "p_inverted_stuck", P_STUCK_40KG),), est=True, basis=BULB_BASIS, kg=-10.0
        ),
    },
    "paint": {
        "micron-csc": Option(
            (("hull", "fouling_frac_per_day", 0.006),),
            est=True,
            basis="design doc allowance, +30 % drag by day 50 (GUESS)",
        ),
        "none": Option(
            (("hull", "fouling_frac_per_day", 0.012),),
            est=True,
            basis="GUESS: bare hull fouls about twice as fast",
        ),
    },
    "drive": {
        "solar-electric": Option(basis="the v4 kayak as modelled"),
        "wing-sail": Option(
            (
                *_WING,
                ("propulsion", "thruster_count", 0),
            ),
            est=True,
            basis=WING_BASIS + "; no motors, so it tacks upwind",
            hotel_wh=WING_WH,
            kg=WING_KG - 2 * T200_KG,
        ),
        "hybrid": Option(
            _WING,
            est=True,
            basis=WING_BASIS + "; motors hold the course upwind instead of tacking",
            hotel_wh=WING_WH,
            kg=WING_KG,
        ),
    },
    "material": {
        "polyethylene": Option(basis="the v4 kayak as modelled"),
        "fibreglass": _material(
            -6.0, 1.2, 0.85, "GUESS: lighter; cracks at fittings leak a bit more"
        ),
        "carbon": _material(-11.0, 1.5, 0.9, "GUESS: lightest; stiff, so impacts crack and leak"),
        "plywood-epoxy": _material(-4.0, 1.5, 0.85, "GUESS: leaks where the epoxy skin is broken"),
        "aluminium": _material(
            -2.0,
            0.7,
            0.7,
            "GUESS: tough and dent-resistant; copper antifouling can't go on it",
            ("hull", "fouling_frac_per_day", 0.009),
        ),
    },
    "shape": {"kayak": Option(basis="the v4 kayak as modelled"), **SHAPES},
    "spares": {
        "spares-full": Option(effect="no effect yet", basis="spares are for the trials only"),
        "spares-no-pixhawk": Option(effect="no effect yet", basis="spares are for the trials only"),
        "none": Option(effect="no effect yet", basis="spares are for the trials only"),
    },
}

SLOT_NAMES = {  # as in Sam's catalog
    "thr": "Thrusters",
    "sol": "Solar panels",
    "bat": "Batteries",
    "mppt": "Solar charge controllers",
    "brain": "Autopilot",
    "sat": "Satellite modem",
    "beacon": "Backup beacon",
    "ais": "AIS",
    "radar": "Radar reflector",
    "light": "Navigation light",
    "lead": "Keel bulb",
    "paint": "Antifouling paint",
    "drive": "Drive",
    "material": "Hull material",
    "shape": "Hull shape",
    "spares": "Spares",
}

# The kayak as it stands: the catalog's default ("def": 1) option in every slot.
DEFAULTS = {
    "thr": "two-t200",
    "sol": "solar-250",
    "bat": "two-50ah",
    "mppt": "two-mppt",
    "brain": "two-box",
    "sat": "rockblock-9603n",
    "beacon": "smartone-solar",
    "ais": "emtrak-b921",
    "radar": "echomax-230br",
    "light": "hella-naviled-360",
    "lead": "lead-50-new",
    "paint": "micron-csc",
    "drive": "solar-electric",
    "material": "polyethylene",
    "shape": "kayak",
    "spares": "spares-full",
}


def normalise(choices: dict | None) -> tuple[dict, int]:
    """Fill unchosen slots with the base's defaults and check every id. Returns
    (slot -> option, cruise W); the cruise power may be given as "cruise_w", and
    the base (kayak, revc, revb) as "base". A Randolph base sails, so its cruise
    power is 0 W, or the thruster's when it has one; "cruise_w" doesn't apply."""
    base = base_of(choices)
    choices = {k: v for k, v in (choices or {}).items() if k != "base"}
    cruise = int(choices.pop("cruise_w", DEFAULT_CRUISE_W))
    if not 5 <= cruise <= 50:
        raise ValueError(f"cruise_w {cruise} W is outside 5 to 50 W")
    slots = slots_for(base)
    out = dict(defaults_for(base))
    for slot, opt in choices.items():
        if slot not in slots:
            raise ValueError(
                f"unknown slot {slot!r}" + ("" if base == "kayak" else f" for base {base!r}")
            )
        if opt not in slots[slot]:
            raise ValueError(f"unknown option {opt!r} for slot {slot!r}")
        out[slot] = opt
    if base in STOCK_BASES:
        return out, None  # sailed as designed, at its own cruise power
    if base != "kayak":
        return out, RAND_THRUSTER_CRUISE_W if out["drive"] == "wing-thruster" else 0
    # A wing-only boat has no thrusters, so the thruster and cruise power
    # choices don't apply (cruise 0 W, as Rev B).
    if out["drive"] == "wing-sail":
        out["thr"], cruise = DEFAULTS["thr"], 0
    return out, cruise


def design_changes(choices: dict | None, base: Design | None = None) -> tuple:
    """(section, key, value) changes from the base design for these choices."""
    which = base_of(choices)
    base = base or load_design(BASES[which])
    slots = slots_for(which)
    picked, cruise = normalise(choices)
    changes = []
    for slot, opt in picked.items():
        for sec, key, val in slots[slot][opt].changes:
            if isinstance(val, dict):  # merge into the design's table (e.g. p_part)
                val = {**getattr(base, sec).get(key, {}), **val}
            changes.append((sec, key, val))
    if cruise is not None:
        changes.append(("propulsion", "cruise_drive_w", cruise))
    if which == "kayak":
        brain, ais = SLOTS["brain"][picked["brain"]], SLOTS["ais"][picked["ais"]]
        d_wh = (brain.wh - BASE_BRAIN_WH) + (ais.wh - BASE_AIS_WH)
    else:
        d_wh = 0.0
    d_wh += sum(slots[slot][opt].hotel_wh for slot, opt in picked.items())
    if d_wh:
        hotel = base.electronics["hotel_load_wh_per_day"] + d_wh
        changes.append(("electronics", "hotel_load_wh_per_day", hotel))
    d_kg = sum(slots[slot][opt].kg for slot, opt in picked.items())
    if d_kg:  # the mass link (vessel/hull.py) turns weight into draft and drag
        changes.append(("hull", "mass_kg", round(base.hull["mass_kg"] + d_kg, 3)))
    # Leave out changes that set what the base already has, so the default build
    # is the design file untouched.
    return tuple(
        (s, k, v)
        for s, k, v in changes
        if getattr(base, s).get(k, KEY_DEFAULTS.get((s, k), _MISSING)) != v
    )


_MISSING = object()


def design_for(choices: dict | None) -> Design:
    base = load_design(BASES[base_of(choices)])
    return patched_design(base, design_changes(choices, base))


def effects(choices: dict | None) -> dict[str, dict]:
    """Per slot: the option chosen, what it does in the simulator, and its badge."""
    picked, _ = normalise(choices)
    slots = slots_for(base_of(choices))
    return {
        slot: {"option": opt, "effect": o.effect, "est": o.est, "basis": o.basis}
        for slot, opt in picked.items()
        for o in (slots[slot][opt],)
    }


# --- Randolph bases: their boat as a starting design --------------------------
# The Randolph team's wing-sail drone (configs/randolph_rev_c.yaml, rev_b.yaml; MIT,
# THIRD_PARTY_NOTICES.md) as a Boatyard base, with its own slots (ids agreed with
# Iris, 11 Nov 2026). The as-built option in each slot is the yaml untouched; the
# others are changes from it. A choice "base": "revc" picks the base; the kayak's
# slots then don't apply. brain, sat, light, paint and spares share the kayak's ids.
REV_B = "configs/randolph_rev_b.yaml"
REV_C = "configs/randolph_rev_c.yaml"
BASES = {"kayak": KAYAK, "revc": REV_C, "revb": REV_B}
# Ready-made boats you sail as they come, with no slots to change: the stock
# vessels (vessel/keelboat.py) and the joke fleet (vessel/oddboats.py).
STOCK_BASES = {
    name: f"configs/{name}.yaml"
    for name in (
        "stock_cruiser31",
        "stock_pearson31_2",  # Randolph and Becky's own boat (our model)
        "stock_dinghy14",
        "stock_beachcat16",
        "stock_sail_drone7",
        "stock_ocean_rower45",
        "joke_robot_kayak",
        "joke_canoe",
        "joke_pedalo",
        "joke_bathtub",
        "joke_flamingo",
        "joke_wheelie_bin",
    )
}
BASES.update(STOCK_BASES)
RAND_THRUSTER_CRUISE_W = (
    5  # GUESS: about what 40 W of deck panels leave after the 33 Wh/day hotel load
)
_SHARED_NO_EFFECT = "not modelled on the Randolph boat"


def _rudder(n: int, base: str) -> Option:
    # One rudder 0.055 m^2 wetted; its broadside drag and lift as in the Rev C yaml
    # (two rudders: wetted +0.055, lateral +0.045, lift +0.10 over Rev B's one).
    ref = 2 if base == "revc" else 1
    d = n - ref
    yaml = {
        "revc": {"wetted": 0.77, "lat": 0.235, "lift": 0.52},
        "revb": {"wetted": 0.68, "lat": 0.19, "lift": 0.42},
    }[base]
    return Option(
        (
            ("hull", "wetted_area_m2", round(yaml["wetted"] + 0.055 * d, 3)),
            ("hull", "lateral_cd_area_m2", round(yaml["lat"] + 0.045 * d, 3)),
            ("hull", "keel_lift_slope_area_m2", round(yaml["lift"] + 0.10 * d, 3)),
            # twin: either servo steers alone (Rev C 0.0021/day); single: Rev B 0.004/day
            ("hazards", "steering_per_day", 0.0021 if n == 2 else 0.004),
        ),
        est=n != ref,
        basis="Rev C (twin) and Rev B (single) yamls"
        if n == ref
        else "the other revision's rudder, scaled (GUESS)",
        kg=0.35 * d,  # GUESS: a rudder, stock and servo
    )


def _bulb(kg: float, base: str) -> Option:
    ref = {"revc": 9.0, "revb": 8.2}[base]
    heel = {"revc": 21.2, "revb": 17.4}[base]
    mass = {"revc": 26.9, "revb": 20.8}[base]
    # GUESS: righting moment goes with the bulb's share of the weight; staying upside
    # down after a knockdown with the square of the shortfall (the kayak's bulb rule).
    p_stuck = 4.0e-5 * max(1.0, (ref / kg) ** 2)
    return Option(
        (
            ("hull", "keel_bulb_kg", kg),
            ("sail", "max_heel_moment_nm", round(heel * (mass - ref + kg) / mass * kg / ref, 2)),
            ("hazards", "p_inverted_stuck", round(p_stuck, 9)),
        ),
        est=kg != ref,
        basis="the yaml's bulb"
        if kg == ref
        else "the other revision's bulb; righting moment scaled (GUESS)",
        kg=round(kg - ref, 2),
    )


def _rslots(base: str) -> dict[str, dict[str, Option]]:
    shared = {
        slot: {oid: _no_effect(_SHARED_NO_EFFECT) for oid in SLOTS[slot]}
        for slot in ("sat", "light", "paint", "spares")
    }
    return {
        "drive": {
            "wing": Option(
                basis="their Rev C5: 0.80 x 0.375 m free-rotating wing"
                if base == "revc"
                else "their design.py: 1.0 x 0.30 m free-rotating wing"
            ),
            "wing-thruster": Option(
                (
                    ("propulsion", "thrusters", "1 x 35 W thruster"),
                    ("propulsion", "thruster_count", 1),
                    ("propulsion", "max_drive_w", 35),
                    ("propulsion", "min_steer_w", 1.0),
                ),
                est=True,
                basis="their design.py thruster_w 35 W, switched on and run like our hybrid; "
                f"{RAND_THRUSTER_CRUISE_W} W cruise (GUESS)",
                kg=0.6,  # GUESS: thruster and ESC
            ),
        },
        "brain": {
            "one-box": Option(basis="their Build_Plan.md: one box"),
            "two-box": Option(
                (("hazards", "electronics_boxes", 2),),
                est=True,
                basis="our separate safe-mode box (GUESS for their boat)",
                kg=0.3,  # GUESS
                hotel_wh=5.0,  # GUESS: an ESP32-class box
            ),
        },
        "rudder": {"twin": _rudder(2, base), "single": _rudder(1, base)},
        "rsol": {
            "deck-40w": Option(basis="their design.py: 2 x 20 W"),
            "deck-60w": Option(
                (
                    ("power", "solar_wp", 60),
                    ("power", "panels_w", {"panel_fwd": 30, "panel_aft": 30}),
                ),
                est=True,
                basis="GUESS: what fits on the deck",
                kg=0.5,
            ),
        },
        "rbat": {
            "lfp-192wh": Option(basis="their design.py, LiFePO4"),
            "lfp-384wh": Option(
                (("power", "battery_wh", 384),), est=True, basis="GUESS: double the pack", kg=1.6
            ),
        },
        "keel": {"bulb-9kg": _bulb(9.0, base), "bulb-8kg": _bulb(8.2, base)},
        "tracker": {
            "yb3": Option(basis="their Backup_Tracker.md"),
            "none": Option((("comms", "beacon", False),), basis="no backup tracker", kg=-0.3),
        },
        **shared,
    }


RSLOT_NAMES = {
    "drive": "Drive",
    "brain": "Electronics boxes",
    "rudder": "Rudder",
    "rsol": "Solar panels",
    "rbat": "Battery",
    "keel": "Keel bulb",
    "tracker": "Backup tracker",
    "sat": "Satellite modem",
    "light": "Navigation light",
    "paint": "Antifouling",
    "spares": "Spares",
}
# What a player reads for a change from the planned build (or Randolph's as built):
# the one name map for builds (Leo's words: quality audit item 9,
# /mnt/project-files/simulator/gameplay/finish-layer-copy.md). Names never show a
# slot name or an option id ("Drive: hybrid", "solar-300"); a test fails if one does.
# Kayak options and Randolph's share the table (their slot ids don't clash).
CHANGE_NAMES = {
    ("thr", "one-t200"): "one motor",
    ("sol", "solar-200"): "smaller panels",
    ("sol", "solar-300"): "bigger panels",
    ("bat", "one-50ah"): "one battery",
    ("bat", "two-100ah"): "bigger batteries",
    ("mppt", "one-mppt"): "one charge controller",
    ("brain", "one-box"): "no backup autopilot",
    ("beacon", "none"): "no backup beacon",
    ("ais", "dy-ait1500"): "another AIS",
    ("ais", "none"): "hidden from ships (no AIS)",
    ("radar", "davis-echomaster"): "cheaper radar reflector",
    ("lead", "lead-50-scrap"): "scrap-lead keel",
    ("lead", "lead-40"): "lighter keel (40 kg)",
    ("paint", "none"): "no bottom paint",
    ("spares", "spares-no-pixhawk"): "fewer spares",
    ("spares", "none"): "no spares",
    # added: "Our kayak + wing sail and motors" (Ines: not to be confused with wing sail only)
    ("drive", "hybrid"): "wing sail and motors",
    ("drive", "wing-sail"): "wing sail only (no motors)",
    ("material", "fibreglass"): "fibreglass hull",
    ("material", "carbon"): "carbon hull",
    ("material", "plywood-epoxy"): "plywood hull",
    ("material", "aluminium"): "aluminium hull",
    # Randolph's boats
    ("drive", "wing-thruster"): "small motor",  # added
    ("brain", "two-box"): "backup autopilot",  # added
    ("rudder", "twin"): "two rudders",
    ("rudder", "single"): "one rudder",
    ("rsol", "deck-60w"): "bigger panel",
    ("rbat", "lfp-384wh"): "bigger battery",
    ("keel", "bulb-9kg"): "heavier keel",
    ("keel", "bulb-8kg"): "lighter keel",
    ("tracker", "none"): "no backup tracker",
}
# Things added go after a "+" ("Our kayak + wing sail"); everything else after a comma.
ADDED = {("drive", "hybrid"), ("drive", "wing-thruster"), ("brain", "two-box")}
# Two changes that read as one phrase.
MERGED = {
    frozenset({("sol", "solar-300"), ("bat", "two-100ah")}): "bigger panels and batteries",
    frozenset({("rsol", "deck-60w"), ("rbat", "lfp-384wh")}): "bigger panels and battery",
    frozenset({("brain", "one-box"), ("beacon", "none")}): "no backup autopilot or beacon",
}
# A hull shape replaces the boat's name.
SHAPE_NAMES = {
    "cat": "Catamaran version",
    "semisub": "Semi-submerged version",
    "board": "Surfboard version",
}


def cruise_name(w: int, alone: bool = True) -> str:
    """The kayak's motor setting in words (the planned build cruises at 25 W)."""
    words = f"motors turned {'down' if w < DEFAULT_CRUISE_W else 'up'}"
    return f"{words} ({w} W)" if alone else words


RSLOTS = {b: {k: v for k, v in _rslots(b).items() if v} for b in ("revc", "revb")}
RDEFAULTS = {
    b: {
        "drive": "wing",
        "brain": "one-box",
        "rudder": "twin" if b == "revc" else "single",
        "rsol": "deck-40w",
        "rbat": "lfp-192wh",
        "keel": "bulb-9kg" if b == "revc" else "bulb-8kg",
        "tracker": "yb3",
        **{s: DEFAULTS[s] for s in ("sat", "light", "paint", "spares")},
    }
    for b in ("revc", "revb")
}


# --- Stock bases: a spare autopilot ---------------------------------------------
# A stock boat comes with ONE autopilot (hazards.electronics_boxes: 1): when it dies
# the boat drifts. The one part a player can add is a spare: a second electronics
# box that takes over the steering when the first dies, as the kayak's safe box
# does. Not fitted by default, so each stock boat as it comes is its yaml untouched.
# Weight, power and price are the kayak's second box in the parts list
# (build-plan/parts-catalog.json "brain": two-box minus one-box): +0.4 kg,
# +4 Wh/day (31 - 27), +$83 (333 - 250). On a big boat it would steer the same
# rudder drive; the radio and the Iridium modem stay on the first box, so after
# a swap the boat is tracked by its backup tracker and gets no new route.
SPARE_BOX = Option(
    (("hazards", "electronics_boxes", 2),),
    est=True,
    basis="parts list: the safe-mode box (+0.4 kg, +4 Wh/day, +$83); box failure rates are GUESSes",
    kg=0.4,
    hotel_wh=4.0,
    cost=83.0,
)
SPARE_SLOT = {
    "none": Option(basis="as the boat comes: one autopilot"),
    "spare-autopilot": SPARE_BOX,
}
# The tactician (autonomy/sailing.py, #279): software in the autopilot that beats
# upwind and gybes downwind on the boat's own polar instead of pointing at the
# next waypoint. Design key electronics.tactician (default true). The ids are
# shared with the Randolph bases, which Sam offers it on (their yamls have it
# off). Software only, so no weight, power or price; it needs the wind's
# direction, which the sim takes from the true wind.
TACTICIAN_SLOT = {
    "on": Option(
        (("electronics", "tactician", True),),
        basis="software only: 0 kg, 0 Wh, $0. It needs a wind-direction reading; a boat "
        "without a wind sensor would need a small masthead wind vane (GUESS)",
    ),
    "off": Option(
        (("electronics", "tactician", False),),
        est=True,
        basis="steers straight for the next waypoint, clamped out of the no-go zone",
    ),
}
# What a design key means when its file doesn't set it, so a default option that
# sets the same value leaves the design file untouched (design_changes).
KEY_DEFAULTS = {("electronics", "tactician"): True}
# The stock boats steered by an autopilot box that can fail. The rower is steered
# by its crew and the joke fleet's boxes are trackers, so they have no slot. All
# four sail, so each can switch its tactician off.
STOCK_SLOTS = {
    b: {"spare": SPARE_SLOT, "tactician": TACTICIAN_SLOT}
    for b in ("stock_cruiser31", "stock_dinghy14", "stock_beachcat16", "stock_sail_drone7")
}
STOCK_SLOT_NAMES = {"spare": "Spare autopilot", "tactician": "Sailing tactician"}
# As each yaml comes: none of them sets electronics.tactician, so it's on.
STOCK_DEFAULTS = {b: {"spare": "none", "tactician": "on"} for b in STOCK_SLOTS}


def base_of(choices: dict | None) -> str:
    b = (choices or {}).get("base", "kayak")
    if b not in BASES:
        raise ValueError(f"unknown base {b!r}")
    return b


def slots_for(base: str) -> dict[str, dict[str, Option]]:
    if base in STOCK_BASES:
        return STOCK_SLOTS.get(base, {})
    return SLOTS if base == "kayak" else RSLOTS[base]


def defaults_for(base: str) -> dict[str, str]:
    if base in STOCK_BASES:
        return STOCK_DEFAULTS.get(base, {})
    return DEFAULTS if base == "kayak" else RDEFAULTS[base]


# --- The precomputed odds grid -------------------------------------------------
#
# The browser runs any build on one season's launches, but finish odds need 100
# voyages over ten years, so those are run ahead of time (mc.boatyard) for these
# builds. The page shows the nearest one's odds beside a sandbox run.

GRID: tuple[dict, ...] = (
    {},  # the kayak as it stands, 25 W cruise
    *({"cruise_w": w} for w in (10, 15, 20, 30)),
    {"thr": "one-t200"},
    {"sol": "solar-200"},
    {"sol": "solar-300"},
    {"bat": "one-50ah"},
    {"bat": "two-100ah"},
    {"brain": "one-box"},
    {"beacon": "none"},
    {"ais": "none"},
    {"paint": "none"},
    {"lead": "lead-40"},
    {"drive": "hybrid"},
    {"drive": "wing-sail"},
    *({"material": m} for m in ("fibreglass", "carbon", "plywood-epoxy", "aluminium")),
    *({"shape": s} for s in ("cat", "semisub", "board")),
    {"brain": "one-box", "beacon": "none"},
    {"sol": "solar-300", "bat": "two-100ah"},
    {"sol": "solar-300", "bat": "two-100ah", "cruise_w": 30},
    # Randolph bases: as built, then one change each (a handful per base, Maya)
    *(
        {"base": b, **g}
        for b in ("revc", "revb")
        for g in (
            {},
            {"drive": "wing-thruster"},
            {"brain": "two-box"},
            {"rudder": "single" if b == "revc" else "twin"},
            {"rsol": "deck-60w", "rbat": "lfp-384wh"},
            {"tracker": "none"},
        )
    ),
    {  # everything cheapest
        "thr": "one-t200",
        "sol": "solar-200",
        "bat": "one-50ah",
        "mppt": "one-mppt",
        "brain": "one-box",
        "beacon": "none",
        "ais": "none",
        "paint": "none",
        "cruise_w": 15,
    },
)


def matters(slot: str, opt: str, base: str = "kayak") -> bool:
    """Does this option run differently from the slot's default?"""
    slots, defaults = slots_for(base), defaults_for(base)
    o, d = slots[slot][opt], slots[slot][defaults[slot]]
    return opt != defaults[slot] and (
        o.changes != d.changes
        or o.kg != d.kg
        or (o.wh or 0) != (d.wh or 0)
        or o.hotel_wh != d.hotel_wh
    )


def grid_id(choices: dict | None) -> str:
    """Stable id of a build: 'k-p25' plus each choice that runs differently
    from the default, e.g. 'k-p15-thr.one-t200'; a Randolph base starts with its
    name, e.g. 'revc' or 'revc-drive.wing-thruster'. Builds that run the same have
    the same id."""
    base = base_of(choices)
    picked, cruise = normalise(choices)
    parts = [f"{slot}.{opt}" for slot, opt in picked.items() if matters(slot, opt, base)]
    return "-".join([f"k-p{cruise}" if base == "kayak" else base, *parts])


def nearest(choices: dict | None) -> tuple[str, bool]:
    """(grid id, exact) of the grid build closest to these choices: same base,
    then fewest slots that run differently, then the closest cruise power."""
    base = base_of(choices)
    picked, cruise = normalise(choices)
    want = grid_id(choices)
    if base in STOCK_BASES:
        return want, False  # not in the odds grid

    def dist(g):
        if base_of(g) != base:
            return (1, 0, 0)
        p, c = normalise(g)
        slots = sum(
            1
            for s in slots_for(base)
            if p[s] != picked[s] and (matters(s, p[s], base) or matters(s, picked[s], base))
        )
        return (0, slots, abs(c - cruise))

    best = min(GRID, key=dist)
    return grid_id(best), grid_id(best) == want


def slot_table() -> list[dict]:
    """Every slot and option with its effect and badge, in the catalog's shape
    (slots[{id, name, opts[{id, effect, est, basis, sim}]}]), for the page to
    merge into Sam's catalog by id. `sim` lists the design fields an option sets."""
    return [
        {
            "id": slot,
            "name": SLOT_NAMES[slot],
            "opts": [
                {
                    "id": oid,
                    "effect": o.effect,
                    "est": o.est,
                    "basis": o.basis,
                    "sim": [f"{s}.{k}" for s, k, _ in o.changes]
                    + (
                        ["electronics.hotel_load_wh_per_day"]
                        if o.wh is not None or o.hotel_wh
                        else []
                    )
                    + (["hull.mass_kg"] if o.kg else []),
                    "kg": o.kg,
                }
                for oid, o in opts.items()
            ],
        }
        for slot, opts in SLOTS.items()
    ]


def base_table() -> dict[str, dict]:
    """The Randolph bases for the page (sim-slots.json "bases"): per base its design
    file, defaults, which slots it shares with the kayak, and its slots in
    slot_table()'s shape."""
    return {
        b: {
            "design": BASES[b],
            "defaults": RDEFAULTS[b],
            "shared_slots": ["brain", "sat", "light", "paint", "spares"],
            "slots": [
                {
                    "id": slot,
                    "name": RSLOT_NAMES[slot],
                    "opts": [
                        {
                            "id": oid,
                            "effect": o.effect,
                            "est": o.est,
                            "basis": o.basis,
                            "sim": [f"{s}.{k}" for s, k, _ in o.changes]
                            + (["electronics.hotel_load_wh_per_day"] if o.hotel_wh else [])
                            + (["hull.mass_kg"] if o.kg else []),
                            "kg": o.kg,
                        }
                        for oid, o in opts.items()
                    ],
                }
                for slot, opts in RSLOTS[b].items()
            ],
        }
        for b in RSLOTS
    }


def stock_table() -> dict[str, dict]:
    """The stock bases with parts to add (sim-slots.json "stock"): per base its
    design file, defaults and slots in slot_table()'s shape, each option with its
    price against the default (USD, parts list)."""
    return {
        b: {
            "design": BASES[b],
            "defaults": STOCK_DEFAULTS[b],
            "slots": [
                {
                    "id": slot,
                    "name": STOCK_SLOT_NAMES[slot],
                    "opts": [
                        {
                            "id": oid,
                            "effect": o.effect,
                            "est": o.est,
                            "basis": o.basis,
                            "sim": [f"{s}.{k}" for s, k, _ in o.changes]
                            + (["electronics.hotel_load_wh_per_day"] if o.hotel_wh else [])
                            + (["hull.mass_kg"] if o.kg else []),
                            "kg": o.kg,
                            "cost": o.cost,
                        }
                        for oid, o in opts.items()
                    ],
                }
                for slot, opts in slots.items()
            ],
        }
        for b, slots in STOCK_SLOTS.items()
    }
