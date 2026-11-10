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
    changes: tuple = ()  # (section, key, value); hotel load is handled separately
    effect: str = "wired"  # wired | no effect yet | fixed
    est: bool = False
    basis: str = ""
    wh: float | None = None  # brain/AIS daily energy (catalog), for the hotel load


def _thr(n: int) -> Option:
    return Option(
        (("propulsion", "thruster_count", n), ("propulsion", "max_drive_w", 50 * n)),
        basis="Blue Robotics T200 datasheet, 50 W burst each",
    )


def _no_effect(why: str) -> Option:
    return Option(effect="no effect yet", basis=why)


SLOTS: dict[str, dict[str, Option]] = {
    "thr": {"two-t200": _thr(2), "one-t200": _thr(1)},
    "sol": {
        "solar-250": Option((("power", "solar_wp", 250),), basis="panel datasheets"),
        "solar-200": Option((("power", "solar_wp", 200),), basis="panel datasheets"),
        "solar-300": Option(
            (("power", "solar_wp", 300),),
            est=True,
            basis="needs a panel that fits the deck; layout not checked",
        ),
    },
    "bat": {
        "two-50ah": Option((("power", "battery_wh", 1280),), basis="2 x 12.8 V 50 Ah"),
        "one-50ah": Option((("power", "battery_wh", 640),), basis="1 x 12.8 V 50 Ah"),
        "two-100ah": Option(
            (("power", "battery_wh", 2560),),
            est=True,
            basis="2 x 12.8 V 100 Ah; fit in the hull not checked",
        ),
    },
    "mppt": {
        "two-mppt": _no_effect("charge-controller failure isn't modelled yet"),
        "one-mppt": _no_effect("charge-controller failure isn't modelled yet"),
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
        ),
    },
    "sat": {"rockblock-9603n": Option(effect="fixed", basis="RockBLOCK 9603N datasheet")},
    "beacon": {
        "smartone-solar": Option(
            est=True, basis="beacon failure rate is a GUESS"
        ),  # fitted by default
        "none": Option((("comms", "beacon", False),), basis="no backup tracker"),
    },
    "ais": {
        "emtrak-b921": Option(est=True, basis="ships' avoidance odds are a GUESS", wh=36),
        "dy-ait1500": Option(est=True, basis="ships' avoidance odds are a GUESS", wh=40),
        # No AIS: ships avoid the boat only as often as without a working AIS today.
        "none": Option(
            (("hazards", "p_avoid_with_ais", 0.95),),
            basis="design doc: losing AIS roughly doubles collision risk",
            wh=0,
        ),
    },
    "radar": {
        "echomax-230br": _no_effect("how often ships see us doesn't depend on it yet"),
        "davis-echomaster": _no_effect("how often ships see us doesn't depend on it yet"),
    },
    "light": {"hella-naviled-360": Option(effect="fixed", basis="design doc, 0.5 W at night")},
    "lead": {
        "lead-50-new": _no_effect("weight doesn't change speed or stability yet"),
        "lead-50-scrap": _no_effect("weight doesn't change speed or stability yet"),
        "lead-40": _no_effect("weight doesn't change speed or stability yet"),
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
    return out, cruise


def design_changes(choices: dict | None, base: Design | None = None) -> tuple:
    """(section, key, value) changes from the kayak for these choices."""
    base = base or load_design(KAYAK)
    picked, cruise = normalise(choices)
    changes = []
    for slot, opt in picked.items():
        changes += SLOTS[slot][opt].changes
    changes.append(("propulsion", "cruise_drive_w", cruise))
    brain, ais = SLOTS["brain"][picked["brain"]], SLOTS["ais"][picked["ais"]]
    d_wh = (brain.wh - BASE_BRAIN_WH) + (ais.wh - BASE_AIS_WH)
    if d_wh:
        hotel = base.electronics["hotel_load_wh_per_day"] + d_wh
        changes.append(("electronics", "hotel_load_wh_per_day", hotel))
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


def grid_id(choices: dict | None) -> str:
    """Stable id of a kayak build: 'k-p25' plus each non-default choice that the
    simulator models, e.g. 'k-p15-thr.one-t200'. Options with no effect yet are
    left out, so builds that run the same are the same id."""
    picked, cruise = normalise(choices)
    parts = [
        f"{slot}.{opt}"
        for slot, opt in picked.items()
        if opt != DEFAULTS[slot] and SLOTS[slot][opt].effect == "wired"
    ]
    return "-".join([f"k-p{cruise}", *parts])


def nearest(choices: dict | None) -> tuple[str, bool]:
    """(grid id, exact) of the grid build closest to these choices: fewest
    modelled slots that differ, then the closest cruise power."""
    picked, cruise = normalise(choices)
    want = grid_id(choices)

    def dist(g):
        p, c = normalise(g)
        slots = sum(1 for s in SLOTS if p[s] != picked[s] and SLOTS[s][picked[s]].effect == "wired")
        return (slots, abs(c - cruise))

    best = min(GRID, key=dist)
    return grid_id(best), grid_id(best) == want
