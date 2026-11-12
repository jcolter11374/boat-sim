#!/usr/bin/env bash
# Unpack a branch's proofs (made by the Proof frames workflow, .github/workflows/proofs.yml)
# into the project's shared folder, replacing the last set:
#   tools/proof/fetch.sh <branch> [folder]   (default folder /mnt/project-files/simulator/proofs)
# Public release download: no token needed.
set -euo pipefail
branch=${1:?usage: fetch.sh <branch> [folder]}
root=${2:-/mnt/project-files/simulator/proofs}
repo=${GITHUB_REPOSITORY:-jcolter11374/boat-sim}
safe=$(printf '%s' "$branch" | tr -c 'A-Za-z0-9._-' '-')
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/p.zip" "https://github.com/$repo/releases/download/proofs/$safe.zip" \
  || { echo "no proofs for $branch yet (run the Proof frames workflow, or wait for it to finish)" >&2; exit 1; }
mkdir -p "$tmp/x" && (cd "$tmp/x" && unzip -q ../p.zip)
dest="$root/$safe"
mkdir -p "$root"
rm -rf "$dest.old" && { [ -d "$dest" ] && mv "$dest" "$dest.old" || true; }
cp -r "$tmp/x" "$dest"
rm -rf "$dest.old"
echo "$(ls "$dest" | grep -cE '\.(png|mp4)$') files in $dest (open index.html or contact-sheet.png)"
