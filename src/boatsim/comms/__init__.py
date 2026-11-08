"""Satellite link: Iridium SBD (RockBLOCK 9603) two-way, Globalstar SmartOne
one-way position pings. Owner: Sam (thread 3)."""

from boatsim.comms.base import Link, PerfectLink
from boatsim.comms.iridium import GlobalstarPinger, IridiumSBDLink

__all__ = ["GlobalstarPinger", "IridiumSBDLink", "Link", "PerfectLink"]
