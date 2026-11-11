"""What this packed simulator can do, for the pages that run it in the browser.

The 3D pages run boatsim.zip in Pyodide, and each page feature calls into it
(helm.ts -> sandbox.helm.Game, race.ts -> sandbox.race, the Boatyard ->
sandbox.run and catalog). A page published ahead of its simulator used to fail
in front of the player ("can't start from a port yet"). sea3d.yml now packs the
zip from the page's own commit, and before it deploys, it checks that this
list, worked out from the zip itself, covers everything the page asks for
(sea3d/sandbox-needs.json): `python -m boatsim.sandbox check-page`.

Each capability is found by looking, never by a hand-kept list, so a zip
without a feature can't claim it. Runs in Pyodide and in CPython alike.
"""

from __future__ import annotations

import inspect


def _params(fn) -> set[str]:
    try:
        return set(inspect.signature(fn).parameters)
    except (TypeError, ValueError):
        return set()


def capabilities() -> list[str]:
    caps: set[str] = set()
    try:
        from boatsim.sandbox import helm
    except ImportError:
        helm = None
    game = getattr(helm, "Game", None)
    if game is not None:
        caps.add("helm")
        init = _params(game.__init__)
        if "start_port" in init and hasattr(helm, "port_start"):
            caps.add("helm.ports")
        if "challenge" in init:
            caps.add("helm.challenges")
        caps.update(f"helm.mode.{m}" for m in getattr(helm, "MODES", ("hands_on",)))
        if hasattr(game, "load") and hasattr(game, "save"):
            caps.add("helm.share")
        if {"sails", "engine"} <= _params(game.order):
            caps.add("helm.sail_orders")
        if hasattr(game, "forecast"):
            caps.add("helm.forecast")
        if hasattr(helm, "UNTIL_CAP_H"):
            caps.add("helm.until_cap")
        if hasattr(helm, "BREAKDOWNS"):
            caps.add("helm.breakdowns")
    try:
        from boatsim.sandbox import race
    except ImportError:
        race = None
    if all(hasattr(race, n) for n in ("Race", "season_launch", "season_verdict", "UNTIL_CAP_H")):
        caps.add("race")
    try:
        from boatsim.sandbox import catalog, run
        from boatsim.sandbox.__main__ import fingerprint  # noqa: F401
    except ImportError:
        catalog = None
    if catalog is not None and all(hasattr(catalog, n) for n in ("nearest", "effects", "grid_id")):
        if all(hasattr(run, n) for n in ("open_bundle", "launches", "run_voyage", "note")):
            caps.add("yard")
        caps.update(f"base:{b}" for b in getattr(catalog, "BASES", {}) if _loads(catalog, b))
    return sorted(caps)


def _loads(catalog, base: str) -> bool:
    """A boat counts only if its design actually loads from the pack."""
    try:
        catalog.design_for(None if base == "kayak" else {"base": base})
    except Exception:  # noqa: BLE001 - any failure means the page can't sail it
        return False
    return True
