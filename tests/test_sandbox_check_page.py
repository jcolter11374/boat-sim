"""The deploy-time check that a page and its packed simulator agree (sea3d.yml)."""

from __future__ import annotations

import json
import zipfile
from pathlib import Path

from boatsim.sandbox.__main__ import BUILD_FILE, check_page, pack, page_needs, zip_capabilities

ROOT = Path(__file__).resolve().parents[1]
NEEDS = json.loads((ROOT / "sea3d/sandbox-needs.json").read_text())
SLOTS = json.loads((ROOT / "sea3d/public/sim-slots.json").read_text())


def _pack(tmp_path: Path, commit: str = "abc123") -> Path:
    out = tmp_path / "sandbox" / "boatsim.zip"
    pack(out, root=ROOT, commit=commit)
    return out


def _rewrite(src: Path, dst: Path, name: str, old: str, new: str) -> None:
    """Copy a zip, editing one file in it (a simulator missing a feature)."""
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == name:
                text = data.decode()
                assert old in text
                data = text.replace(old, new).encode()
            zout.writestr(item, data)


def test_the_pack_carries_its_commit_inside_and_beside(tmp_path):
    z = _pack(tmp_path)
    assert json.loads((z.parent / "boatsim.json").read_text()) == {"commit": "abc123"}
    with zipfile.ZipFile(z) as f:
        assert json.loads(f.read(BUILD_FILE)) == {"commit": "abc123"}


def test_this_commits_pack_gives_the_pages_everything_they_need(tmp_path):
    z = _pack(tmp_path)
    assert check_page(z, NEEDS, SLOTS, "abc123") == []
    caps = set(zip_capabilities(z)["caps"])
    # Every boat the Boatyard and the helm offer, and each page's features.
    assert page_needs(NEEDS, SLOTS) <= caps
    assert {"base:kayak", "base:revc", "base:stock_cruiser31", "helm.ports", "race", "yard"} <= caps


def test_a_zip_from_another_commit_fails(tmp_path):
    z = _pack(tmp_path, commit="old")
    assert check_page(z, NEEDS, SLOTS, "new") == [
        "boatsim.zip was packed from old, the page is new"
    ]


def test_a_simulator_without_ports_fails_on_exactly_that(tmp_path):
    # The bug John hit: a helm page with a port picker over a simulator whose
    # Game can't start from a port.
    z = _pack(tmp_path)
    old = tmp_path / "old.zip"
    _rewrite(z, old, "boatsim/sandbox/helm.py", "        start_port: str | None = None,\n", "")
    assert check_page(old, NEEDS, SLOTS, "abc123") == [
        "the pages need 'helm.ports', which this boatsim.zip can't do"
    ]


def test_a_boat_the_page_offers_but_the_zip_lacks_fails(tmp_path):
    z = _pack(tmp_path)
    needs = {**NEEDS, "bases": [*NEEDS["bases"], "stock_tall_ship"]}
    assert check_page(z, needs, SLOTS, "abc123") == [
        "the pages need 'base:stock_tall_ship', which this boatsim.zip can't do"
    ]
