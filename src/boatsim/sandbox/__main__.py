"""python -m boatsim.sandbox cut|pack|reference

cut 2020 --out site/sandbox/forcing_2020.npz [--no-currents]
    the season's forcing bundle, from the ERA5/GLORYS caches (Actions)
pack --out site/sandbox/boatsim.zip
    the simulator's source, design files and land mask, for Pyodide
reference --bundle forcing_2020.npz --out ref.json [--builds ...]
    every launch of the given grid builds (default: the kayak as it stands),
    in this Python; Actions runs the same in Node + Pyodide and compares
"""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

PACK_FILES = ("configs/v4_kayak.yaml", "configs/randolph_rev_b.yaml", "data/land/land_mask_v1.npz")


def pack(out: Path, root: Path = Path(".")) -> int:
    """Zip src/boatsim (Python files only) plus the files a voyage reads at run
    time. The page unpacks it into Pyodide's file system and runs from there."""
    out.parent.mkdir(parents=True, exist_ok=True)
    n = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted((root / "src").rglob("*.py")):
            if "__pycache__" not in f.parts:
                z.write(f, f.relative_to(root / "src"))
                n += 1
        for name in PACK_FILES:
            z.write(root / name, name)
            n += 1
    return n


def reference(bundle: Path, builds: list[str] | None, which=None) -> list[dict]:
    """Every launch of each grid build: outcome, days, events and end position,
    exactly as the browser gets them (repr of floats, so exact compares work)."""
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
            r = run_voyage(grid[bid], env, start, seed)
            out.append(fingerprint(bid, r))
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
        fields = [f for f in r if f != "runtime"] if exact else SAME_RUNTIME
        for f in fields:
            if r.get(f) != o.get(f):
                out.append(f"{key(r)} {f}: {r.get(f)!r} vs {o.get(f)!r}")
    return out


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m boatsim.sandbox")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("cut")
    c.add_argument("year", type=int)
    c.add_argument("--out", required=True)
    c.add_argument("--no-currents", action="store_true")
    k = sub.add_parser("pack")
    k.add_argument("--out", required=True)
    r = sub.add_parser("reference")
    r.add_argument("--bundle", required=True)
    r.add_argument("--builds", nargs="*", default=None)
    r.add_argument("--launches", type=int, nargs="*", default=None, help="launch indexes 0-5")
    r.add_argument("--out", required=True)
    m = sub.add_parser("compare")
    m.add_argument("a")
    m.add_argument("b")
    m.add_argument("--exact", action="store_true")
    a = p.parse_args(argv)

    if a.cmd == "cut":
        from boatsim.sandbox.forcing import cut

        out = Path(a.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        cut(a.year, out, glorys=False if a.no_currents else None)
        print(f"{out}: {out.stat().st_size / 1e6:.1f} MB")
    elif a.cmd == "pack":
        n = pack(Path(a.out))
        print(f"{a.out}: {n} files, {Path(a.out).stat().st_size / 1e6:.2f} MB")
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

        rows = reference(Path(a.bundle), a.builds, a.launches)
        for x in rows:
            x["runtime"] = f"python {sys.version.split()[0]} numpy {numpy.__version__}"
        Path(a.out).write_text(json.dumps(rows, indent=1))
        for x in rows:
            print(x["build"], x["start"], x["outcome"], x["days"], x["events"], x["end_lat"])


if __name__ == "__main__":
    main()
