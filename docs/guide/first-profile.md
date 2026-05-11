# First profile

A *profile* in brows3r is a named set of AWS credentials + endpoint
configuration. Profiles are scoped to a single backend (AWS native, MinIO,
R2, Wasabi, B2, etc.) and live independently — you can browse multiple
backends simultaneously, one pane per profile.

## Where credentials come from

brows3r auto-discovers profiles from three sources, in order of precedence:

| Source | Detected from |
|---|---|
| `awsCredentials` | `~/.aws/credentials` (standard SDK file) |
| `awsConfig`      | `~/.aws/config` (standard SDK file, supports `sso_*`) |
| `env`            | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` |

You can also create a profile manually for S3-compatible backends (Settings →
Profiles → "Add manual profile"). Manual profiles store credentials in the
OS keychain (`keyring` crate: macOS Keychain, Windows DPAPI / Credential
Manager, GNOME libsecret, KWallet). If no keychain is available, brows3r
falls back to an encrypted file with a passphrase prompt — see
[Security](/contributing/security#keychain-fallback) for the threat model.

## Validate before browsing

Listing operations are gated on profile validation — clicking a profile
runs a low-cost `ListBuckets` (or `HEAD bucket-region` for compat) and
caches the validation result for the session.

If validation fails:

- **AccessDenied / SignatureDoesNotMatch**: credentials are wrong or
  expired. Update them in the source file or via Settings → Profiles.
- **TimedOut / ConnectionRefused**: endpoint URL is wrong (compat
  profiles) or you're behind a proxy. Configure via Settings →
  Proxy / Endpoints.
- **InvalidStorageClass / NoSuchTransition**: the bucket has policies
  the SDK call cannot exercise. brows3r will *still let you browse* —
  the inspector reports the capability gap as informational; affected
  controls are disabled with a subtle reason chip.

## Multiple profiles at once

Each pane has its own active profile + bucket + prefix. To compare two
locations side by side:

1. Open the **Dual pane** view mode (Cmd+7).
2. Click a different profile in the sidebar — only the focused pane
   switches; the other keeps its location.
3. Both panes update independently. Drag-and-drop between panes performs
   a server-side `CopyObject` if both backends are AWS-native; otherwise
   it streams via Rust (no bytes through the WebView).

> The pane's profile + location is persisted (`useUiStore.lastLocation`)
> so the app re-opens where you left off.

## What is validated, what is not

Validation does **not**:

- Verify every bucket-level permission. Buckets you don't have
  `s3:ListBucket` on appear as "inaccessible" when you click them.
- Check IAM trust policies for cross-account roles.
- Pre-warm the per-region S3 client pool. Clients are minted lazily on
  first request to a new region and cached.

For the full validation flow (and why we gate on it), see
[Concepts → Credential boundary](/concepts/credentials).
