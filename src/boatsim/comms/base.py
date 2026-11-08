from __future__ import annotations

from datetime import datetime
from typing import Protocol

import numpy as np

from boatsim.types import EnvState, Message

# Iridium SBD message size limits (bytes), per the RockBLOCK 9603 / Iridium SBD spec.
SBD_MO_MAX_BYTES = 340  # boat -> base
SBD_MT_MAX_BYTES = 270  # base -> boat


class Link(Protocol):
    def send(self, msg: Message, env: EnvState, rng: np.random.Generator) -> datetime | None:
        """Return the delivery time, or None if the message is lost."""
        ...


class PerfectLink:
    """Stub: every message arrives instantly. Enforces size limits only.
    Sam replaces this with delays, losses that worsen in rough seas, and cost."""

    def send(self, msg, env, rng):
        limit = SBD_MO_MAX_BYTES if msg.direction == "up" else SBD_MT_MAX_BYTES
        if msg.size_bytes > limit:
            raise ValueError(f"{msg.direction} message {msg.size_bytes} B exceeds {limit} B")
        return msg.t_sent
