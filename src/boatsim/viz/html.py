"""HTML report (#22): one self-contained file John can open in any browser.

Sections, top to bottom:
1. The headline: chance of reaching Europe, with its 95% range and warnings.
2. Odds by launch month, each bar with its range.
3. How the voyages ended (causes of loss).
4. Map of sample tracks, coloured by how they ended.
5. Battery charge over the voyage.
6. The plain-text report card and a table of every voyage.

Inputs are small on purpose (Priya: workers have ~0.5 GB each): the batch
summary DataFrame (one row per voyage, with card_row fields) and, optionally,
thinned tracks from `track_rows(log)`, which a worker can return instead of
the whole VoyageLog.

Needs the `reports` extra (Plotly). Plotly's JavaScript is embedded once, so
the charts work offline. The map's coastline outlines are fetched from
cdn.plot.ly when the page opens; without internet the map shows tracks only.

Command line, for a batch written as CSV (e.g. Ravi's runs/months/*.csv):
    python -m boatsim.viz.html runs/months/voyages_*.csv --out runs/report.html

Owner: Iris.
"""

from __future__ import annotations

import html
import json
from collections.abc import Iterable
from datetime import datetime
from pathlib import Path

import pandas as pd

from boatsim.runner.simulate import VoyageLog
from boatsim.types import Outcome
from boatsim.viz.card import (
    CAUSES,
    LEFT_DATA_BOX,
    SINGLE_TRACK_CAVEAT,
    batch_card,
    render_batch,
)

# Outcome colours: the first three slots of the validated categorical palette
# (all pairs pass the colour-blind checks). Aqua is below 3:1 contrast on the
# page, so every chart that uses it has a legend and the table repeats the data.
# Dict order is drawing order: losses are drawn last so the rarer, more
# interesting tracks sit on top.
OUTCOME_COLOURS = {
    "arrived": "#2a78d6",  # blue
    "at_sea": "#1baf7a",  # aqua: timed out or left the weather box
    "lost": "#eb6834",  # orange
}
OUTCOME_LABELS = {
    "arrived": "Reached Europe",
    "lost": "Lost at sea",
    "at_sea": "Still at sea at the end",
}
BAR = "#2a78d6"
INK, INK_2, MUTED, GRID, AXIS, SURFACE = (
    "#0b0b0b",
    "#52514e",
    "#898781",
    "#e1e0d9",
    "#c3c2b7",
    "#fcfcfb",
)
MAX_TRACKS = 150  # keeps the file small; tracks are illustrations, not the odds
_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def outcome_group(outcome: str) -> str:
    if outcome == Outcome.ARRIVED.value:
        return "arrived"
    if outcome == Outcome.LOST.value:
        return "lost"
    return "at_sea"  # timeout, left_data_box


def track_rows(log: VoyageLog, every_hours: float = 6.0) -> dict:
    """A thinned track for the report: plain lists, cheap to pickle from a worker.

    Keeps one point per `every_hours` plus the last point.
    """
    pts: list[tuple[float, float, float, float | None]] = []
    last_t = None
    for r in log.rows:
        if last_t is None or (r["t"] - last_t).total_seconds() >= every_hours * 3600 - 1:
            pts.append(_pt(r, log.start))
            last_t = r["t"]
    if log.rows and (not pts or pts[-1][0] != _pt(log.rows[-1], log.start)[0]):
        pts.append(_pt(log.rows[-1], log.start))
    return {
        "start": log.start,
        "seed": log.seed,
        "outcome": log.outcome.value,
        "day": [p[0] for p in pts],
        "lat": [p[1] for p in pts],
        "lon": [p[2] for p in pts],
        "soc": [p[3] for p in pts],
    }


def _pt(r: dict, start: datetime) -> tuple[float, float, float, float | None]:
    day = round((r["t"] - start).total_seconds() / 86400.0, 3)
    soc = r.get("soc")
    return day, float(r["lat"]), float(r["lon"]), None if soc is None else float(soc)


# ------------------------------------------------------------------ figures


def _layout(fig, title: str, height: int = 360, **kw) -> None:
    fig.update_layout(
        title={"text": title, "x": 0, "font": {"size": 16, "color": INK}},
        height=height,
        margin={"l": 60, "r": 20, "t": 50, "b": 50},
        paper_bgcolor=SURFACE,
        plot_bgcolor=SURFACE,
        font={"family": 'system-ui, -apple-system, "Segoe UI", sans-serif', "color": INK_2},
        hoverlabel={"bgcolor": "#ffffff", "font": {"color": INK}},
        **kw,
    )
    fig.update_xaxes(gridcolor=GRID, linecolor=AXIS, tickfont={"color": MUTED})
    fig.update_yaxes(gridcolor=GRID, linecolor=AXIS, tickfont={"color": MUTED})


def month_figure(card):
    import plotly.graph_objects as go

    months = [_MONTHS[m.month - 1] for m in card.months]
    rate = [m.rate * 100 for m in card.months]
    fig = go.Figure(
        go.Bar(
            x=months,
            y=rate,
            marker={"color": BAR, "cornerradius": 4},
            error_y={
                "type": "data",
                "symmetric": False,
                "array": [(m.high - m.rate) * 100 for m in card.months],
                "arrayminus": [(m.rate - m.low) * 100 for m in card.months],
                "color": INK_2,
                "thickness": 1.5,
                "width": 4,
            },
            customdata=[[m.arrived, m.runs, m.low * 100, m.high * 100] for m in card.months],
            hovertemplate=(
                "%{x}: %{y:.0f}% reached Europe<br>"
                "%{customdata[0]} of %{customdata[1]} runs<br>"
                "95% range %{customdata[2]:.0f}% to %{customdata[3]:.0f}%<extra></extra>"
            ),
        )
    )
    _layout(fig, "Chance of reaching Europe, by launch month", bargap=0.35)
    fig.update_yaxes(range=[0, 100], ticksuffix="%", title="")
    return fig


def causes_figure(card):
    import plotly.graph_objects as go

    items = sorted(card.causes.items(), key=lambda kv: kv[1])
    labels = [CAUSES.get(c, c) for c, _ in items]
    counts = [n for _, n in items]
    pct = [100 * n / card.runs for n in counts]
    fig = go.Figure(
        go.Bar(
            y=labels,
            x=pct,
            orientation="h",
            marker={"color": BAR, "cornerradius": 4},
            text=[f"{p:.0f}%  ({n})" for p, n in zip(pct, counts, strict=True)],
            textposition="outside",
            textfont={"color": INK_2},
            cliponaxis=False,
            hovertemplate="%{y}: %{x:.0f}%<extra></extra>",
        )
    )
    _layout(fig, "How the voyages ended", height=80 + 40 * len(items), bargap=0.4)
    fig.update_xaxes(range=[0, 115], showticklabels=False, showgrid=False)
    fig.update_layout(margin={"l": 360, "r": 20, "t": 50, "b": 20})
    return fig


def _pick_tracks(tracks: list[dict]) -> list[dict]:
    """At most MAX_TRACKS, keeping each outcome's share."""
    if len(tracks) <= MAX_TRACKS:
        return tracks
    step = len(tracks) / MAX_TRACKS
    return [tracks[int(i * step)] for i in range(MAX_TRACKS)]


def map_figure(tracks: list[dict]):
    import plotly.graph_objects as go

    fig = go.Figure()
    for group, colour in OUTCOME_COLOURS.items():
        sel = [t for t in tracks if outcome_group(t["outcome"]) == group]
        lat: list[float | None] = []
        lon: list[float | None] = []
        text: list[str | None] = []
        for t in sel:
            lat += t["lat"] + [None]
            lon += t["lon"] + [None]
            label = f"Launched {t['start']:%d %b %Y}"
            text += [f"{label}, day {d:.0f}" for d in t["day"]] + [None]
        fig.add_trace(
            go.Scattergeo(
                lat=lat,
                lon=lon,
                mode="lines",
                line={"width": 1.5, "color": colour},
                opacity=0.6,
                name=f"{OUTCOME_LABELS[group]} ({len(sel)})",
                text=text,
                hoverinfo="text",
            )
        )
    fig.add_trace(
        go.Scattergeo(
            lat=[36.85],
            lon=[-75.70],
            mode="markers",
            marker={"size": 9, "color": INK, "line": {"width": 2, "color": SURFACE}},
            name="Drop point",
            hovertext=["Drop point, east of the Chesapeake Bay mouth"],
            hoverinfo="text",
        )
    )
    _layout(fig, "Sample tracks", height=480)
    _geo(fig)
    fig.update_layout(legend={"orientation": "h", "y": -0.02})
    return fig


def battery_figure(tracks: list[dict]):
    import plotly.graph_objects as go

    fig = go.Figure()
    for group, colour in OUTCOME_COLOURS.items():
        sel = [t for t in tracks if outcome_group(t["outcome"]) == group]
        x: list[float | None] = []
        y: list[float | None] = []
        for t in sel:
            x += t["day"] + [None]
            y += [None if s is None else 100 * s for s in t["soc"]] + [None]
        fig.add_trace(
            go.Scatter(
                x=x,
                y=y,
                mode="lines",
                line={"width": 1.5, "color": colour},
                opacity=0.45,
                name=f"{OUTCOME_LABELS[group]} ({len(sel)})",
                hovertemplate="day %{x:.0f}: %{y:.0f}% charge<extra></extra>",
            )
        )
    fig.add_hline(
        y=15,
        line={"dash": "dot", "color": MUTED, "width": 1},
        annotation_text="15%: safe mode stops the motors to recharge",
        annotation_font_color=INK_2,
        annotation_position="bottom right",
    )
    _layout(fig, "Battery charge during each voyage", height=380)
    fig.update_xaxes(title="days since launch")
    fig.update_yaxes(range=[0, 102], ticksuffix="%")
    fig.update_layout(legend={"orientation": "h", "y": -0.2}, hovermode="closest")
    return fig


# ---------------------------------------------- batch-only figures (no tracks)

# Ordinal blue ramp for the "unknown failure" sweep: darker = more failures.
SWEEP_RAMP = ["#86b6ef", "#5598e7", "#2a78d6", "#1c5cab", "#104281"]


def has_unknown_sweep(summary: pd.DataFrame) -> bool:
    """True when the batch ran with the catch-all "unknown failure" switched off,
    so the report can put it back at several values (mc/months.py)."""
    return (
        len(summary) > 0
        and "unknown_p_run" in summary
        and "days" in summary
        and bool((summary["unknown_p_run"].fillna(-1) == 0.0).all())
    )


def sweep_figure(summary: pd.DataFrame):
    import plotly.graph_objects as go

    from boatsim.mc.months import SWEEP, sweep_table

    t = sweep_table(summary.assign(month=pd.to_datetime(summary["start"]).dt.month))
    t = t[(t["month"] != "All") & (t["voyages"] > 0)]
    fig = go.Figure()
    model = [
        100 * float((g["outcome"] == Outcome.ARRIVED.value).mean())
        for _, g in summary.groupby(pd.to_datetime(summary["start"]).dt.month)
    ]
    fig.add_trace(
        go.Scatter(
            x=list(t["month"]),
            y=model,
            mode="lines+markers",
            line={"width": 2, "color": INK, "dash": "dot"},
            marker={"size": 8},
            name="Model alone (no unknown failures)",
            hovertemplate="%{x}: %{y:.0f}%, model alone<extra></extra>",
        )
    )
    for p, colour in zip(SWEEP, SWEEP_RAMP, strict=True):
        fig.add_trace(
            go.Scatter(
                x=list(t["month"]),
                y=list(100 * t[f"p{p:g}"]),
                mode="lines+markers",
                line={"width": 2, "color": colour},
                marker={"size": 8, "line": {"width": 2, "color": SURFACE}},
                name=f"{p:.0%} fail by day 60",
                hovertemplate=f"%{{x}}: %{{y:.0f}}% if {p:.0%} fail by day 60<extra></extra>",
            )
        )
    _layout(fig, "Chance of reaching Europe, by launch month and unknown-failure rate", 420)
    fig.update_yaxes(range=[0, 102], ticksuffix="%")
    fig.update_layout(legend={"orientation": "h", "y": -0.15}, hovermode="x unified")
    return fig


def endpoints_figure(summary: pd.DataFrame):
    """Where each voyage ended, coloured by outcome (the batch CSVs carry no tracks)."""
    import plotly.graph_objects as go

    fig = go.Figure()
    groups = summary["outcome"].map(outcome_group)
    for group, colour in OUTCOME_COLOURS.items():
        g = summary[groups == group].dropna(subset=["end_lat", "end_lon"])
        label = pd.to_datetime(g["start"]).dt.strftime("Launched %d %b %Y")
        text = (
            label
            + ", "
            + g.get("days", pd.Series(0, index=g.index)).round(0).astype(int).astype(str)
            + " days"
        )
        fig.add_trace(
            go.Scattergeo(
                lat=g["end_lat"],
                lon=g["end_lon"],
                mode="markers",
                marker={
                    "size": 8,
                    "color": colour,
                    "opacity": 0.8,
                    "line": {"width": 1, "color": SURFACE},
                },
                name=f"{OUTCOME_LABELS[group]} ({len(g)})",
                text=text,
                hoverinfo="text",
            )
        )
    fig.add_trace(
        go.Scattergeo(
            lat=[36.85],
            lon=[-75.70],
            mode="markers",
            marker={"size": 10, "color": INK, "symbol": "star"},
            name="Drop point",
            hovertext=["Drop point, east of the Chesapeake Bay mouth"],
            hoverinfo="text",
        )
    )
    _layout(fig, "Where each voyage ended", height=480)
    _geo(fig)
    fig.update_layout(legend={"orientation": "h", "y": -0.02})
    return fig


def _geo(fig) -> None:
    fig.update_geos(
        projection_type="natural earth",
        lataxis_range=[20, 65],
        lonaxis_range=[-85, 10],
        showland=True,
        landcolor="#f0efec",
        showocean=True,
        oceancolor=SURFACE,
        coastlinecolor=AXIS,
        countrycolor=GRID,
        showcountries=True,
        bgcolor=SURFACE,
    )


def solar_figure(summary: pd.DataFrame):
    """Median solar energy harvested per day, by launch month."""
    import plotly.graph_objects as go

    m = pd.to_datetime(summary["start"]).dt.month
    med = summary.groupby(m)["solar_wh_day"].median()
    fig = go.Figure(
        go.Bar(
            x=[_MONTHS[i - 1] for i in med.index],
            y=med.values,
            marker={"color": BAR, "cornerradius": 4},
            hovertemplate="%{x} launches: %{y:.0f} Wh a day from the panels<extra></extra>",
        )
    )
    _layout(fig, "Solar energy per day at sea (median), by launch month", bargap=0.35)
    fig.update_yaxes(ticksuffix=" Wh", rangemode="tozero")
    return fig


def lowest_charge_figure(summary: pd.DataFrame):
    """Each voyage's lowest battery charge, by launch month, coloured by outcome."""
    import plotly.graph_objects as go

    fig = go.Figure()
    months = pd.to_datetime(summary["start"]).dt.month
    groups = summary["outcome"].map(outcome_group)
    offsets = {"arrived": -0.2, "at_sea": 0.0, "lost": 0.2}
    for group, colour in OUTCOME_COLOURS.items():
        sel = groups == group
        g = summary[sel]
        fig.add_trace(
            go.Scatter(
                x=months[sel] + offsets[group],
                y=100 * g["min_soc"],
                mode="markers",
                marker={
                    "size": 8,
                    "color": colour,
                    "opacity": 0.8,
                    "line": {"width": 1, "color": SURFACE},
                },
                name=f"{OUTCOME_LABELS[group]} ({int(sel.sum())})",
                text=pd.to_datetime(g["start"]).dt.strftime("Launched %d %b %Y"),
                hovertemplate="%{text}: lowest charge %{y:.0f}%<extra></extra>",
            )
        )
    fig.add_hline(
        y=15,
        line={"dash": "dot", "color": MUTED, "width": 1},
    )
    _layout(fig, "Lowest battery charge on each voyage, by launch month", height=400)
    fig.update_xaxes(
        tickvals=list(range(1, 13)), ticktext=_MONTHS, range=[0.5, 12.5], showgrid=False
    )
    fig.update_yaxes(range=[0, 102], ticksuffix="%")
    fig.update_layout(legend={"orientation": "h", "y": -0.15})
    return fig


# ------------------------------------------------------------------- page

_CSS = f"""
body {{ margin: 0; background: #f9f9f7; color: {INK};
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.5; }}
main {{ max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }}
h1 {{ font-size: 24px; margin: 0 0 4px; }}
h2 {{ font-size: 18px; margin: 40px 0 8px; }}
p, li {{ color: {INK_2}; }}
.hero {{ background: {SURFACE}; border: 1px solid rgba(11,11,11,0.10); border-radius: 8px;
  padding: 20px 24px; margin: 20px 0; }}
.hero .big {{ font-size: 48px; font-weight: 600; color: {INK}; }}
.hero .range {{ font-size: 18px; color: {INK_2}; }}
.banner {{ background: #fff4d6; border: 1px solid #fab219; border-radius: 8px;
  padding: 12px 16px; margin: 16px 0; color: {INK}; }}
.warn {{ border-left: 3px solid #fab219; padding: 8px 12px; margin: 16px 0;
  background: {SURFACE}; }}
.warn li {{ margin: 2px 0; }}
.chart {{ background: {SURFACE}; border: 1px solid rgba(11,11,11,0.10); border-radius: 8px;
  margin: 12px 0; padding: 4px; }}
pre {{ background: {SURFACE}; border: 1px solid rgba(11,11,11,0.10); border-radius: 8px;
  padding: 16px; overflow-x: auto; font-size: 13px; }}
table {{ border-collapse: collapse; width: 100%; font-size: 13px; background: {SURFACE};
  font-variant-numeric: tabular-nums; }}
th, td {{ text-align: left; padding: 4px 8px; border-bottom: 1px solid {GRID}; }}
th {{ color: {INK_2}; font-weight: 600; }}
details summary {{ cursor: pointer; color: {INK_2}; margin: 8px 0; }}
"""


def _table(summary: pd.DataFrame) -> str:
    cols = [
        ("start", "Launched"),
        ("outcome", "Outcome"),
        ("cause", "How it ended"),
        ("days", "Days"),
        ("km_to_go", "Km short"),
        ("min_soc", "Lowest battery"),
        ("trouble_day", "Trouble day"),
        ("trouble", "First trouble"),
        ("airtime_usd", "Satellite bill"),
    ]
    cols = [(k, v) for k, v in cols if k in summary]
    head = "".join(f"<th>{html.escape(v)}</th>" for _, v in cols)
    body = []
    for _, r in summary.iterrows():
        cells = []
        for k, _ in cols:
            v = r[k]
            if v is None or (isinstance(v, float) and pd.isna(v)):
                s = ""
            elif k == "start":
                s = f"{pd.Timestamp(v):%Y-%m-%d}"
            elif k == "cause":
                s = CAUSES.get(v, str(v))
            elif k == "min_soc":
                s = f"{v:.0%}"
            elif k == "airtime_usd":
                s = f"${v:,.2f}"
            elif k in ("days", "trouble_day"):
                s = f"{v:.1f}"
            elif k == "km_to_go":
                s = f"{v:,.0f}"
            else:
                s = str(v)
            cells.append(f"<td>{html.escape(s)}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def report_html(
    summary: pd.DataFrame,
    tracks: Iterable[dict] | None = None,
    title: str = "Voyage odds report",
    subtitle: str = "",
    banner: str = "",
    topojson: str | Path | None = None,
) -> str:
    """Build the report page as a string. See module docstring for inputs.

    banner: an optional highlighted note at the top, e.g. "Preliminary".
    topojson: path to Plotly's world_110m.json (npm package sane-topojson). If
    given, the map outlines are embedded, so the map works with no internet and
    on hosts that block outside downloads (e.g. claude.ai artifacts).
    """
    card = batch_card(summary)
    tracks = _pick_tracks(list(tracks or []))
    sweep = has_unknown_sweep(summary)
    coast_note = "" if topojson is not None else " (The coastlines load from the internet.)"
    figs: list[tuple[str, object, str]] = []
    if sweep:
        figs.append(
            (
                "The big unknown: failures we can't model",
                sweep_figure(summary),
                (
                    "Real small robot boats mostly die of things nobody predicted: leaks, "
                    "electronics, fishing gear. The model can't simulate those, so we add a "
                    "catch-all 'unknown failure' and try several guesses for how common it is "
                    "(the share of boats it would kill within 60 days). The dotted line is the "
                    "model alone. Darker lines assume more unknown failures. Past small robot "
                    "boat attempts suggest the darker lines are closer to the truth."
                ),
            )
        )
    if card.months:
        figs.append(
            (
                "Odds by launch month",
                month_figure(card),
                (
                    "Each bar is the share of simulated launches in that month that reached "
                    "Europe. The thin line on each bar is the 95% range: with this many runs, "
                    "the true odds are probably somewhere inside it."
                    + (
                        " These bars are the model alone, with no unknown failures."
                        if sweep
                        else ""
                    )
                ),
            )
        )
    if card.causes:
        figs.append(
            (
                "How the voyages ended",
                causes_figure(card),
                (
                    "One cause per voyage: whatever ended it, or the state it was in when "
                    "the time limit ran out."
                ),
            )
        )
    if tracks:
        figs.append(
            (
                "Where the boats went",
                map_figure(tracks),
                (
                    f"A sample of up to {MAX_TRACKS} simulated tracks. {SINGLE_TRACK_CAVEAT}"
                    f"{coast_note}"
                ),
            )
        )
        figs.append(
            (
                "Battery",
                battery_figure(tracks),
                (
                    "Charge left in the battery each day. Dips are nights and cloudy days; "
                    "a line stuck near the bottom means the boat is drifting while it recharges."
                ),
            )
        )
    if not tracks and {"end_lat", "end_lon"} <= set(summary.columns):
        figs.append(
            (
                "Where the boats ended up",
                endpoints_figure(summary),
                (
                    "One dot per voyage, where it arrived, sank or was when time ran out. "
                    f"{SINGLE_TRACK_CAVEAT}{coast_note}"
                ),
            )
        )
    if "solar_wh_day" in summary and summary["solar_wh_day"].notna().any():
        figs.append(
            (
                "Sun",
                solar_figure(summary),
                (
                    "How much energy the solar panels made per day, on average over the "
                    "voyage. The boat needs about 85 Wh a day for its electronics before "
                    "the motors get anything."
                ),
            )
        )
    if not tracks and "min_soc" in summary and summary["min_soc"].notna().any():
        figs.append(
            (
                "Battery",
                lowest_charge_figure(summary),
                (
                    "Each dot is one voyage's lowest battery charge. Below 15% (the dotted "
                    "line) the boat stops its motors and drifts until the sun recharges it."
                ),
            )
        )

    parts = []
    for i, (heading, fig, note) in enumerate(figs):
        div = fig.to_html(
            full_html=False,
            include_plotlyjs=(i == 0),  # embed Plotly once: the file works offline
            config={
                "displaylogo": False,
                "responsive": True,
                "modeBarButtonsToRemove": ["toImage"],
            },
        )
        parts.append(
            f"<h2>{html.escape(heading)}</h2><p>{html.escape(note)}</p>"
            f'<div class="chart">{div}</div>'
        )

    warnings = "".join(f"<li>{html.escape(w)}</li>" for w in card.warnings)
    days = ""
    if card.days_median is not None:
        a, b = card.days_range
        days = (
            f"<p>Boats that made it took a median of {card.days_median:.0f} days "
            f"(from {a:.0f} to {b:.0f}).</p>"
        )
    airtime = ""
    if card.airtime_median_usd is not None:
        airtime = f"<p>Satellite bill: median ${card.airtime_median_usd:,.2f} per voyage.</p>"
    left_box = ""
    if len(summary) and (summary["outcome"] == LEFT_DATA_BOX).any():
        left_box = (
            "<p>“Still at sea” includes boats blown out of the area we have weather "
            "data for; those runs stop there.</p>"
        )
    geo_assets = ""
    if topojson is not None:
        world = json.dumps(json.loads(Path(topojson).read_text(encoding="utf-8")))
        geo_assets = (
            "<script>window.PlotlyGeoAssets={topojson:{world_110m:"
            + world.replace("</", "<\\/")
            + "}};</script>"
        )
    banner_html = f'<div class="banner">{html.escape(banner)}</div>' if banner else ""
    if sweep:
        from boatsim.mc.months import SWEEP, swept_odds

        lo_p, hi_p = swept_odds(summary, max(SWEEP)), swept_odds(summary, min(SWEEP))
        hero = f"""<div class="hero">
  <div>Chance of reaching Europe (Azores included), all launch months together</div>
  <div class="big">{lo_p:.0%} to {hi_p:.0%}</div>
  <div class="range">depending on how often failures we can't model happen (see below).
    The model alone says {card.rate:.0%} ({card.arrived} of {card.runs} simulated launches
    arrived; 95% range {card.low:.0%} to {card.high:.0%}).</div>
</div>"""
    else:
        hero = f"""<div class="hero">
  <div>Chance of reaching Europe (Azores included)</div>
  <div class="big">{card.rate:.0%}</div>
  <div class="range">95% range {card.low:.0%} to {card.high:.0%} ·
    {card.arrived} of {card.runs} simulated launches arrived</div>
</div>"""
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title><style>{_CSS}</style>{geo_assets}</head>
<body><main>
<h1>{html.escape(title)}</h1>
<p>{html.escape(subtitle)}</p>
{banner_html}
{hero}
{days}{airtime}{left_box}
<div class="warn"><strong>Read with care</strong><ul>{warnings}</ul></div>
{"".join(parts)}
<h2>Report card</h2>
<pre>{html.escape(render_batch(card))}</pre>
<h2>Every voyage</h2>
<details><summary>Show the table ({card.runs} rows)</summary>{_table(summary)}</details>
</main></body></html>
"""
    # Plotly's bundle has one raw U+FFFD inside a regex; write it as the
    # equivalent escape so strict UTF-8 checkers (e.g. artifact hosts) accept it.
    return page.replace("\ufffd", "\\uFFFD")


def write_report(
    path: str | Path,
    summary: pd.DataFrame,
    tracks: Iterable[dict] | None = None,
    title: str = "Voyage odds report",
    subtitle: str = "",
    banner: str = "",
    topojson: str | Path | None = None,
) -> Path:
    """Write the self-contained HTML report and return its path."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        report_html(summary, tracks, title, subtitle, banner, topojson), encoding="utf-8"
    )
    return path


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Write the HTML voyage report from batch CSVs.")
    ap.add_argument("csv", nargs="+", help="batch summary CSV file(s), one row per voyage")
    ap.add_argument("--out", default="runs/report.html")
    ap.add_argument("--title", default="Voyage odds report")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--banner", default="", help="highlighted note at the top")
    ap.add_argument("--topojson", default=None, help="embed this world_110m.json map outline")
    args = ap.parse_args(argv)
    df = pd.concat([pd.read_csv(f, parse_dates=["start"]) for f in args.csv], ignore_index=True)
    out = write_report(
        args.out,
        df,
        title=args.title,
        subtitle=args.subtitle,
        banner=args.banner,
        topojson=args.topojson,
    )
    print(f"wrote {out} ({len(df)} voyages)")


if __name__ == "__main__":
    main()
