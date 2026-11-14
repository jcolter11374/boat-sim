#!/usr/bin/env bash
# Build the whole site from THIS checkout into sea3d/dist: the one build that
# both the Pages deploy (sea3d.yml) and Nina's pre-release playtest
# (prerelease-playtest.yml) run, so the gate plays exactly what ships.
#   - the data releases as published (weather bundle, sea state, land,
#     challenges, forecast, leaderboard); a missing release is skipped, as before
#   - the simulator (boatsim.zip) packed from this commit, stamped with it
#     (inside the zip and in sandbox/boatsim.json), and version.json for the page
#   - the page (npm run build)
#   - check-page: fails if the zip can't do something the pages ask for
#     (sea3d/sandbox-needs.json) or was packed from another commit
# Data releases are optional: a missing one only warns, as the pages cope
# without each. Anything else that fails (pack, build, check-page) exits
# non-zero, so a red run always means the game would break. No secrets: public
# releases only. Needs node/npm and python with numpy and
# pyyaml (as in Pyodide); boatsim itself comes from src/.
#   tools/build_site.sh
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${GITHUB_REPOSITORY:-jcolter11374/boat-sim}"
COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD)}"
AUTH=()
[ -n "${GH_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $GH_TOKEN")
export PYTHONPATH="$PWD/src${PYTHONPATH:+:$PYTHONPATH}"

# fetch TAG DIR PATTERN...: download a release's assets whose names match a glob.
fetch() {
  local tag=$1 dir=$2; shift 2
  mkdir -p "sea3d/public/$dir"
  local list
  list=$(curl -fsSL "${AUTH[@]}" "https://api.github.com/repos/$REPO/releases/tags/$tag" \
    | python3 -c "import sys,json; [print(a['name'], a['url']) for a in json.load(sys.stdin)['assets']]") \
    || { echo "::warning::no $tag release (or GitHub didn't answer): skipped, the pages do without it"; return 0; }
  while read -r name url; do
    for pat in "$@"; do
      # shellcheck disable=SC2053
      if [[ $name == $pat ]]; then
        if curl -fsSL "${AUTH[@]}" -H "Accept: application/octet-stream" -o "sea3d/public/$dir/$name" "$url"; then
          echo "  $tag/$name"
        else
          rm -f "sea3d/public/$dir/$name"
          echo "::warning::couldn't download $tag/$name: the pages do without it"
        fi
        break
      fi
    done
  done <<< "$list"
}

echo "Data releases:"
# The 2020 weather bundle for the in-browser simulator (sandbox.yml). Without it
# the Boatyard launches from the precomputed grid and the helm says so.
fetch sandbox-data sandbox 'forcing_2020.npz'
# The same weather split by month, for the helm page: it loads only the months a
# voyage sails through (a first sail reads about a quarter of the season). The
# split slices the bundle's stored bytes and checks they join back to it byte
# for byte, so the values can't change; a failure here stops the build. The
# whole file stays for the Boatyard and the race, which sail whole seasons.
if [ -f sea3d/public/sandbox/forcing_2020.npz ]; then
  rm -f sea3d/public/sandbox/forcing_2020_*
  python3 -m boatsim.sandbox split --bundle sea3d/public/sandbox/forcing_2020.npz --out sea3d/public/sandbox
fi
# Swell for the 3D sea (seastate.yml, display only). The Chesapeake depth
# files on the same release are left out until a page reads them (#287).
fetch seastate-data seastate 'seastate_*'
# Land for the 3D views (landdata.yml, display only).
fetch land-data land 'pico_*' 'baymouth_*' 'lisbon_*' 'annapolis*' 'bay_*'
# Weather challenges for the helm page's picker (challenges.yml).
fetch challenge-data challenges 'challenge*'
# The list itself (challenges.json: names, goals, debriefs) is written from this
# commit, so a goal added in code reaches the page without republishing the
# release (Sandy's goal sat unpublished for two days). Only challenges the
# release already lists are kept: one without its weather bundle couldn't be played.
if [ -f sea3d/public/challenges/challenges.json ]; then
  python3 -m boatsim.oceandata.challenges catalog --out sea3d/public/challenges/challenges.fresh.json
  python3 - <<'PY'
import json
d = "sea3d/public/challenges/"
have = {c["id"] for c in json.load(open(d + "challenges.json"))["challenges"]}
fresh = json.load(open(d + "challenges.fresh.json"))
fresh["challenges"] = [c for c in fresh["challenges"] if c["id"] in have]
json.dump(fresh, open(d + "challenges.json", "w"))
print("  challenges.json from this commit:", len(fresh["challenges"]), "challenges")
PY
  rm -f sea3d/public/challenges/challenges.fresh.json
fi
# Today's weather (forecast.yml, display only).
fetch forecast-data forecast 'forecast_*'
# The design leaderboard, published only when fair (leaderboard.yml).
fetch leaderboard-data leaderboard 'board.json'

echo "Simulator packed from $COMMIT:"
python -m boatsim.sandbox pack --out sea3d/public/sandbox/boatsim.zip --commit "$COMMIT"
python3 -c "import json, sys; sys.stdout.write(json.dumps({'commit': sys.argv[1]}))" "$COMMIT" > sea3d/public/version.json

(cd sea3d && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build)

echo "The pages' simulator can do what the pages ask:"
python -m boatsim.sandbox check-page --zip sea3d/dist/sandbox/boatsim.zip \
  --needs sea3d/sandbox-needs.json --slots sea3d/public/sim-slots.json --commit "$COMMIT"
cmp -s sea3d/dist/version.json sea3d/dist/sandbox/boatsim.json \
  || { echo "::error::version.json and sandbox/boatsim.json differ"; exit 1; }
echo "Built sea3d/dist from $COMMIT"
