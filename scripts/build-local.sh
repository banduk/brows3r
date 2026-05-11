#!/usr/bin/env bash
# build-local.sh — build a release bundle for the current platform.
#
# Wraps `pnpm tauri build` with friendly output: lists the resulting
# artifacts and their sizes when the build completes.
#
# Usage:
#   ./scripts/build-local.sh           # build all default targets
#   ./scripts/build-local.sh --debug   # debug build (faster, larger)
#
# The build is UNSIGNED. For signed/notarized distribution use the
# tagged-release flow (see scripts/release.sh + .github/workflows/release.yml).

set -euo pipefail

cd "$(dirname "$0")/.."

# Make sure cargo is on PATH even when shell rc isn't loaded (rustup default).
if ! command -v cargo >/dev/null 2>&1; then
  if [ -x "$HOME/.cargo/bin/cargo" ]; then
    export PATH="$HOME/.cargo/bin:$PATH"
  else
    echo "❌ cargo not found. Install Rust: https://rustup.rs/" >&2
    exit 1
  fi
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ pnpm not found. Install: npm install -g pnpm" >&2
  exit 1
fi

ARGS=("$@")

echo "▶ Building brows3r for the current platform (this can take 5-15 min)…"
echo "  cargo $(cargo --version | awk '{print $2}')"
echo "  pnpm  $(pnpm --version)"
echo ""

pnpm tauri build "${ARGS[@]}"

echo ""
echo "✅ Build complete. Artifacts:"
echo ""

BUNDLE_DIR="src-tauri/target/release/bundle"
if [ ! -d "$BUNDLE_DIR" ]; then
  BUNDLE_DIR="src-tauri/target/debug/bundle"
fi

if [ -d "$BUNDLE_DIR" ]; then
  find "$BUNDLE_DIR" -maxdepth 3 \( -name "*.dmg" -o -name "*.app" -o -name "*.exe" -o -name "*.msi" -o -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" \) -print0 \
    | while IFS= read -r -d '' f; do
        size=$(du -h "$f" | awk '{print $1}')
        printf "  %s  (%s)\n" "$f" "$size"
      done
else
  echo "  (no bundle dir found at $BUNDLE_DIR — check the build output above)"
fi

echo ""
echo "ℹ️  Unsigned build — Gatekeeper / SmartScreen will warn end users."
echo "    For signed distribution see scripts/release.sh + docs/release.md."
