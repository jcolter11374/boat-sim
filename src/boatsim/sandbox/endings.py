"""How a voyage ended, in plain words, for results cards (helm, Boatyard).

A boat's own words come from its design: the joke fleet's `stock.odd.loss_words`
are already in the LOST event (vessel/oddboats.py), so a swamped canoe says
"swamped: waves over a 0.3 m edge filled it" and a flamingo says "a seam let go".
Every boat gets a short headline for the card and the day it happened.
"""

from __future__ import annotations

from datetime import datetime

from boatsim.types import Event, EventKind

# Headline by what the cause starts with (first match wins), then by outcome.
HEADLINES = (
    ("swamped", "Swamped"),
    ("a seam", "Burst"),
    ("rolled", "Rolled over"),
    ("flipped", "Flipped"),
    ("tipped", "Tipped over"),
    ("capsized", "Capsized"),
    ("stuck inverted", "Rolled over"),
    ("taken or snagged", "Picked up"),
    ("sank", "Sank"),
    ("struck", "Hit by a ship"),
    ("electronics", "Went silent"),
    ("both electronics", "Went silent"),
    ("the robot", "Went silent"),
    ("the tracker", "Went silent"),
)
BY_OUTCOME = {
    "arrived": ("Finished", "reached the finish west of Lisbon"),
    "aground": ("Ran ashore", "washed up on land before the finish"),
    "disqualified": ("Disqualified", "silent too long under the race rules"),
    "timeout": ("Still at sea", "still sailing when the clock ran out"),
    "left_data_box": ("Off the map", "sailed out of the weather we have"),
    "at_sea": ("Still at sea", "still sailing"),
    "lost": ("Lost", "lost at sea"),
}
PHASES = {"near land": "near the coast", "open ocean": "out in the open ocean"}


def split_phase(detail: str) -> tuple[str, str | None]:
    """'swamped ... [near land]' -> ('swamped ...', 'near land')."""
    base, sep, tag = (detail or "").partition(" [")
    return base, (tag.rstrip("]") if sep else None)


def ending(outcome: str, events: list[Event], start: datetime, label: str | None = None) -> dict:
    """The card's "how it ends": headline, the boat's own words, where and when.

    outcome: the voyage outcome value ("lost", "arrived", "at_sea", ...).
    events: the voyage's events; the first LOST (or AGROUND) one gives the cause.
    label: the boat's name for the card (design.stock["label"]), if any."""
    head, words = BY_OUTCOME.get(outcome, ("Over", outcome))
    where, day = None, None
    kinds = {"lost": EventKind.LOST, "aground": EventKind.AGROUND}
    kind = kinds.get(outcome)
    ev = next((e for e in events if e.kind == kind), None) if kind else None
    if ev is not None:
        day = (ev.t - start).total_seconds() / 86400.0
        if ev.detail:
            words, ph = split_phase(ev.detail)
            where = PHASES.get(ph or "", ph)
            head = next((h for k, h in HEADLINES if words.startswith(k)), head)
    elif outcome == "arrived":
        fin = next((e for e in events if e.kind == EventKind.ARRIVED), None)
        day = (fin.t - start).total_seconds() / 86400.0 if fin else None
    return {"headline": head, "words": words, "where": where, "day": day, "boat": label}
