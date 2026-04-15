#!/usr/bin/env bash
# Publish typosquat placeholder packages to npm.
#
# Each package is a zero-byte name reservation — minimal metadata, no
# functional code, just a README pointing users at the real scoped
# package.
#
# Prerequisites:
#   - You are logged into npm as an owner of @llm402 and @llm402-ai
#     and @llm402ai scopes (create those scopes first if needed).
#   - You have owner rights for the unscoped names (no prior publishers).
#
# Usage:
#   bash scripts/publish-typosquats.sh [--dry-run]
#
# Exits non-zero on any publish failure. Re-runnable (skips already
# published names based on `npm view`).

set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
TYPOSQUAT_DIR="$SCRIPT_DIR/typosquats"

PACKAGES=(
  "llm402-openclaw-provider"
  "llm402-ai-openclaw-provider"
  "llm402ai-openclaw-provider"
  "openclaw-llm402-provider"
  "openclaw-provider-llm402"
)

echo ">>> Publishing ${#PACKAGES[@]} typosquat placeholders"
if $DRY_RUN; then
  echo ">>> DRY RUN — no network calls"
fi
echo

for dir in "${PACKAGES[@]}"; do
  pkg_dir="$TYPOSQUAT_DIR/$dir"
  if [ ! -d "$pkg_dir" ]; then
    echo "ERROR: missing placeholder dir $pkg_dir" >&2
    exit 1
  fi

  pkg_name="$(node -p "require('$pkg_dir/package.json').name")"

  # Skip if already published (name reservation achieved)
  if npm view "$pkg_name" version > /dev/null 2>&1; then
    echo "SKIP  $pkg_name (already published)"
    continue
  fi

  echo "PUBLISH  $pkg_name"
  if $DRY_RUN; then
    (cd "$pkg_dir" && npm publish --access public --dry-run)
  else
    (cd "$pkg_dir" && npm publish --access public)
  fi
done

echo
echo ">>> Done. All typosquat placeholders either published or already exist."
