"""Satellite link models: Iridium SBD two-way (RockBLOCK 9603) and the one-way
Globalstar SmartOne Solar position ping.

How the real hardware behaves, in plain terms:

* **Iridium SBD** ("short burst data") sends short text-message-sized packets:
  at most 340 bytes from the boat ("mobile originated", MO, "up") and 270 bytes
  to the boat ("mobile terminated", MT, "down"). Each try takes under a minute,
  but a try can fail when the antenna can't see a satellite. On a 10 ft kayak
  the antenna sits about half a metre above the water, so waves and spray block
  it more often in rough seas. The firmware just retries a bit later.
* **Messages to the boat wait in a mailbox** at the Iridium gateway until the
  boat next "checks its mailbox" (opens a session). So course corrections from
  base arrive at the boat's next scheduled check, not instantly.
* **Cost.** RockBLOCK bills in credits: one credit per 50 bytes or part of it,
  charged only when a message goes through, plus a monthly line rental. The
  link refuses a message that would push this month's spend over budget, the
  way the real base-station software should.
* **Globalstar SmartOne** is a separate one-way beacon: it only transmits a
  position, a few times over in case one copy is lost, and needs no power from
  the main battery. It's the "where is it" backup if Iridium dies.

Every number not from a datasheet is marked GUESS. Prices change: check the
current Ground Control price list before trusting the dollar figures.

Owner: Sam.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import numpy as np

from boatsim.comms.base import SBD_MO_MAX_BYTES, SBD_MT_MAX_BYTES
from boatsim.types import EnvState, Message


def _midnight(t: datetime) -> datetime:
    return t.replace(hour=0, minute=0, second=0, microsecond=0)


def _month(t: datetime) -> str:
    return f"{t.year:04d}-{t.month:02d}"


def sea_state_factor(hs: float, calm_hs: float, rough_hs: float, rough_factor: float) -> float:
    """1.0 at or below calm_hs, falling linearly to rough_factor at rough_hs and above."""
    if hs <= calm_hs:
        return 1.0
    if hs >= rough_hs:
        return rough_factor
    frac = (hs - calm_hs) / (rough_hs - calm_hs)
    return 1.0 + frac * (rough_factor - 1.0)


@dataclass
class LedgerEntry:
    t_sent: datetime
    direction: str
    size_bytes: int
    credits: int
    cost_usd: float
    attempts: int
    t_delivered: datetime | None
    status: str  # "delivered", "lost", "over_budget"


@dataclass
class IridiumSBDLink:
    """RockBLOCK 9603 over Iridium SBD. Implements the `Link` protocol."""

    # Per-try success with the antenna clear of the water. GUESS: datasheets
    # don't give this; small-boat users report most first tries succeed.
    p_try_calm: float = 0.85  # GUESS
    # Waves blocking the antenna: success falls from calm_hs to rough_hs.
    calm_hs_m: float = 1.0  # GUESS
    rough_hs_m: float = 6.0  # GUESS
    rough_factor: float = 0.3  # GUESS: at 6 m seas, 30% of the calm success rate
    retry_every: timedelta = timedelta(minutes=15)  # GUESS: firmware setting we choose
    max_tries: int = 8  # GUESS: then give up and let the next report supersede it
    session_s: float = 40.0  # GUESS: typical SBD session length incl. satellite acquisition
    # Boat checks the mailbox for base messages this often, aligned to 00:00 UTC.
    mailbox_every: timedelta = timedelta(hours=6)  # GUESS: firmware setting we choose
    # Billing (RockBLOCK / Ground Control).
    credit_bytes: int = 50  # Ground Control: 1 credit per 50 bytes or part
    credit_usd: float = 0.12  # GUESS: depends on bundle size; check price list
    line_rental_usd_month: float = 15.0  # GUESS: check price list
    monthly_budget_usd: float = 40.0  # GUESS: proposed default, John to set
    ledger: list[LedgerEntry] = field(default_factory=list)

    # ------------------------------------------------------------ accounting

    def credits_for(self, size_bytes: int) -> int:
        return max(1, math.ceil(size_bytes / self.credit_bytes))

    def spent_usd(self, month: str) -> float:
        """Message spend in a month (YYYY-MM), excluding line rental."""
        return sum(
            e.cost_usd
            for e in self.ledger
            if e.status == "delivered" and _month(e.t_delivered) == month
        )

    def monthly_summary(self) -> dict[str, dict]:
        """Per month: messages up/down, lost, refused, credits and total cost incl. rental."""
        out: dict[str, dict] = {}
        for e in self.ledger:
            m = _month(e.t_delivered or e.t_sent)
            s = out.setdefault(
                m, {"up": 0, "down": 0, "lost": 0, "over_budget": 0, "credits": 0, "usd": 0.0}
            )
            if e.status == "delivered":
                s[e.direction] += 1
                s["credits"] += e.credits
                s["usd"] += e.cost_usd
            else:
                s[e.status] += 1
        for s in out.values():
            s["usd"] = round(s["usd"] + self.line_rental_usd_month, 2)
        return out

    # ---------------------------------------------------------------- timing

    def next_mailbox_check(self, t: datetime) -> datetime:
        """First scheduled mailbox check at or after t."""
        base = _midnight(t)
        n = math.ceil((t - base) / self.mailbox_every)
        return base + n * self.mailbox_every

    def p_try(self, env: EnvState) -> float:
        f = sea_state_factor(env.hs, self.calm_hs_m, self.rough_hs_m, self.rough_factor)
        return self.p_try_calm * f

    # ------------------------------------------------------------- interface

    def send(self, msg: Message, env: EnvState, rng: np.random.Generator) -> datetime | None:
        """Return when the message reaches the other end, or None if it never does.

        Uses the sea state at send time for every retry (retries span under two
        hours, short next to how fast Hs changes).
        """
        limit = SBD_MO_MAX_BYTES if msg.direction == "up" else SBD_MT_MAX_BYTES
        if msg.size_bytes > limit:
            raise ValueError(f"{msg.direction} message {msg.size_bytes} B exceeds {limit} B")

        credits = self.credits_for(msg.size_bytes)
        cost = credits * self.credit_usd
        month = _month(msg.t_sent)
        budget_left = self.monthly_budget_usd - self.line_rental_usd_month - self.spent_usd(month)
        if cost > budget_left + 1e-9:
            self.ledger.append(
                LedgerEntry(
                    msg.t_sent, msg.direction, msg.size_bytes, 0, 0.0, 0, None, "over_budget"
                )
            )
            return None

        # Up: the boat tries right away. Down: it waits for the next mailbox check.
        first = msg.t_sent if msg.direction == "up" else self.next_mailbox_check(msg.t_sent)
        p = self.p_try(env)
        for k in range(self.max_tries):
            if rng.random() < p:
                t_done = first + k * self.retry_every + timedelta(seconds=self.session_s)
                self.ledger.append(
                    LedgerEntry(
                        msg.t_sent,
                        msg.direction,
                        msg.size_bytes,
                        credits,
                        cost,
                        k + 1,
                        t_done,
                        "delivered",
                    )
                )
                return t_done
        self.ledger.append(
            LedgerEntry(
                msg.t_sent, msg.direction, msg.size_bytes, 0, 0.0, self.max_tries, None, "lost"
            )
        )
        return None


@dataclass
class GlobalstarPinger:
    """Globalstar SmartOne Solar: one-way position pings on its own solar cell.

    Not part of the `Link` protocol (it can't carry messages). The runner can
    call `ping` on its schedule so the base station keeps a last-known position
    even if Iridium fails.
    """

    every: timedelta = timedelta(hours=6)  # GUESS: a SmartOne setting we choose
    copies: int = 3  # SmartOne sends each message more than once; GUESS on the count
    p_copy_calm: float = 0.7  # GUESS: per-copy reception, simplex has no acknowledgement
    calm_hs_m: float = 1.0  # GUESS
    rough_hs_m: float = 6.0  # GUESS
    rough_factor: float = 0.4  # GUESS
    usd_month: float = 20.0  # GUESS: subscription; check current plan price
    pings: list[tuple[datetime, bool]] = field(default_factory=list)

    def p_received(self, env: EnvState) -> float:
        f = sea_state_factor(env.hs, self.calm_hs_m, self.rough_hs_m, self.rough_factor)
        p = self.p_copy_calm * f
        return 1.0 - (1.0 - p) ** self.copies

    def ping(
        self, t: datetime, lat: float, lon: float, env: EnvState, rng: np.random.Generator
    ) -> dict | None:
        """Return the position report base receives, or None if every copy is lost."""
        ok = bool(rng.random() < self.p_received(env))
        self.pings.append((t, ok))
        if not ok:
            return None
        return {"t": t.isoformat(timespec="minutes"), "lat": round(lat, 4), "lon": round(lon, 4)}
