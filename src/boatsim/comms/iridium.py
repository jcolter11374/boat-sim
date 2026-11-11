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
* **Cost.** RockBLOCK bills in credits: one credit per 50 bytes or part of it
  for each message sent or received, one credit for a mailbox check that finds
  nothing waiting, plus a monthly line rental [1]. Iridium charges only for
  messages that go through. By default the link has **no spending cap**: it
  records what every message costs so the simulator can find the cheapest
  message schedule that still gets the boat across. A cap
  (`monthly_budget_usd`) exists only to test what a limit would do.

  **Mailbox schedule (decision, issue #72).** A session that sends a message
  also downloads whatever is waiting in the mailbox, at no extra charge beyond
  the message bytes. So by default (`mailbox="with_report"`) the boat checks
  its mailbox only as part of its daily report, and never pays for a separate
  empty check. The price is speed: base's reply to today's report reaches the
  boat with tomorrow's report, about 24 h later instead of about 10. The
  older schedule (`mailbox="scheduled"`, a separate check every
  `mailbox_every`) stays available so the Monte Carlo can compare the two.
* **Globalstar SmartOne** is a separate one-way beacon: it only transmits a
  position, a few times over in case one copy is lost, and needs no power from
  the main battery. It's the "where is it" backup if Iridium dies.

Every number not from a datasheet or price list is marked GUESS.

Sources (checked 2026-11-08):
[1] Ground Control, "Iridium contract costs":
    https://docs.groundcontrol.com/iot/rockblock/web-services/iridium-contract-costs
[2] Ground Control, "Short Burst Data service plans" (USD ex. tax): prepaid line
    rental $17.00/month for all RockBLOCKs, billed in one-month blocks; the
    cheapest 12-month contract is $15.75/month with 5,000 bytes included.
    Prepaid credit bundle prices are not published there (quote on request).
    https://www.groundcontrol.com/products/iridium/short-burst-data-range/short-burst-data-service-plans/
[3] Ground Control, "Short Burst Data Plans" (USD ex. tax, checked
    2026-11-11): Low Usage 12-month contract (GC-SBD-5KB-1) $15.75/month with
    5,000 bytes included, then $0.00315 a byte; activation $26.25; a mailbox
    check with nothing waiting $0.02; every message billed at least 10 bytes.
    https://www.groundcontrol.com/products/iridium/short-burst-data-range/short-burst-data-plans/

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


def _months(start: datetime, end: datetime) -> list[str]:
    """Every calendar month (YYYY-MM) from start to end, both included."""
    months = []
    t = start.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    while t <= end:
        months.append(_month(t))
        t = (t + timedelta(days=32)).replace(day=1)
    return months


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
    # When the boat collects messages from base. "with_report": only in its
    # report session (cheapest, the default). "scheduled": a separate check
    # every `mailbox_every`, aligned to 00:00 UTC; each empty one costs a credit [1].
    mailbox: str = "with_report"
    report_every: timedelta = timedelta(hours=24)  # must match the runner's schedule
    mailbox_every: timedelta = timedelta(hours=24)
    # Billing (RockBLOCK / Ground Control).
    credit_bytes: int = 50  # [1]: 1 credit per 50 bytes or part
    credit_usd: float = 0.12  # GUESS: bundle prices not published [2]; get a quote
    line_rental_usd_month: float = 17.0  # [2]: prepaid, all RockBLOCKs
    # The published contract plan [3], for the airtime counter (airtime()).
    plan_usd_month: float = 15.75  # [3] Low Usage
    plan_bytes_month: int = 5_000  # [3]: included each month
    plan_usd_per_byte: float = 0.00315  # [3]: past the included bytes
    plan_activation_usd: float = 26.25  # [3]
    plan_empty_check_usd: float = 0.02  # [3]
    plan_min_bytes: int = 10  # [3]: each message billed at least this
    monthly_budget_usd: float | None = None  # no cap: measure cost, don't limit it
    ledger: list[LedgerEntry] = field(default_factory=list)
    # Periods when the boat's battery was flat and the modem had no power, as
    # [start, end) pairs; end is None while it is still off. No mailbox checks
    # happen (or are billed) inside them.
    off_periods: list[list] = field(default_factory=list)
    _last_session: datetime | None = None  # last report session that got through

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

    def voyage_cost_usd(self, start: datetime, end: datetime) -> dict[str, float]:
        """Itemised airtime cost of a voyage from start to end.

        Line rental for every calendar month touched, credits for delivered
        messages, and a credit for each scheduled mailbox check that found
        nothing (checks that collected a base message are paid by that message).
        No checks happen while the modem is unpowered (see `set_powered`).
        """
        rental = len(_months(start, end)) * self.line_rental_usd_month
        msgs = sum(e.cost_usd for e in self.ledger if e.status == "delivered")
        empty = self._empty_checks(start, end) * self.credit_usd
        return {
            "line_rental": round(rental, 2),
            "messages": round(msgs, 2),
            "empty_mailbox_checks": round(empty, 2),
            "total": round(rental + msgs + empty, 2),
        }

    def _empty_checks(self, start: datetime, end: datetime) -> int:
        """Scheduled mailbox checks that found nothing waiting (none "with_report")."""
        checks = 0
        t = self.next_mailbox_check(start)
        while self.mailbox == "scheduled" and t <= end:
            checks += self._powered_at(t)
            t += self.mailbox_every
        down = sum(1 for e in self.ledger if e.status == "delivered" and e.direction == "down")
        return max(0, checks - down)

    def airtime(self, start: datetime, end: datetime) -> dict:
        """The airtime counter for a voyage: messages and bytes each way, and
        what they cost on the published Low Usage contract plan [3] (monthly
        fee with 5,000 bytes, then per byte, plus activation), the cheapest
        plan with published prices. Only messages that got through are billed;
        `lost` counts the ones that never did (the satellite charges nothing).
        Both directions count toward the bytes (GUESS: the plan page doesn't
        split them)."""
        ok = [e for e in self.ledger if e.status == "delivered"]
        out = {
            d: {
                "messages": sum(1 for e in ok if e.direction == d),
                "bytes": sum(e.size_bytes for e in ok if e.direction == d),
            }
            for d in ("up", "down")
        }
        months = _months(start, end)
        billed: dict[str, int] = dict.fromkeys(months, 0)
        for e in ok:
            m = _month(e.t_delivered or e.t_sent)
            billed[m] = billed.get(m, 0) + max(e.size_bytes, self.plan_min_bytes)
        fees = len(billed) * self.plan_usd_month
        extra = sum(max(0, b - self.plan_bytes_month) for b in billed.values())
        empty = self._empty_checks(start, end)
        usd = {
            "monthly_fees": round(fees, 2),
            "extra_bytes": round(extra * self.plan_usd_per_byte, 2),
            "empty_mailbox_checks": round(empty * self.plan_empty_check_usd, 2),
            "activation": self.plan_activation_usd,
        }
        usd["total"] = round(sum(usd.values()), 2)
        return {
            **out,
            "lost": sum(1 for e in self.ledger if e.status == "lost"),
            "months": len(billed),
            "bytes_billed": sum(billed.values()),
            "usd": usd,
            "plan": "Ground Control SBD Low Usage ($15.75 a month, 12-month term)",
        }

    def set_powered(self, t: datetime, on: bool) -> None:
        """Called by the runner when the boat's electronics lose or regain power."""
        if not on:
            self.off_periods.append([t, None])
        elif self.off_periods and self.off_periods[-1][1] is None:
            self.off_periods[-1][1] = t

    def _powered_at(self, t: datetime) -> bool:
        return not any(a <= t and (b is None or t < b) for a, b in self.off_periods)

    # ---------------------------------------------------------------- timing

    def next_mailbox_check(self, t: datetime) -> datetime:
        """When the boat next collects its mailbox, at or after t."""
        if self.mailbox == "with_report":
            s = self._last_session or t
            while s < t:
                s += self.report_every
            return s
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
        if self.monthly_budget_usd is not None and cost > (
            self.monthly_budget_usd - self.line_rental_usd_month - self.spent_usd(month) + 1e-9
        ):
            self.ledger.append(
                LedgerEntry(
                    msg.t_sent, msg.direction, msg.size_bytes, 0, 0.0, 0, None, "over_budget"
                )
            )
            return None

        # Up: the boat tries right away. Down: it waits for the next mailbox check.
        if msg.direction == "up":
            first = msg.t_sent
        elif self.mailbox == "with_report":
            # Base's reply always misses the session it answers, so it waits
            # for the next report session.
            first = self.next_mailbox_check(msg.t_sent + timedelta(seconds=1))
        else:
            first = self.next_mailbox_check(msg.t_sent)
        p = self.p_try(env)
        for k in range(self.max_tries):
            if rng.random() < p:
                t_done = first + k * self.retry_every + timedelta(seconds=self.session_s)
                if msg.direction == "up":
                    self._last_session = msg.t_sent
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
