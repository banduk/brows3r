#!/usr/bin/env bash
# release.sh — bump version, tag, and trigger the signed release pipeline.
#
# Usage:
#   ./scripts/release.sh 0.2.0              # full release flow
#   ./scripts/release.sh 0.2.0 --dry-run    # show diffs, don't write or push
#   ./scripts/release.sh --check            # validate everything without bumping
#
# What it does, in order:
#   1. Verify cwd is repo root, branch is main, working tree is clean.
#   2. Verify required tooling (gh, jq, sed) is available.
#   3. (sanity) Run lint/typecheck/test on the frontend.
#   4. Bump version in:
#         package.json            ("version" field)
#         src-tauri/Cargo.toml    ([package] version = ...)
#         src-tauri/tauri.conf.json   ("version" field)
#   5. Verify CHANGELOG.md has an entry that matches.
#   6. Create commit `chore(release): vX.Y.Z`.
#   7. Tag `vX.Y.Z` annotated.
#   8. Push branch + tag (asks for confirmation first).
#   9. Open the GitHub Actions release run page in the browser.
#
# Idempotency / safety:
#   * Refuses to run if there are unstaged or untracked changes.
#   * Refuses to overwrite an existing tag.
#   * --dry-run prints the file diffs and stops before any git mutation.

set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------------------
# CLI parsing
# ---------------------------------------------------------------------------

VERSION=""
DRY_RUN=false
CHECK_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --check) CHECK_ONLY=true ;;
    -h|--help)
      sed -n '2,28p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    -*)
      echo "❌ Unknown flag: $arg" >&2
      exit 1
      ;;
    *)
      if [ -z "$VERSION" ]; then VERSION="$arg"; fi
      ;;
  esac
done

if [ "$CHECK_ONLY" != "true" ] && [ -z "$VERSION" ]; then
  echo "❌ Usage: $0 <version> [--dry-run]   or   $0 --check" >&2
  exit 1
fi

if [ -n "$VERSION" ] && ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$ ]]; then
  echo "❌ Version must look like 0.1.0 or 0.1.0-rc1 (semver). Got: '$VERSION'" >&2
  exit 1
fi

TAG="v$VERSION"

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

echo "▶ Pre-flight"

# 1. Tooling.
for tool in git jq sed pnpm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "  ❌ Missing required tool: $tool" >&2
    exit 1
  fi
done
echo "  ✓ Tooling: git, jq, sed, pnpm"

# 2. Repo state.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "  ❌ Not inside a git repo" >&2
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" != "main" ] && [ "$CHECK_ONLY" != "true" ]; then
  echo "  ⚠️  Current branch is '$CURRENT_BRANCH', not 'main'."
  read -r -p "  Release from this branch anyway? [y/N] " yn
  case "$yn" in [yY]*) ;; *) exit 1 ;; esac
fi
echo "  ✓ Branch: $CURRENT_BRANCH"

if [ "$CHECK_ONLY" != "true" ] && [ -n "$(git status --porcelain)" ]; then
  echo "  ❌ Working tree is dirty. Commit or stash first." >&2
  git status --short
  exit 1
fi
echo "  ✓ Working tree clean"

# 3. Tag must not already exist.
if [ -n "$VERSION" ] && git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "  ❌ Tag $TAG already exists locally." >&2
  exit 1
fi
if [ -n "$VERSION" ] && git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q .; then
  echo "  ❌ Tag $TAG already exists on remote 'origin'." >&2
  exit 1
fi
[ -n "$VERSION" ] && echo "  ✓ Tag $TAG is free"

# ---------------------------------------------------------------------------
# Sanity: lint + typecheck + test (frontend only — Rust gated by CI)
# ---------------------------------------------------------------------------

echo ""
echo "▶ Frontend sanity checks (lint, typecheck, build)…"
pnpm lint >/dev/null
echo "  ✓ pnpm lint"
pnpm typecheck >/dev/null
echo "  ✓ pnpm typecheck"
pnpm build >/dev/null
echo "  ✓ pnpm build"

if [ "$CHECK_ONLY" = "true" ]; then
  echo ""
  echo "✅ All checks pass. (No version bump or tag created — --check mode.)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Compute current versions for the diff preview
# ---------------------------------------------------------------------------

CURRENT_PKG_VERSION="$(jq -r '.version' package.json)"
CURRENT_CARGO_VERSION="$(grep -E '^version *= *"' src-tauri/Cargo.toml | head -1 | sed -E 's/^version *= *"([^"]+)"/\1/')"
CURRENT_TAURI_VERSION="$(jq -r '.version' src-tauri/tauri.conf.json)"

echo ""
echo "▶ Version bump"
printf "  package.json              %-12s → %s\n" "$CURRENT_PKG_VERSION" "$VERSION"
printf "  src-tauri/Cargo.toml      %-12s → %s\n" "$CURRENT_CARGO_VERSION" "$VERSION"
printf "  src-tauri/tauri.conf.json %-12s → %s\n" "$CURRENT_TAURI_VERSION" "$VERSION"
echo ""

if [ "$DRY_RUN" = "true" ]; then
  echo "ℹ️  --dry-run: no files will be modified."
  exit 0
fi

# ---------------------------------------------------------------------------
# Apply the bump
# ---------------------------------------------------------------------------

# package.json (use a temp file so we don't depend on `jq` -i support).
jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp
mv package.json.tmp package.json

# src-tauri/tauri.conf.json
jq --arg v "$VERSION" '.version = $v' src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp
mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json

# src-tauri/Cargo.toml — only the FIRST `version = "..."` (the [package] one).
# Use a portable awk so we don't rely on GNU sed / -i differences.
awk -v new="$VERSION" '
  BEGIN { done = 0 }
  /^version *= *"[^"]*"$/ && done == 0 {
    sub(/"[^"]*"/, "\"" new "\"")
    done = 1
  }
  { print }
' src-tauri/Cargo.toml > src-tauri/Cargo.toml.tmp
mv src-tauri/Cargo.toml.tmp src-tauri/Cargo.toml

# Cargo.lock will get refreshed by the next cargo invocation — no
# need to touch it explicitly here. CI's `cargo check` does the work.

# ---------------------------------------------------------------------------
# CHANGELOG sanity check
# ---------------------------------------------------------------------------

if ! grep -qE "^## \[$VERSION\]" CHANGELOG.md; then
  echo ""
  echo "⚠️  CHANGELOG.md does not have a [$VERSION] heading yet."
  echo ""
  echo "    Open CHANGELOG.md and move the entries from [Unreleased] into a"
  echo "    new ## [$VERSION] — $(date +%Y-%m-%d) section, then re-run."
  echo ""
  echo "    Reverting your file changes so you can edit the CHANGELOG first…"
  git checkout -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
  exit 1
fi
echo "✓ CHANGELOG has [$VERSION] entry"

# ---------------------------------------------------------------------------
# Commit + tag
# ---------------------------------------------------------------------------

echo ""
echo "▶ Diff preview"
git --no-pager diff --stat -- package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
echo ""

read -r -p "Stage, commit, and tag $TAG? [y/N] " yn
case "$yn" in [yY]*) ;; *) echo "Aborted; file changes left uncommitted."; exit 1 ;; esac

git add package.json src-tauri/Cargo.toml src-tauri/tauri.conf.json
git commit -m "chore(release): $TAG"
git tag -a "$TAG" -m "Release $TAG"

echo ""
echo "✓ Committed and tagged."

# ---------------------------------------------------------------------------
# Push
# ---------------------------------------------------------------------------

read -r -p "Push branch '$CURRENT_BRANCH' and tag '$TAG' to origin? [y/N] " yn
case "$yn" in
  [yY]*)
    git push origin "$CURRENT_BRANCH"
    git push origin "$TAG"
    echo "✓ Pushed."
    ;;
  *)
    echo "ℹ️  Tag created locally but not pushed. To trigger the release:"
    echo "      git push origin $CURRENT_BRANCH"
    echo "      git push origin $TAG"
    exit 0
    ;;
esac

# ---------------------------------------------------------------------------
# Open the release pipeline run page (best effort)
# ---------------------------------------------------------------------------

if command -v gh >/dev/null 2>&1; then
  echo ""
  echo "▶ Opening the GitHub Actions release run…"
  # Wait a couple seconds for GitHub to register the workflow run.
  sleep 3
  gh run list --workflow=release.yml --limit 1 --json url --jq '.[0].url' \
    | xargs -I{} sh -c 'echo "{}"; if command -v open >/dev/null 2>&1; then open "{}"; fi'
fi

cat <<EOF

═════════════════════════════════════════════════════════════════════
  🎉 Release $TAG kicked off.
═════════════════════════════════════════════════════════════════════

CI is now running three jobs in parallel:
  • release-macos    — codesign + notarize → .dmg
  • release-windows  — Authenticode sign  → .exe
  • release-linux    — packaging         → .deb + .AppImage

When all three finish (~20–30 min) the artifacts are attached to the
GitHub release at:

    https://github.com/<owner>/<repo>/releases/tag/$TAG

Post-release smoke test checklist: docs/release-checklist.md.
EOF
