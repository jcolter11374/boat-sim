"""Hull, drag, thrust, solar, battery and hazards. Owner: Theo (thread 1)."""

from boatsim.vessel.base import KinematicVessel, Vessel
from boatsim.vessel.kayak import KayakState, KayakVessel
from boatsim.vessel.keelboat import KeelboatState, KeelboatVessel

__all__ = [
    "KayakState",
    "KayakVessel",
    "KeelboatState",
    "KeelboatVessel",
    "KinematicVessel",
    "Vessel",
    "make_vessel",
]


def make_vessel(design):
    """The physics for a design: a keelboat sailed from its polar if the design
    has a `vpp:` block (stock vessels), else the kayak model (kayak, Rev B/C)."""
    return KeelboatVessel(design) if design.vpp else KayakVessel(design)
