# Credential boundary

The single hardest invariant in brows3r is:

> **AWS credentials never cross the IPC boundary.**

Every other architectural choice flows from this. This page documents why,
how, and what each layer is allowed to know.

## What "boundary" means in Tauri

A Tauri app runs in two processes:

- **Rust core** — the trusted side. Owns the OS-level resources: file
  system, OS keychain, network, system tray.
- **WebView** — the untrusted side. A sandboxed browser rendering React.
  No native APIs, no filesystem, no clipboard except through Tauri
  plugins.

They communicate via `invoke(command, payload)` (sync request/response) and
`emit/listen(event, payload)` (async one-way). brows3r's rule: **the
payload of any IPC message must never contain an access key, secret,
session token, or signed Authorization header.**

## What the WebView is allowed to see

- Opaque profile IDs (UUIDs).
- Display names + source (`awsCredentials` / `awsConfig` / `env` /
  `manual`).
- Default region.
- Validation timestamp.
- The compat-flags overlay (endpoint URL, addressing style, etc.) **for
  manual profiles only** — the user typed these themselves, so they're
  not secret.

What the WebView is **never** allowed to see:

- Access key ID.
- Secret access key.
- Session token.
- KMS data keys (if SSE-C ever lands).
- Signed S3 request URLs (presigned URLs returned to the user via
  `clipboard.writeText` are an exception — see below).

## Credential sources

| Source | Discovery | Storage |
|---|---|---|
| `awsCredentials` | `~/.aws/credentials` | The file itself; brows3r reads at validation time. |
| `awsConfig` | `~/.aws/config` (`sso_*`, `role_arn`, …) | The file itself; brows3r runs the same resolver chain the AWS SDK does. |
| `env` | `AWS_ACCESS_KEY_ID` etc. | Process env (cleared on quit). |
| `manual` | User input via Settings → Profiles | OS keychain (`keyring` crate); see [Keychain fallback](/contributing/security#keychain-fallback) for the encrypted-file backup. |

The Rust side maintains a per-profile `aws-sdk-s3` client pool, lazily
minted per region. Pool entries TTL out after 30 minutes of inactivity so
short-lived session tokens don't keep stale clients alive.

## Validation gate

Listing operations (`object_list`, `bucket_list`, etc.) refuse to run for
unvalidated profiles. The first IPC interaction with a fresh profile is
`profile_validate(profileId)`, which runs `ListBuckets` (or `HEAD bucket`
for compat profiles) and writes `validated_at` to the profile state.

If a profile fails validation, the WebView gets a generic `Auth` error
with no detail — the SDK error message is logged on the Rust side, but
never propagated. This avoids leaking whether the credentials are wrong,
expired, or just lack a particular permission.

## Presigned URLs

Presigned URLs are an exception: the user explicitly asks for them, and the
URL is the point. brows3r generates them on the Rust side and writes
straight to the OS clipboard via `@tauri-apps/plugin-clipboard-manager`.
The URL **never** appears in a log, a Zustand store, or a React state
snapshot.

Default TTL is 1 hour, configurable per request in Settings →
Confirmations.

## Media (loopback server)

For `<img>`, `<video>`, `<audio>`, `<iframe>` (PDF preview), and `fetch()`
in pdf.js, the WebView needs a URL it can dereference. brows3r runs a
loopback HTTP server on `127.0.0.1:<random-port>` that:

1. Accepts only signed session tokens (random 32 bytes, single-use,
   revoked on component unmount).
2. Forwards the request to S3 via the Rust client pool.
3. Streams bytes back without exposing the underlying signature.

See [Concepts → Media server](/concepts/media-server) for the threat model.

## What can go wrong, and what we do about it

| Scenario | Mitigation |
|---|---|
| Malicious npm dep tries to read credentials | They can't — the WebView never touches them. |
| User's WebView dev tools open during a screenshare | The displayed state never contains credentials. |
| Memory dump of the WebView | No credentials in WebView memory. |
| Memory dump of the Rust process | Credentials are in RAM while the app runs, same as the AWS CLI. brows3r doesn't pin pages or use OS protected memory; the threat model assumes "if attacker has root, you've lost". |
| Stolen keychain entry | Keychain is the OS's responsibility; brows3r uses standard `keyring` calls. |
| Stolen `~/.aws/credentials` | brows3r reads what's there; the SDK file's security is the user's responsibility. |

The full security policy is in [Contributing → Security](/contributing/security).
