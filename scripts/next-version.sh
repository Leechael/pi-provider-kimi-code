#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/next-version.sh <patch|minor|major>
# Output: new version without prefix (e.g. 1.2.4)

BUMP="${1:-patch}"

case "$BUMP" in
  patch|minor|major) ;;
  *)
    echo "invalid bump: $BUMP" >&2
    exit 1
    ;;
esac

env_file="release-naming.env"
if [[ ! -f "$env_file" ]]; then
  echo "missing naming contract file: $env_file" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$env_file"

if [[ -z "${TAG_PREFIX:-}" ]]; then
  echo "TAG_PREFIX is empty in $env_file" >&2
  exit 1
fi

latest_tag=$(git tag -l "${TAG_PREFIX}*" --sort=-version:refname | head -n1)

if [[ -z "$latest_tag" ]]; then
  base_version="0.0.0"
else
  base_version="${latest_tag#${TAG_PREFIX}}"
  base_version="${base_version%%-*}"
fi

IFS='.' read -r major minor patch_v <<< "$base_version"
major=${major:-0}
minor=${minor:-0}
patch_v=${patch_v:-0}

case "$BUMP" in
  patch)
    patch_v=$((patch_v + 1))
    ;;
  minor)
    minor=$((minor + 1))
    patch_v=0
    ;;
  major)
    major=$((major + 1))
    minor=0
    patch_v=0
    ;;
esac

echo "${major}.${minor}.${patch_v}"
