"""Hull, drag, thrust, solar, battery and hazards. Owner: Theo (thread 1)."""

from boatsim.vessel.base import KinematicVessel, Vessel
from boatsim.vessel.kayak import KayakState, KayakVessel
from boatsim.vessel.keelboat import KeelboatState, KeelboatVessel
from boatsim.vessel.oddboats import OddBoatVessel, OddState

__all__ = [
    "KayakState",
    "KayakVessel",
    "KeelboatState",
    "KeelboatVessel",
    "KinematicVessel",
    "OddBoatVessel",
    "OddState",
    "Vessel",
    "make_vessel",
]


def make_vessel(design):
    """The physics for a design: a keelboat sailed from its polar if the design
    has a `vpp:` block (stock vessels), the odd-boat model if its stock block has
    an `odd:` section (joke fleet), else the kayak model (kayak, Rev B/C)."""
    if design.vpp:
        return KeelboatVessel(design)
    if "odd" in design.stock:
        return OddBoatVessel(design)
    return KayakVessel(design)
