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
    """Fill unchosen slots with the defaults and check every id. Returns
    (slot -> option, cruise W); the cruise power may be given as "cruise_w"."""
    choices = dict(choices or {})
    cruise = int(choices.pop("cruise_w", DEFAULT_CRUISE_W))
    if not 5 <= cruise <= 50:
        raise ValueError(f"cruise_w {cruise} W is outside 5 to 50 W")
    out = dict(DEFAULTS)
    for slot, opt in choices.items():
        if slot not in SLOTS:
            raise ValueError(f"unknown slot {slot!r}")
        if opt not in SLOTS[slot]:
            raise ValueError(f"unknown option {opt!r} for slot {slot!r}")
        out[slot] = opt
    # A wing-only boat has no thrusters, so the thruster and cruise power
    # choices don't apply (cruise 0 W, as Rev B).
    if out["drive"] == "wing-sail":
        out["thr"], cruise = DEFAULTS["thr"], 0
    return out, cruise


def design_changes(choices: dict | None, base: Design | None = None) -> tuple:
    """(section, key, value) changes from the kayak for these choices."""
    base = base or load_design(KAYAK)
    picked, cruise = normalise(choices)
    changes = []
    for slot, opt in picked.items():
        for sec, key, val in SLOTS[slot][opt].changes:
            if isinstance(val, dict):  # merge into the design's table (e.g. p_part)
                val = {**getattr(base, sec).get(key, {}), **val}
            changes.append((sec, key, val))
    changes.append(("propulsion", "cruise_drive_w", cruise))
    brain, ais = SLOTS["brain"][picked["brain"]], SLOTS["ais"][picked["ais"]]
    d_wh = (brain.wh - BASE_BRAIN_WH) + (ais.wh - BASE_AIS_WH)
    d_wh += sum(SLOTS[slot][opt].hotel_wh for slot, opt in picked.items())
    if d_wh:
        hotel = base.electronics["hotel_load_wh_per_day"] + d_wh
        changes.append(("electronics", "hotel_load_wh_per_day", hotel))
    d_kg = sum(SLOTS[slot][opt].kg for slot, opt in picked.items())
    if d_kg:  # the mass link (vessel/hull.py) turns weight into draft and drag
        changes.append(("hull", "mass_kg", round(base.hull["mass_kg"] + d_kg, 3)))
    # Leave out changes that set what the kayak already has, so the default build
    # is the design file untouched.
    return tuple((s, k, v) for s, k, v in changes if getattr(base, s).get(k, _MISSING) != v)


_MISSING = object()


def design_for(choices: dict | None) -> Design:
    base = load_design(KAYAK)
    return patched_design(base, design_changes(choices, base))


def effects(choices: dict | None) -> dict[str, dict]:
    """Per slot: the option chosen, what it does in the simulator, and its badge."""
    picked, _ = normalise(choices)
    return {
        slot: {"option": opt, "effect": o.effect, "est": o.est, "basis": o.basis}
        for slot, opt in picked.items()
        for o in (SLOTS[slot][opt],)
    }


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


def matters(slot: str, opt: str) -> bool:
    """Does this option run differently from the slot's default?"""
    o, d = SLOTS[slot][opt], SLOTS[slot][DEFAULTS[slot]]
    return opt != DEFAULTS[slot] and (
        o.changes != d.changes
        or o.kg != d.kg
        or (o.wh or 0) != (d.wh or 0)
        or o.hotel_wh != d.hotel_wh
    )


def grid_id(choices: dict | None) -> str:
    """Stable id of a kayak build: 'k-p25' plus each choice that runs differently
    from the default, e.g. 'k-p15-thr.one-t200'. Builds that run the same have
    the same id."""
    picked, cruise = normalise(choices)
    parts = [f"{slot}.{opt}" for slot, opt in picked.items() if matters(slot, opt)]
    return "-".join([f"k-p{cruise}", *parts])


def nearest(choices: dict | None) -> tuple[str, bool]:
    """(grid id, exact) of the grid build closest to these choices: fewest
    slots that run differently, then the closest cruise power."""
    picked, cruise = normalise(choices)
    want = grid_id(choices)

    def dist(g):
        p, c = normalise(g)
        slots = sum(
            1 for s in SLOTS if p[s] != picked[s] and (matters(s, p[s]) or matters(s, picked[s]))
        )
        return (slots, abs(c - cruise))

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
