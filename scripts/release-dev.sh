#!/usr/bin/env bash
# release-dev.sh — trigger the unsigned multi-platform dev build on CI.
#
# Hands you `.dmg` / `.exe` / `.AppImage` / `.deb` for all three OSes
# without consuming a tag, signing certs, or creating a GitHub release.
# Useful for handing artifacts to colleagues on different platforms for
# ad-hoc testing.
#
# Usage:
#   ./scripts/release-dev.sh                 # build the current branch
#   ./scripts/release-dev.sh --branch foo    # build a specific branch
#
# Requires the GitHub CLI (`gh`). Falls back to printing the manual
# trigger URL if `gh` isn't installed.

set -euo pipefail

cd "$(dirname "$0")/.."

BRANCH=""

for arg in "$@"; do
  case "$arg" in
    --branch)
      shift; BRANCH="${1:-}"; shift || true
      ;;
    --branch=*)
      BRANCH="${arg#--branch=}"
      ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

if [ -z "$BRANCH" ]; then
  BRANCH="$(git rev-parse --abbrev-ref HEAD)"
fi

if ! command -v gh >/dev/null 2>&1; then
  cat <<EOF
ℹ️  gh CLI not installed. Trigger manually:

  Go to: https://github.com/<owner>/<repo>/actions/workflows/release-dev.yml
  Click: Run workflow → branch: $BRANCH → Run workflow

To install gh: https://cli.github.com/

EOF
  exit 0
fi

echo "▶ Triggering release-dev.yml on branch '$BRANCH'…"
gh workflow run release-dev.yml --ref "$BRANCH"

echo ""
echo "✓ Workflow dispatched. Following the run…"
sleep 3
gh run list --workflow=release-dev.yml --limit 1 \
  --json url,status,createdAt --jq '.[0]'

echo ""
echo "ℹ️  When the run finishes, download artifacts from the run page."
echo "    Each platform's bundle is uploaded as a separate artifact:"
echo "      • brows3r-macos    — .dmg + .app"
echo "      • brows3r-windows  — .exe"
echo "      • brows3r-linux    — .deb + .AppImage"
