# brows3r — Security Model

This document describes the credential boundary, the media server token model,
the threat model, and the diagnostics bundle safeguards.

---

## Credential Boundary

**AWS credentials never cross the IPC boundary.**

All `aws-sdk-s3` calls live in the Rust backend. The WebView (React SPA) never
receives, stores, or transmits `accessKeyId`, `secretAccessKey`,
`sessionToken`, or any derived credential material.

- Profile discovery reads `~/.aws/credentials` and `~/.aws/config` in Rust.
- Manual profiles created in-app have their secret material written to the OS
  keychain via the `keyring` crate and never stored in settings JSON.
- The `profile_get` command returns only non-secret fields (`display_name`,
  `region`, `compat_flags`, `validated_at`).
- The `profiles_list` command returns `Vec<ProfileSummary>` — opaque profile
  IDs and display metadata only.

### Keychain storage

Secrets are stored under the key `brows3r:<profileId>` using the platform
keychain:

| Platform | Backend |
|---|---|
| macOS | Keychain Services |
| Windows | Windows Credential Manager |
| Linux | libsecret / Secret Service (D-Bus) |

If `keyring` init fails on Linux (e.g. headless environment without a D-Bus
session), the app falls back to an encrypted file with a user-supplied
passphrase. This fallback is logged prominently and the user is prompted; it
is not silent and it is not the default.

### Settings and profile JSON files

`${app_config_dir}/settings.json` and the profile registry contain only
non-secret fields. `serde` `skip_serializing` annotations are applied to any
field that could hold secret material. There is no code path that writes
credentials to disk outside the keychain abstraction.

---

## Media Server Token Model

The loopback HTTP media server (`axum`, bound to `127.0.0.1:0`) is used to
stream media objects (video, audio) to the WebView without loading them through
the IPC layer.

### Token minting

- `media_register { profileId, bucket, key }` mints a 64-byte random token
  using the OS CSPRNG.
- The token is stored in memory only: `(token → (profileId, bucket, key,
  expiresAt, sessionId))`.
- The command returns `http://127.0.0.1:<port>/m/<token>`.

### Binding

The server is bound to `127.0.0.1` (loopback) only. It never listens on
`0.0.0.0` or any external interface. This prevents any network-adjacent access;
a firewall prompt is never triggered.

### Token lifetime

- Default TTL: 1 hour from minting.
- Tokens are revoked on session end (app quit or profile removal), whichever
  comes first.
- On revocation the server emits a `media:revoked { token }` event so the
  frontend can remove stale `<video>` or `<audio>` src attributes.

### Request handling

- The server validates the token and checks TTL on every request.
- Range requests are supported (pass-through from the client to
  `get_object` with a `Range` header) so video seeking works.
- `Content-Type` is forwarded from the S3 `head_object` response.
- No authentication credentials are proxied or reflected in responses.

---

## Threat Model

### In scope

- **Malicious S3 responses** — the Rust backend treats all S3 responses as
  untrusted input. Errors are classified and normalised before reaching the
  frontend; raw S3 error bodies are never passed to the WebView.
- **Credential exfiltration prevention** — the IPC boundary is the enforced
  split. There is no `invoke` call that returns credentials. Code review
  and CI checks verify that `keychain.rs` is the only write path.
- **Token replay** — media tokens are 64 bytes (512 bits) of random data,
  session-scoped, and TTL-limited. Brute-force or prediction attacks are
  not feasible.

### Out of scope

- **Full local OS compromise** — any local malware with the same OS user
  privileges can read app memory, inspect keychain entries, or intercept
  loopback traffic. brows3r does not defend against this class of attack;
  no desktop application can.
- **Physical access attacks** — out of scope.
- **Network-level attacks** — the loopback bind prevents external access;
  no further network hardening is implemented for v1.

---

## Diagnostics Bundle Safeguards

The diagnostics bundle (`diagnostics_collect` + `diagnostics_export`) is the
user-controlled mechanism for reporting issues.

### Never auto-uploaded

The bundle is **never** uploaded automatically. The export flow always requires
an explicit user action:

1. User opens Settings → Diagnostics and clicks "Export".
2. `tauri-plugin-dialog` presents a save-file dialog for destination selection.
3. The bundle is written to the path the user chose. No network call is made.

### Redaction

A redactor runs over every file before it is added to the bundle. The redactor
strips credential patterns (AWS access key IDs, secret key patterns, bearer
tokens, session tokens) before any content is bundled. Redaction operates on
log lines, not on binary blobs; binary log entries are excluded by default.

The redaction level is user-selectable (`strict` / `standard`). `strict`
additionally removes all S3 key paths and bucket names from log entries.

### Inclusion scope

The bundle includes:

- Recent error log entries (configurable window, default last 50).
- The non-secret portion of the active settings (`settings.json` minus any
  field that could carry credentials — these are excluded by the serialiser).
- App version, OS version, and Tauri version metadata.

The bundle never includes:

- Keychain contents.
- Raw `~/.aws/credentials` or `~/.aws/config`.
- Transfer file contents.
- Media stream data.
