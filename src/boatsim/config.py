"""Boat design config, loaded from a YAML file in configs/.

Every number that is a guess rather than a measurement or datasheet value
should be marked `# GUESS` in the YAML, so we know what to calibrate.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from pathlib import Path

import yaml


@dataclass(frozen=True)
class Design:
    name: str
    hull: dict = field(default_factory=dict)
    power: dict = field(default_factory=dict)
    propulsion: dict = field(default_factory=dict)
    electronics: dict = field(default_factory=dict)
    comms: dict = field(default_factory=dict)
    voyage: dict = field(default_factory=dict)
    hazards: dict = field(default_factory=dict)
    sail: dict = field(default_factory=dict)  # sailing designs only (vessel/sail.py)


def load_design(path: str | Path) -> Design:
    with open(path) as f:
        raw = yaml.safe_load(f)
    known = {k: raw.get(k, {}) for k in Design.__dataclass_fields__ if k != "name"}
    return Design(name=raw["name"], **known)


def patched_design(design: Design, changes) -> Design:
    """The design with (section, key, value) changes applied."""
    for section, key, value in changes:
        design = replace(design, **{section: {**getattr(design, section), key: value}})
    return design
