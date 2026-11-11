#!/usr/bin/env bash
# The detailed Blender boats (sea3d/blender/build_*.py) as .glb files in
# sea3d/public/models, with Blender as a headless Python module (bpy 4.2, which
# needs Python 3.11). Shared by the Pages deploy (sea3d.yml) and the pre-release
# playtest, so a PR that changes a boat script plays the boats it will deploy.
# Both run it only on a cache miss; if it fails, the page falls back to its
# drawn-in-code boats.
set -euo pipefail
cd "$(dirname "$0")/../sea3d"
sudo apt-get update -qq
sudo apt-get install -y -qq libxrender1 libxi6 libxkbcommon0 libsm6 libgl1 > /dev/null
python -m pip install -q bpy==4.2.0 pillow numpy
python blender/build_kayak.py public/models/kayak.glb
python blender/build_randolph.py public/models/randolph.glb
for s in cat semisub board; do python blender/build_shapes.py $s public/models/shape_$s.glb; done
for b in cruiser dinghy beachcat drone rower; do python blender/build_stock.py $b public/models/stock_$b.glb; done
