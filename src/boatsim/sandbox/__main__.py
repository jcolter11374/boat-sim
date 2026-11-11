"""python -m boatsim.sandbox cut|pack|reference

cut 2020 --out site/sandbox/forcing_2020.npz [--no-currents]
    the season's forcing bundle, from the ERA5/GLORYS caches (Actions)
pack --out site/sandbox/boatsim.zip [--commit SHA]
    the simulator's source, design files and land mask, for Pyodide; the commit
    goes into boatsim_build.json in the zip and boatsim.json beside it
check-page --zip dist/sandbox/boatsim.zip --needs sea3d/sandbox-needs.json
           --slots sea3d/public/sim-slots.json [--commit SHA]
    fails if the zip lacks anything the pages ask for, or was packed from
    another commit (sea3d.yml, before it deploys)
reference --bundle forcing_2020.npz --out ref.json [--builds ...]
    every launch of the given grid builds (default: the kayak as it stands),
    in this Python; Actions runs the same in Node + Pyodide and compares
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from datetime import date
from pathlib import Path

PACK_FILES = (
    "configs/v4_kayak.yaml",
    "configs/randolph_rev_b.yaml",
    "configs/randolph_rev_c.yaml",
    # Stock vessels and the joke fleet (sandbox/catalog.py STOCK_BASES) and the
    # keelboats' polars.
    "configs/stock_cruiser31.yaml",
    "configs/stock_dinghy14.yaml",
    "configs/stock_beachcat16.yaml",
    "configs/stock_sail_drone7.yaml",
    "configs/stock_ocean_rower45.yaml",
    "configs/polars/cruiser31.json",
    "configs/polars/dinghy14.json",
    "configs/polars/beachcat16.json",
    "configs/joke_robot_kayak.yaml",
    "configs/joke_canoe.yaml",
    "configs/joke_pedalo.yaml",
    "configs/joke_bathtub.yaml",
    "configs/joke_flamingo.yaml",
    "configs/joke_wheelie_bin.yaml",
    "data/land/land_mask_v1.npz",
    # Ports to sail from (oceandata/ports.py; Game(start_port=...)).
    "sea3d/public/ports.json",
)


BUILD_FILE = "boatsim_build.json"  # in the zip: which commit it was packed from


def pack(out: Path, root: Path = Path("."), commit: str | None = None) -> int:
    """Zip src/boatsim (Python files only) plus the files a voyage reads at run
    time. The page unpacks it into Pyodide's file system and runs from there.
    With a commit, it is written into the zip (boatsim_build.json) and beside it
    (boatsim.json), so a deployed page can be checked against its simulator."""
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    build = json.dumps({"commit": commit})
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr(BUILD_FILE, build)
        n += 1
        for f in sorted((root / "src").rglob("*.py")):
            if "__pycache__" not in f.parts:
                z.write(f, f.relative_to(root / "src"))
                n += 1
        for name in PACK_FILES:
            z.write(root / name, name)
            n += 1
    out.with_name("boatsim.json").write_text(build)
    return n


# Run in a fresh interpreter, inside the unpacked zip, the way the pages run it:
# the zip's own code answers, never the working tree's.
_CAPS_SCRIPT = """
import json, os, sys, warnings, zipfile
warnings.simplefilter("ignore")
zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])
sys.path.insert(0, sys.argv[2])
os.chdir(sys.argv[2])
try:
    from boatsim.sandbox.caps import capabilities
    caps = capabilities()
except ImportError:
    caps = []  # packed before the list existed
build = json.loads(open("boatsim_build.json").read()) if os.path.exists("boatsim_build.json") else {}
print(json.dumps({"caps": caps, "build": build}))
"""


def zip_capabilities(zip_path: Path) -> dict:
    """{"caps": [...], "build": {"commit": ...}} of a packed simulator."""
    import subprocess
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        r = subprocess.run(
            [sys.executable, "-I", "-c", _CAPS_SCRIPT, str(Path(zip_path).resolve()), tmp],
            capture_output=True,
            text=True,
            check=True,
        )
    return json.loads(r.stdout)


def page_needs(needs: dict, slots: dict | None = None) -> set[str]:
    """Everything the pages ask of the simulator: sandbox-needs.json's features,
    plus a "base:<id>" for every boat the pages offer (its "bases", and the
    Boatyard's starting designs and stock boats in sim-slots.json)."""
    out = {c for caps in needs.get("features", {}).values() for c in caps}
    out |= {f"base:{b}" for b in needs.get("bases", [])}
    for key in ("bases", "stock"):
        out |= {f"base:{b}" for b in (slots or {}).get(key, {})}
    return out


def check_page(zip_path: Path, needs: dict, slots: dict | None, commit: str | None) -> list[str]:
    """Problems that would make a deployed page ask its simulator for something
    it can't do, or a zip packed from another commit. Empty = fine."""
    got = zip_capabilities(zip_path)
    problems = [
        f"the pages need {c!r}, which this boatsim.zip can't do"
        for c in sorted(page_needs(needs, slots) - set(got["caps"]))
    ]
    packed = got["build"].get("commit")
    if commit and packed != commit:
        problems.append(f"boatsim.zip was packed from {packed}, the page is {commit}")
    return problems


def reference(
    bundle: Path, builds: list[str] | None, which=None, nudge: float = 0.0, trace: bool = False
) -> list[dict]:
    """Every launch of each grid build: outcome, days, events and end position,
    exactly as the browser gets them (repr of floats, so exact compares work).
    nudge: move the drop north by this many degrees (sensitivity test).
    trace: add each voyage's 6-hourly track and events, for `diverge`."""
    from boatsim.sandbox import catalog
    from boatsim.sandbox.run import launches, open_bundle, run_voyage

    env = open_bundle(bundle)
    grid = {catalog.grid_id(g): g for g in catalog.GRID}
    out = []
    for bid in builds or ["k-p25"]:
        if bid not in grid:
            raise SystemExit(f"unknown grid build {bid!r}; known: {', '.join(grid)}")
        for i, (start, seed) in enumerate(launches(env)):
            if which is not None and i not in which:
                continue
            r = run_voyage(grid[bid], env, start, seed, drop_nudge_deg=nudge)
            row = fingerprint(bid, r)
            if trace and r["replay"]:
                rep = r["replay"]
                row["track"] = {
                    "h": rep["h"], "lat": rep["lat"], "lon": rep["lon"],
                    "events": [[e["h"], e["kind"], e.get("detail", "")] for e in rep["events"]],
                }  # fmt: skip
            out.append(row)
    return out


def fingerprint(bid: str, r: dict) -> dict:
    res, rep = r["result"], r["replay"] or {}
    return {
        "build": bid,
        "start": res["start"],
        "seed": res["seed"],
        "outcome": res["outcome"],
        "days": res.get("days"),
        "events": len(rep.get("events", [])),
        "end_lat": repr(res.get("end_lat")),
        "end_lon": repr(res.get("end_lon")),
        "final_soc": repr(res.get("final_soc")),
    }


SAME_RUNTIME = ("outcome", "days", "events")  # what CPython and Pyodide must agree on


def compare(a: list[dict], b: list[dict], exact: bool = False) -> list[str]:
    """Differences between two reference runs (empty if they match). Across
    runtimes (CPython vs Pyodide) numpy's maths libraries differ in the last bit,
    so only outcome, days and events are compared; between two Pyodide runs
    (Actions vs a browser) everything must match exactly."""
    key = lambda r: (r["build"], r["start"])
    bb = {key(r): r for r in b}
    out = [f"missing from the second run: {key(r)}" for r in a if key(r) not in bb]
    out += [f"missing from the first run: {k}" for k in bb.keys() - {key(r) for r in a}]
    for r in a:
        o = bb.get(key(r))
        if o is None:
            continue
        fields = [f for f in r if f not in ("runtime", "track")] if exact else SAME_RUNTIME
        for f in fields:
            if r.get(f) != o.get(f):
                out.append(f"{key(r)} {f}: {r.get(f)!r} vs {o.get(f)!r}")
    return out


def diverge(a: list[dict], b: list[dict], tol_deg: float = 0.002) -> list[str]:
    """For each voyage whose ending differs, where the two tracks first part
    (more than tol_deg apart; tracks are to 0.001 deg) and the events either run
    had in the day before, that the other didn't."""
    key = lambda r: (r["build"], r["start"])
    bb = {key(r): r for r in b}
    out = []
    for r in a:
        o = bb.get(key(r))
        if o is None or all(r[f] == o[f] for f in SAME_RUNTIME):
            continue
        ta, tb = r.get("track"), o.get("track")
        if not ta or not tb:
            out.append(f"{key(r)}: no tracks (run reference with --trace)")
            continue
        n = min(len(ta["h"]), len(tb["h"]))
        k = next(
            (i for i in range(n)
             if abs(ta["lat"][i] - tb["lat"][i]) + abs(ta["lon"][i] - tb["lon"][i]) > tol_deg),
            None,
        )  # fmt: skip
        if k is None:
            out.append(f"{key(r)}: tracks agree to {tol_deg} deg until one ends")
            continue
        h = ta["h"][k]
        ea = {tuple(e) for e in ta["events"] if h - 24 <= e[0] <= h}
        eb = {tuple(e) for e in tb["events"] if h - 24 <= e[0] <= h}
        out.append(
            f"{key(r)}: tracks part by hour {h:g} (day {h / 24:.1f}) at "
            f"{ta['lat'][k]},{ta['lon'][k]} vs {tb['lat'][k]},{tb['lon'][k]}; "
            f"events only in the first: {sorted(ea - eb)}; only in the second: {sorted(eb - ea)}"
        )
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.sandbox")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cut")
    c.add_argument("year", type=int)
    c.add_argument("--out", required=True)
    c.add_argument("--no-currents", action="store_true")
    c.add_argument("--start", type=date.fromisoformat, help="window start instead of 1 April")
    c.add_argument("--end", type=date.fromisoformat, help="window end instead of 20 November")
    c.add_argument("--storms", help="IBTrACS CSV: carry the window's storm tracks (#117)")
    k = sub.add_parser("pack")
    k.add_argument("--out", required=True)
    k.add_argument("--commit", help="the commit packed (git SHA)")
    cp = sub.add_parser("check-page")
    cp.add_argument("--zip", required=True)
    cp.add_argument("--needs", required=True, help="sea3d/sandbox-needs.json")
    cp.add_argument("--slots", help="sea3d/public/sim-slots.json")
    cp.add_argument("--commit", help="the page's commit: the zip must be packed from it")
    r = sub.add_parser("reference")
    r.add_argument("--bundle", required=True)
    r.add_argument("--builds", nargs="*", default=None)
    r.add_argument("--launches", type=int, nargs="*", default=None, help="launch indexes 0-5")
    r.add_argument("--out", required=True)
    r.add_argument("--nudge", type=float, default=0.0, help="move the drop north, deg")
    r.add_argument("--trace", action="store_true", help="add tracks for `diverge`")
    dv = sub.add_parser("diverge")
    dv.add_argument("a")
    dv.add_argument("b")
    m = sub.add_parser("compare")
    m.add_argument("a")
    m.add_argument("b")
    m.add_argument("--exact", action="store_true")
    a = p.parse_args(argv)

    if a.cmd == "cut":
        from boatsim.sandbox.forcing import cut

        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        cut(
            a.year,
            out,
            glorys=False if a.no_currents else None,
            start=a.start,
            end=a.end,
            storms_csv=a.storms,
        )
        print(f"{out}: {out.stat().st_size / 1e6:.1f} MB")
    elif a.cmd == "pack":
        n = pack(Path(a.out), commit=a.commit)
        print(f"{a.out}: {n} files, {Path(a.out).stat().st_size / 1e6:.2f} MB")
    elif a.cmd == "check-page":
        needs = json.loads(Path(a.needs).read_text())
        slots = json.loads(Path(a.slots).read_text()) if a.slots else None
        problems = check_page(Path(a.zip), needs, slots, a.commit)
        for p_ in problems:
            print(f"::error::{p_}")
        if problems:
            raise SystemExit(f"{len(problems)} problem(s): the page and its simulator differ")
        print(
            f"{a.zip}: everything the pages need is there"
            + (f", packed from {a.commit}" if a.commit else "")
        )
    elif a.cmd == "diverge":
        for line in diverge(json.loads(Path(a.a).read_text()), json.loads(Path(a.b).read_text())):
            print(line)
    elif a.cmd == "compare":
        diffs = compare(
            json.loads(Path(a.a).read_text()), json.loads(Path(a.b).read_text()), a.exact
        )
        for d in diffs:
            print(d)
        if diffs:
            raise SystemExit(f"{len(diffs)} difference(s)")
        print("match" + (" (exact)" if a.exact else " (outcome, days, events)"))
    else:
        import numpy

        rows = reference(Path(a.bundle), a.builds, a.launches, a.nudge, a.trace)
        for x in rows:
            x["runtime"] = f"python {sys.version.split()[0]} numpy {numpy.__version__}"
        Path(a.out).write_text(json.dumps(rows, indent=1))
        for x in rows:
            print(x["build"], x["start"], x["outcome"], x["days"], x["events"], x["end_lat"])


if __name__ == "__main__":
    main()
