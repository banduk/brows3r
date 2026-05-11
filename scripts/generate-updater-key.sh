#!/usr/bin/env bash
# generate-updater-key.sh — one-time setup for Tauri auto-update signing.
#
# Wraps `tauri signer generate` and walks the operator through the three
# follow-up actions (paste pubkey into config, store private key + password
# as GitHub Secrets).
#
# Usage:
#   ./scripts/generate-updater-key.sh
#
# Idempotency: refuses to overwrite an existing key file unless --force is
# passed. Existing brows3r releases signed by the previous key would stop
# auto-updating after a key rotation, so the prompt here is intentionally
# conservative.

set -euo pipefail

cd "$(dirname "$0")/.."

KEY_DIR="${TAURI_KEY_DIR:-$HOME/.tauri}"
KEY_NAME="brows3r-updater"
KEY_PATH="$KEY_DIR/$KEY_NAME.key"
PUB_PATH="$KEY_PATH.pub"

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
  esac
done

if [ -f "$KEY_PATH" ] && [ "$FORCE" != "true" ]; then
  echo "❌ Updater key already exists at:"
  echo "     $KEY_PATH"
  echo ""
  echo "Rotating the key invalidates auto-update for every previously"
  echo "released version — they will not see new updates until users"
  echo "manually download a fresh release."
  echo ""
  echo "If that's what you want, re-run with --force."
  exit 1
fi

mkdir -p "$KEY_DIR"
chmod 700 "$KEY_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "❌ pnpm not found. Install: npm install -g pnpm" >&2
  exit 1
fi

echo "▶ Generating Tauri updater keypair at:"
echo "     $KEY_PATH"
echo ""
echo "ℹ️  You will be prompted for a passphrase. Pick a strong one and"
echo "    store it in your password manager — you'll need it twice:"
echo "    once below for the GitHub Secret, and again on every release."
echo ""

pnpm tauri signer generate -w "$KEY_PATH"

if [ ! -f "$PUB_PATH" ]; then
  echo "❌ Public key not found at $PUB_PATH. Did 'tauri signer generate' fail?" >&2
  exit 1
fi

PUBKEY_CONTENT="$(cat "$PUB_PATH")"

cat <<EOF

═════════════════════════════════════════════════════════════════════
  ✅ Keypair generated.
═════════════════════════════════════════════════════════════════════

NEXT STEPS — three things, all required before the next signed release:

1. Paste the public key into src-tauri/tauri.conf.json
   ──────────────────────────────────────────────────
   Replace the existing "pubkey" placeholder under "plugins.updater"
   with:

$PUBKEY_CONTENT

   (The file currently contains a "PLACEHOLDER — replace with…" string
    — search for that to find the right spot.)

2. Add the private key to GitHub Secrets
   ──────────────────────────────────────
   Repository → Settings → Secrets and variables → Actions →
   New repository secret.

   Name:  TAURI_UPDATER_PRIVATE_KEY
   Value: (paste the contents of $KEY_PATH)

3. Add the passphrase to GitHub Secrets
   ─────────────────────────────────────
   Name:  TAURI_UPDATER_KEY_PASSWORD
   Value: (the passphrase you typed above)

The full runbook (rotation, recovery if the key is lost, etc.) lives
in docs/release.md.

⚠️  KEEP $KEY_PATH SAFE.
    Backup encrypted offline. If you lose it, every existing user
    becomes "stranded" on their current version — they can't auto-
    update past the rotation point.
EOF
