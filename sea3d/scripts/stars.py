"""Make sea3d/public/stars.bin, the night sky: every star you can see by eye.

From the Yale Bright Star Catalogue, 5th revised edition (Hoffleit and Warren
1991; NASA Astronomical Data Center and CDS catalogue V/50), which lists the
9,110 stars down to about magnitude 6.5, the faintest the eye sees on a dark
night at sea. We read the JSON copy at SOURCE (the same J2000 places, visual
magnitudes and the approximate colour temperatures worked out from each star's
spectral type), because the catalogue's own servers aren't reachable from our
sandboxes. Novae and the few entries with no position are left out.

    python sea3d/scripts/stars.py   # from the repo root

stars.bin: a 4-byte count, then per star (little-endian):
  uint16 right ascension (0..65535 = 0..360 degrees, J2000)
  int16  declination (x 90/32767 degrees)
  int16  visual magnitude x 100
  uint16 colour temperature (K; 0 when unknown)
brightest first, so a page can draw the first n for a hazier sky.
"""

import json
import re
import struct
import urllib.request
from pathlib import Path

SOURCE = "https://raw.githubusercontent.com/brettonw/YaleBrightStarCatalog/master/bsc5-short.json"
OUT = Path("sea3d/public/stars.bin")


def ra_deg(s: str) -> float:
    h, m, sec = re.match(r"(\d+)h (\d+)m ([\d.]+)s", s).groups()
    return (int(h) + int(m) / 60 + float(sec) / 3600) * 15


def dec_deg(s: str) -> float:
    sign, d, m, sec = re.match(r"([+-])(\d+)° (\d+)′ ([\d.]+)″", s).groups()
    v = int(d) + int(m) / 60 + float(sec) / 3600
    return -v if sign == "-" else v


def main() -> None:
    with urllib.request.urlopen(SOURCE, timeout=60) as r:
        rows = json.load(r)
    stars = []
    for x in rows:
        try:
            stars.append((ra_deg(x["RA"]), dec_deg(x["Dec"]), float(x["V"]), int(x.get("K") or 0)))
        except (KeyError, AttributeError, ValueError):
            continue  # no position or magnitude
    stars.sort(key=lambda s: s[2])
    out = bytearray(struct.pack("<I", len(stars)))
    for ra, dec, mag, k in stars:
        out += struct.pack(
            "<HhhH",
            round(ra / 360 * 65536) % 65536,
            round(dec / 90 * 32767),
            round(mag * 100),
            min(k, 65535),
        )
    OUT.write_bytes(bytes(out))
    print(
        f"{len(stars)} stars, magnitude {stars[0][2]} to {stars[-1][2]}, {len(out)} bytes -> {OUT}"
    )


if __name__ == "__main__":
    main()
