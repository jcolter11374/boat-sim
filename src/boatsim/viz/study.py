"""Results page from Ravi's sensitivity study (mc.sensitivity): the page John reads.

The study sails the same April to June launches with one change at a time, so
it answers the questions the plain odds report can't:

1. Headline: the design's chance of finishing, labelled with the shakedown
   assumption it rests on, and the no-shakedown number beside it.
2. Old finish rule vs the Microtransat rule (why the old 93% is retired).
3. Where to aim on the Microtransat finish line (the finish-target sweep).
4. Everything else the study tried (comms, hazards, battery, motors...).
5. Optional: the baseline voyages by launch month and how they ended.

Inputs: the `sensitivity_compare.csv` table from `mc.sensitivity report` (one
row per variant) and, optionally, the per-voyage rows (variant, start, outcome,
ending at least) for the month and endings charts.

    python -m boatsim.viz.study sensitivity_compare.csv --voyages sensitivity_all.csv \
        --out runs/study.html

Owner: Iris.
"""

from __future__ import annotations

import html
from pathlib import Path

import pandas as pd

from boatsim.viz.card import wilson
from boatsim.viz.html import (
    _CSS,
    _MONTHS,
    _PCT_TICKS,
    BAR,
    BAR_OUTSIDE,
    INK_2,
    MUTED,
    _layout,
    sensitivity_figure,
    sensitivity_rows,
)

# Finish targets on the Microtransat eastern line, north to south (mc.sensitivity).
TARGETS = ["target_51n", "target_46n", "target_44_5n", "target_39_5n", "target_37n"]
SHOWN_ELSEWHERE = {"baseline", "old_rule", "no_shakedown", *TARGETS}
RETIRED = "#898781"  # grey: the retired old-rule figure


def _row(t: pd.DataFrame, name: str) -> pd.Series | None:
    r = t[t["variant"] == name]
    return None if r.empty else r.iloc[0]


def _pct(x: float) -> str:
    return f"{100 * x:.0f}%"


def _unknown(r: pd.Series) -> str:
    """'x% to y%' with unknown failures put back, if the table has them."""
    a, b = r.get("odds_unknown_50"), r.get("odds_unknown_10")
    if a is None or b is None or pd.isna(a) or pd.isna(b):
        return ""
    return f"{_pct(a)} to {_pct(b)}"


def hero_html(t: pd.DataFrame, shakedown_days: int = 14) -> str:
    """The headline: design odds (assumes a shakedown) with no-shakedown beside it."""
    b = _row(t, "baseline")
    if b is None:
        return ""
    cells = []
    for r, label in (
        (b, f"assumes a {shakedown_days}-day shakedown"),
        (_row(t, "no_shakedown"), "with no shakedown"),
    ):
        if r is None:
            continue
        unk = _unknown(r)
        extra = (
            f"<div class='range'>{unk} once failures we can't model are added</div>" if unk else ""
        )
        cells.append(
            f"""<div class="cell">
  <div class="tag">{html.escape(label)}</div>
  <div class="big">{_pct(r["odds"])}</div>
  <div class="range">{int(r["arrived"])} of {int(r["voyages"])} simulated launches finished;
  95% range {_pct(r["low95"])} to {_pct(r["high95"])}</div>{extra}
</div>"""
        )
    return f"""<div class="hero">
  <div>Chance of finishing under Microtransat rules (within 25 km of the target off Portugal),
  April to June launches</div>
  <div class="cells">{"".join(cells)}</div>
</div>"""


def _odds_bars(rows: list[tuple[str, pd.Series, str]], title: str, height: int = 0):
    """Horizontal bars of finishing odds with 95% ranges; rows = (label, row, colour)."""
    import plotly.graph_objects as go

    labels = [lab for lab, _, _ in rows]
    odds = [100 * r["odds"] for _, r, _ in rows]
    text = []
    for _, r, _ in rows:
        s = f"{_pct(r['odds'])}  ({int(r['arrived'])} of {int(r['voyages'])})"
        if pd.notna(r.get("median_days")):
            s += f" · median {r['median_days']:.0f} days"
        text.append(s)
    fig = go.Figure(
        go.Bar(
            y=labels,
            x=odds,
            orientation="h",
            marker={"color": [c for _, _, c in rows], "cornerradius": 4},
            error_x={
                "type": "data",
                "symmetric": False,
                "array": [100 * (r["high95"] - r["odds"]) for _, r, _ in rows],
                "arrayminus": [100 * (r["odds"] - r["low95"]) for _, r, _ in rows],
                "color": INK_2,
                "thickness": 1.5,
                "width": 4,
            },
            hovertemplate="%{y}: %{x:.0f}% finished<extra></extra>",
        )
    )
    # Labels sit just past each bar's 95% whisker so the two never overlap.
    fig.add_trace(
        go.Scatter(
            y=labels,
            x=[100 * r["high95"] + 2 for _, r, _ in rows],
            mode="text",
            text=text,
            textposition="middle right",
            textfont={"color": INK_2},
            cliponaxis=False,
            hoverinfo="skip",
            showlegend=False,
        )
    )
    _layout(fig, title, height=height or 90 + 48 * len(rows), bargap=0.35)
    fig.update_xaxes(range=[0, 150], **_PCT_TICKS)
    fig.update_yaxes(autorange="reversed")
    fig.update_layout(margin={"l": 330, "r": 30, "t": 50, "b": 40})
    return fig


def rule_figure(t: pd.DataFrame):
    """Old finish rule (any landfall in Europe or the Azores) vs the Microtransat target."""
    old, new = _row(t, "old_rule"), _row(t, "baseline")
    if old is None or new is None:
        return None
    return _odds_bars(
        [
            ("Old rule: any landfall in Europe or the Azores (retired)", old, RETIRED),
            ("Microtransat rule: reach the target off Portugal", new, BAR),
        ],
        "Old finish rule vs the Microtransat rule (same launches, same luck)",
    )


def target_figure(t: pd.DataFrame):
    """Finishing odds for each finish target, north to south, plus the current plan."""
    rows = []
    for name in TARGETS:
        r = _row(t, name)
        if r is not None:
            label = (
                str(r["label"])
                .replace("Finish target at ", "")
                .replace(", straight route there", "")
            )
            rows.append((f"{label}, straight", r, BAR_OUTSIDE))
    b = _row(t, "baseline")
    if not rows or b is None:
        return None
    rows.append(("Current plan: 39.5N 13.5W, south of the Azores", b, BAR))
    return _odds_bars(rows, "Chance of finishing for each finish target (north to south)")


def month_figure(voyages: pd.DataFrame):
    """Baseline odds for each launch month in the study."""
    import plotly.graph_objects as go

    g = voyages[voyages["variant"] == "baseline"] if "variant" in voyages else voyages
    month = pd.to_datetime(g["start"]).dt.month
    xs, ys, hi, lo, cd = [], [], [], [], []
    for m in sorted(month.unique()):
        s = g[month == m]
        k = int((s["outcome"] == "arrived").sum())
        p, a, b = wilson(k, len(s))
        xs.append(_MONTHS[m - 1])
        ys.append(100 * p)
        hi.append(100 * (b - p))
        lo.append(100 * (p - a))
        cd.append([k, len(s), 100 * a, 100 * b])
    fig = go.Figure(
        go.Bar(
            x=xs,
            y=ys,
            marker={"color": BAR, "cornerradius": 4},
            error_y={
                "type": "data",
                "symmetric": False,
                "array": hi,
                "arrayminus": lo,
                "color": INK_2,
                "thickness": 1.5,
                "width": 4,
            },
            customdata=cd,
            hovertemplate=(
                "%{x}: %{y:.0f}% finished<br>%{customdata[0]} of %{customdata[1]} runs<br>"
                "95% range %{customdata[2]:.0f}% to %{customdata[3]:.0f}%<extra></extra>"
            ),
        )
    )
    _layout(
        fig,
        "Chance of finishing, by launch month (the design as it stands)",
        height=300,
        bargap=0.45,
    )
    fig.update_yaxes(range=[0, 105], **_PCT_TICKS)
    return fig


ENDINGS = {  # mc.months.cause_of_end strings, in words for John
    "arrived": "Finished (reached the target)",
    "still at sea": "Still at sea when the time ran out",
    "ran aground before the finish": "Reached land before the finish (not a finish)",
    "disqualified: silent too long": "Silent too long (disqualified)",
    "left the weather box": "Blown out of the weather data area",
}


def endings_figure(voyages: pd.DataFrame):
    import plotly.graph_objects as go

    g = voyages[voyages["variant"] == "baseline"] if "variant" in voyages else voyages
    counts = g["ending"].fillna("unknown").value_counts().sort_values()
    labels = [ENDINGS.get(e, str(e)[:1].upper() + str(e)[1:]) for e in counts.index]
    pct = [100 * n / len(g) for n in counts]
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
    _layout(fig, "How the voyages ended (the design as it stands)", height=80 + 40 * len(counts))
    fig.update_xaxes(range=[0, 118], showticklabels=False, showgrid=False)
    fig.update_layout(margin={"l": 330, "r": 20, "t": 50, "b": 20})
    return fig


def _compare_table(t: pd.DataFrame) -> str:
    head = "".join(
        f"<th>{h}</th>"
        for h in ("Change", "Finished", "Odds (95% range)", "With unknown failures", "Median days")
    )
    body = []
    for _, r in t.iterrows():
        md = "" if pd.isna(r.get("median_days")) else f"{r['median_days']:.0f}"
        body.append(
            f"<tr><td>{html.escape(str(r['label']))}</td>"
            f"<td>{int(r['arrived'])}/{int(r['voyages'])}</td>"
            f"<td>{_pct(r['odds'])} ({_pct(r['low95'])} to {_pct(r['high95'])})</td>"
            f"<td>{_unknown(r)}</td><td>{md}</td></tr>"
        )
    return f"<table><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


_STUDY_CSS = f"""
.hero .cells {{ display: flex; flex-wrap: wrap; gap: 32px; margin-top: 8px; }}
.hero .cell {{ flex: 1 1 260px; }}
.hero .cell + .cell {{ border-left: 1px solid rgba(11,11,11,0.10); padding-left: 32px; }}
.hero .cell + .cell .big {{ color: {INK_2}; }}
.hero .tag {{ font-weight: 600; color: {INK_2}; }}
.retired {{ border-left: 3px solid {MUTED}; padding: 8px 12px; margin: 16px 0;
  background: #f1f0ec; }}
"""


def study_html(
    compare: pd.DataFrame,
    voyages: pd.DataFrame | None = None,
    title: str = "Boat simulator: chance of finishing",
    subtitle: str = "",
    banner: str = "",
    retired: str = "",
    notes: dict[str, str] | None = None,
    shakedown_days: int = 14,
) -> str:
    """The results page as a string.

    retired: text for a grey "retired figure" box under the headline.
    notes: extra text appended under a section, keyed by "rule", "targets",
    "other", "months", "endings".
    """
    notes = notes or {}
    figs: list[tuple[str, object, str]] = []
    rule = rule_figure(compare)
    if rule is not None:
        figs.append(
            (
                "Why the old figure is retired: the finish rule changed",
                rule,
                "The old rule counted any landfall in Europe or the Azores as success. "
                "The Microtransat rule only counts reaching a 25 km circle on the race's "
                "finish line west of Lisbon; touching land anywhere ends the voyage. "
                "Same launches, same luck, only the rule (and the route that suits it) "
                "differs. " + notes.get("rule", ""),
            )
        )
    targets = target_figure(compare)
    if targets is not None:
        figs.append(
            (
                "Where to aim on the finish line",
                targets,
                "We pick our 25 km target circle before launch, anywhere on the race's "
                "eastern line. Each pale bar sails straight to a different target (that "
                "route passes north of the Azores); the strong bar is the current plan, "
                "which dog-legs south of the Azores. The thin line on each bar is its 95% "
                "range. " + notes.get("targets", ""),
            )
        )
    others = compare[~compare["variant"].isin(SHOWN_ELSEWHERE)]
    if len(others) and _row(compare, "baseline") is not None:
        base = compare[compare["variant"] == "baseline"]
        rows = sensitivity_rows([pd.concat([base, others], ignore_index=True)])
        figs.append(
            (
                "What else changes the odds",
                sensitivity_figure(rows),
                "Each bar is one change to the boat or its settings, tried on the same "
                "launches with the same luck, so only the change differs. Strong blue bars "
                "are differences too big to be luck; pale bars are within noise. "
                + notes.get("other", ""),
            )
        )
    if voyages is not None and len(voyages):
        figs.append(
            (
                "Odds by launch month",
                month_figure(voyages),
                "The design as it stands, split by launch month. " + notes.get("months", ""),
            )
        )
        if "ending" in voyages:
            figs.append(
                (
                    "How the voyages ended",
                    endings_figure(voyages),
                    "One ending per voyage. " + notes.get("endings", ""),
                )
            )
    parts = []
    for i, (heading, fig, note) in enumerate(figs):
        div = fig.to_html(
            full_html=False,
            include_plotlyjs=(i == 0),
            config={
                "displaylogo": False,
                "responsive": True,
                "modeBarButtonsToRemove": ["toImage"],
            },
        )
        parts.append(
            f"<h2>{html.escape(heading)}</h2><p>{html.escape(note.strip())}</p>"
            f'<div class="chart">{div}</div>'
        )
    banner_html = f'<div class="banner">{html.escape(banner)}</div>' if banner else ""
    retired_html = f'<div class="retired">{html.escape(retired)}</div>' if retired else ""
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title><style>{_CSS}{_STUDY_CSS}</style></head>
<body><main>
<h1>{html.escape(title)}</h1>
<p>{html.escape(subtitle)}</p>
{banner_html}
{hero_html(compare, shakedown_days)}
{retired_html}
{"".join(parts)}
<h2>Every change tried</h2>
<details><summary>Show the table ({len(compare)} rows)</summary>{_compare_table(compare)}</details>
</main></body></html>
"""
    return page.replace("�", "\\uFFFD")  # see viz.html.report_html


def main(argv: list[str] | None = None) -> None:
    import argparse

    ap = argparse.ArgumentParser(description="Write the results page from a sensitivity study.")
    ap.add_argument("compare", help="sensitivity_compare.csv from mc.sensitivity report")
    ap.add_argument("--voyages", nargs="*", default=[], help="per-voyage study CSV(s)")
    ap.add_argument("--out", default="runs/study.html")
    ap.add_argument("--title", default="Boat simulator: chance of finishing")
    ap.add_argument("--subtitle", default="")
    ap.add_argument("--banner", default="")
    ap.add_argument("--retired", default="", help="text for the retired-figure box")
    for key in ("rule", "targets", "other", "months", "endings"):
        ap.add_argument(f"--note-{key}", default="")
    ap.add_argument("--shakedown-days", type=int, default=14)
    a = ap.parse_args(argv)
    voyages = (
        pd.concat([pd.read_csv(f) for f in a.voyages], ignore_index=True) if a.voyages else None
    )
    notes = {k: getattr(a, f"note_{k}") for k in ("rule", "targets", "other", "months", "endings")}
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(
        study_html(
            pd.read_csv(a.compare),
            voyages,
            a.title,
            a.subtitle,
            a.banner,
            a.retired,
            notes,
            a.shakedown_days,
        ),
        encoding="utf-8",
    )
    print(f"wrote {out}")


if __name__ == "__main__":
    main()
