#!/usr/bin/env bash
# Build the whole live site from THIS checkout, the way the Pages deploy does
# (sea3d.yml), so the pre-release playtest plays exactly what would ship:
# the page from this commit, the simulator (boatsim.zip) packed from this commit,
# and the data releases (weather bundle, sea state, land, challenges, forecast,
# leaderboard) as published. Output: sea3d/dist.
#   tools/playtest/build_site.sh            (needs node, npm, python with boatsim installed)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO="${GITHUB_REPOSITORY:-jcolter11374/boat-sim}"
AUTH=()
[ -n "${GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GH_TOKEN")

# fetch TAG DIR PATTERN...: download a release's assets whose names match a glob.
fetch() {
  local tag=$1 dir=$2; shift 2
  mkdir -p "sea3d/public/$dir"
  local list
  list=$(curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO/releases/tags/$tag" \
    | python3 -c "import sys,json; [print(a['name'], a['url']) for a in json.load(sys.stdin)['assets']]") \
    || { echo "no $tag release: skipped (the deploy skips it too)"; return 0; }
  while read -r name url; do
    for pat in "$@"; do
      # shellcheck disable=SC2053
      if [[ $name == $pat ]]; then
        curl -fsSL "${AUTH[@]}" -H "Accept: application/octet-stream" -o "sea3d/public/$dir/$name" "$url"
        echo "  $tag/$name"
        break
      fi
    done
  done <<< "$list"
}

echo "Data releases:"
fetch sandbox-data sandbox 'forcing_2020.npz'
fetch seastate-data seastate 'seastate_*' 'depth_*'
fetch land-data land 'pico_*' 'baymouth_*' 'lisbon_*' 'annapolis*'
fetch challenge-data challenges 'challenge*'
fetch forecast-data forecast 'forecast_*'
fetch leaderboard-data leaderboard 'board.json'

echo "Simulator packed from this commit:"
python -m boatsim.sandbox pack --out sea3d/public/sandbox/boatsim.zip

cd sea3d
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build
echo "Built sea3d/dist from $(git rev-parse --short HEAD)"
