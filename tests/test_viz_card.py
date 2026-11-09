import pickle
from datetime import datetime, timedelta

import pandas as pd

from boatsim.comms import IridiumSBDLink
from boatsim.runner.simulate import VoyageLog
from boatsim.types import Event, EventKind, Outcome
from boatsim.viz import batch_card, card_row, render_batch, render_voyage, voyage_card
from boatsim.viz.card import classify_cause, first_trouble, km_to_europe

T0 = datetime(2021, 5, 1)


def _log(outcome, events=(), track=None, days=10):
    """A hand-made voyage: hourly rows heading east from the drop point."""
    log = VoyageLog(start=T0, seed=7, outcome=outcome)
    track = track or (lambda h: (36.85, -75.7 + 0.03 * h, 0.9))
    for h in range(int(days * 24) + 1):
        lat, lon, soc = track(h)
        log.rows.append({"t": T0 + timedelta(hours=h), "lat": lat, "lon": lon, "soc": soc})
    log.end = log.rows[-1]["t"]
    log.events = list(events)
    return log


def test_km_to_finish_is_zero_at_the_target_and_large_at_the_bay():
    assert km_to_europe(39.5, -13.5) == 0.0  # inside the Microtransat target circle
    assert km_to_europe(38.5, -28.0) > 1000  # the Azores are no longer a finish
    assert 5000 < km_to_europe(36.85, -75.7) < 6000


def test_causes_cover_each_way_a_voyage_ends():
    t = T0 + timedelta(days=3)
    assert classify_cause(_log(Outcome.ARRIVED)) == "arrived"
    strike = [Event(t, EventKind.SHIP_STRIKE, "sunk or wrecked")]
    assert classify_cause(_log(Outcome.LOST, strike)) == "ship_strike"
    rolled = [
        Event(t, EventKind.CAPSIZE, "1 knockdown(s), Hs 5.0 m"),
        Event(t, EventKind.LOST, "stuck inverted or keel lost"),
    ]
    assert classify_cause(_log(Outcome.LOST, rolled)) == "capsize"
    flat = [Event(t, EventKind.BATTERY_EMPTY)]
    assert classify_cause(_log(Outcome.TIMEOUT, flat)) == "battery_empty"
    assert classify_cause(_log(Outcome.TIMEOUT)) == "off_course_timeout"


def test_clean_run_has_no_trouble():
    assert first_trouble(_log(Outcome.TIMEOUT)) is None


def test_trouble_is_the_earliest_warning_sign():
    events = [Event(T0 + timedelta(days=6), EventKind.CAPSIZE, "2 knockdown(s), Hs 4.0 m")]
    # Battery sinks to the safe-mode hold level on day ~3.4, before the day-6 knockdown.
    log = _log(Outcome.TIMEOUT, events, track=lambda h: (36.85, -75.7 + 0.03 * h, 0.9 - h / 110))
    tr = first_trouble(log)
    assert 3.0 < tr.day < 4.0 and "safe mode" in tr.what


def test_losing_ground_counts_as_trouble():
    # Heads east for 4 days, then gets swept back west.
    def track(h):
        lon = -75.7 + 0.03 * min(h, 96) - 0.05 * max(0, h - 96)
        return 36.85, lon, 0.9

    tr = first_trouble(_log(Outcome.TIMEOUT, track=track))
    assert tr is not None and "losing ground" in tr.what
    assert 5 < tr.day < 10


def test_voyage_card_reads_plainly_and_carries_the_caveat():
    events = [
        Event(T0 + timedelta(days=2), EventKind.CAPSIZE, "3 knockdown(s), Hs 5.5 m"),
        Event(T0 + timedelta(days=2), EventKind.PART_FAILED, "ais_whip (knockdown)"),
    ]
    card = voyage_card(_log(Outcome.TIMEOUT, events))
    assert card.knockdowns == 3 and card.parts_broken == ["ais_whip"]
    assert card.trouble_day == 2.0
    text = render_voyage(card)
    assert "DID NOT ARRIVE" in text and "km short of the finish" in text
    assert "not priced yet" in text  # no invented build cost
    assert "story, not a forecast" in text
    assert len(text.splitlines()) <= 24  # one screen


def test_airtime_bill_comes_from_the_iridium_link():
    card = voyage_card(_log(Outcome.TIMEOUT), link=IridiumSBDLink(mailbox="scheduled"))
    assert card.airtime_usd["line_rental"] == 17.0  # 10 days inside May
    assert card.airtime_usd["total"] > 17.0  # plus daily empty mailbox checks
    assert "Satellite bill" in render_voyage(card)


def test_card_row_is_plain_and_picklable():
    row = card_row(_log(Outcome.TIMEOUT), link=IridiumSBDLink())
    assert pickle.loads(pickle.dumps(row)) == row
    assert all(v is None or isinstance(v, (str, int, float)) for v in row.values())
    assert card_row(_log(Outcome.TIMEOUT), outcome="left_data_box")["cause"] == "left_data_box"


def _summary(month_outcomes):
    rows = []
    for month, outcomes in month_outcomes.items():
        for i, (outcome, cause) in enumerate(outcomes):
            rows.append(
                {
                    "start": datetime(2010 + i, month, 1),
                    "outcome": outcome,
                    "cause": cause,
                    "days": 60.0 + i,
                }
            )
    return pd.DataFrame(rows)


def test_batch_card_odds_causes_and_months():
    df = _summary(
        {
            5: [("arrived", "arrived")] * 8 + [("lost", "ship_strike")] * 2,
            11: [("arrived", "arrived")] * 2
            + [("timeout", "battery_empty")] * 7
            + [("left_data_box", "off_course_timeout")],
        }
    )
    card = batch_card(df)
    assert card.runs == 20 and card.arrived == 10 and card.rate == 0.5
    assert card.low < 0.5 < card.high
    assert card.causes == {
        "arrived": 10,
        "battery_empty": 7,
        "ship_strike": 2,
        "left_data_box": 1,
    }
    may, nov = card.months
    assert (may.month, may.rate, nov.month, nov.rate) == (5, 0.8, 11, 0.2)
    text = render_batch(card)
    assert "Chance of finishing        50%" in text
    assert "Only 20 runs" in text  # small sample flagged
    assert "Nov" in text and "Battery ran flat" in text


def test_batch_card_works_on_plain_run_batch_output():
    df = pd.DataFrame(
        [{"start": datetime(2020, 10, 1), "outcome": "arrived", "days": 56.0, "seed": 0}]
    )
    card = batch_card(df)
    assert card.rate == 1.0 and card.causes == {}
    assert any("didn't record causes" in w for w in card.warnings)
    render_batch(card)
