# brows3r — Release and Auto-Update Runbook

This document is the single source of truth for the brows3r signing key lifecycle
and the end-to-end auto-update release flow.

Tasks 63–65 (macOS packaging, Windows packaging, Linux packaging) consume this
runbook and assume it has been followed before any signed release is shipped.

---

## Section 1: Generate the signing key

The Tauri updater uses Ed25519 asymmetric signing. Every release artifact must
be signed with the private key. The public key is embedded in the app at build
time so the updater can verify downloads.

### 1.1 Install Tauri CLI

```sh
cargo install tauri-cli --version "^2"
# or via npm:
pnpm install -g @tauri-apps/cli
```

### 1.2 Run the key generator

```sh
tauri signer generate -w ~/.tauri/brows3r.key
```

You will be prompted for an optional passphrase. **Use a strong passphrase and
record it immediately in a password manager.** Losing the passphrase means losing
the ability to sign future releases with this key.

### 1.3 What is produced

| File | Purpose |
|---|---|
| `~/.tauri/brows3r.key` | Private key — **never commit or share** |
| `~/.tauri/brows3r.key.pub` | Public key — paste into `tauri.conf.json` |

### 1.4 Commit the public key

Open `src-tauri/tauri.conf.json` and replace the placeholder in
`plugins.updater.pubkey` with the full contents of `~/.tauri/brows3r.key.pub`:

```json
"plugins": {
  "updater": {
    "pubkey": "<paste entire contents of ~/.tauri/brows3r.key.pub here>"
  }
}
```

Commit this change to the repository. The public key is not a secret.

---

## Section 2: Store the private key securely

The private key must be available to the CI/CD release pipeline but must never
appear in source control or logs.

### 2.1 GitHub Actions secrets

Add two repository secrets (Settings → Secrets and variables → Actions):

| Secret name | Value |
|---|---|
| `TAURI_UPDATER_PRIVATE_KEY` | Full contents of `~/.tauri/brows3r.key` |
| `TAURI_UPDATER_KEY_PASSWORD` | The passphrase entered during `tauri signer generate` (leave blank if no passphrase was used) |

### 2.2 Local development

For local `tauri build` invocations that produce signed artifacts, export the
environment variables before running the build:

```sh
export TAURI_UPDATER_PRIVATE_KEY="$(cat ~/.tauri/brows3r.key)"
export TAURI_UPDATER_KEY_PASSWORD="your-passphrase"
tauri build
```

**Never commit these values.** `~/.tauri/brows3r.key` must be excluded from
version control. Verify `.gitignore` contains an entry for `*.key` or the
specific path.

### 2.3 Offline backup

Store an encrypted copy of `~/.tauri/brows3r.key` in offline cold storage
(e.g. an encrypted USB drive kept separately from primary hardware). This is
the only recovery path if CI secrets and the local key are both lost.

---

## Section 3: Sign and release artifacts

### 3.1 Trigger a release

Releases are triggered by pushing a tag matching `v*.*.*`:

```sh
git tag v1.2.3
git push origin v1.2.3
```

The release workflow (`.github/workflows/release.yml`, tasks 63–65) runs on
this tag.

### 3.2 What the release workflow does

1. Checks out the tagged commit.
2. Sets `TAURI_UPDATER_PRIVATE_KEY` and `TAURI_UPDATER_KEY_PASSWORD` from
   GitHub secrets.
3. Runs `tauri build` on macOS, Windows, and Linux runners.
4. Produces platform-specific installers:
   - macOS: `.app` (inside `.dmg`)
   - Windows: `.exe` (NSIS installer) and `.msi`
   - Linux: `.deb` and `.AppImage`
5. Each installer is cryptographically signed by the Tauri CLI using the
   private key from the environment.
6. A `latest.json` updater feed is generated per platform with the download
   URLs and per-artifact Ed25519 signatures.
7. The feed is published to the update endpoint:
   `https://updates.brows3r.dev/{{target}}/{{current_version}}`

### 3.3 Verify a signed artifact

To confirm an artifact was signed correctly, use:

```sh
tauri signer verify --pub-key-file ~/.tauri/brows3r.key.pub path/to/installer
```

---

## Section 4: Key rotation

Rotating the signing key is disruptive by design. Old clients verify downloads
against the public key embedded in their binary; they cannot verify artifacts
signed with a new key.

### 4.1 When to rotate

- The private key is suspected to be compromised.
- The passphrase was inadvertently exposed.
- Scheduled rotation policy (annually recommended).

### 4.2 Rotation procedure

1. Generate a new keypair following Section 1.
2. Replace `plugins.updater.pubkey` in `tauri.conf.json` with the new public
   key and commit.
3. Update the GitHub Actions secrets `TAURI_UPDATER_PRIVATE_KEY` and
   `TAURI_UPDATER_KEY_PASSWORD` with the new values.
4. Ship a new release tagged with the next version number.

**Important:** Clients running a version older than the rotation release will
attempt to verify the new artifacts against the old public key and will fail.
Those clients cannot auto-update and must download the new release manually.
Communicate the rotation clearly in release notes.

### 4.3 Retire the old key

Once a grace period has elapsed (minimum two release cycles to allow existing
users to update), delete the old `~/.tauri/brows3r.key` from any local storage.
The offline backup may be retained for audit purposes.

---

## Section 5: Recovery if the key is lost

If both the GitHub Actions secret and the local `~/.tauri/brows3r.key` are
lost, there is no way to produce artifacts that existing clients will accept via
auto-update.

### 5.1 Immediate steps

1. Remove the compromised or lost key from all locations.
2. Generate a new keypair following Section 1.
3. Commit the new public key to `tauri.conf.json`.
4. Set the new GitHub Actions secrets.
5. Tag and release the next version.

### 5.2 User impact

All users on any existing version are **stranded**: their auto-updater will
reject artifacts signed with the new key. They must manually download the next
release from the GitHub Releases page.

Publish a prominent announcement in release notes explaining that a manual
download is required to continue receiving future auto-updates.

### 5.3 Mitigation

Do not lose the key. Maintain the offline backup described in Section 2.3.
Treat the private key with the same care as a root CA private key.

---

## Section 6: macOS code signing and notarization

macOS requires every distributed app bundle to be code-signed with an Apple
Developer ID Application certificate and notarized by Apple before it can run
on end-user machines without a security warning.

### 6.1 Obtain an Apple Developer ID Application certificate

1. Enroll in the Apple Developer Program at
   [developer.apple.com](https://developer.apple.com/programs/).
2. Open **Xcode → Settings → Accounts**, sign in with your Apple ID, and click
   **Manage Certificates**.
3. Click **+** and choose **Developer ID Application**.
4. Xcode requests the certificate from Apple and installs it in your login
   keychain automatically.

Alternatively, use the Certificates, Identifiers & Profiles section of the
Apple Developer portal to generate a certificate signing request (CSR) from
Keychain Access and upload it.

### 6.2 Export the certificate to a .p12 file

1. Open **Keychain Access**.
2. Find your **Developer ID Application: `<Name>` (`<Team ID>`)** certificate.
3. Right-click → **Export** → choose format **Personal Information Exchange
   (.p12)**.
4. Set a strong export password and save to a temporary path, e.g.
   `~/Desktop/dev-id-app.p12`.
5. Base64-encode the file for storage as a GitHub Actions secret:

   ```sh
   base64 -i ~/Desktop/dev-id-app.p12 | pbcopy
   ```

   The encoded string is now in your clipboard.
6. Delete the `.p12` file from disk once the secret is stored.

### 6.3 Create an app-specific password

1. Sign in at [appleid.apple.com](https://appleid.apple.com/).
2. Navigate to **Sign-In and Security → App-Specific Passwords**.
3. Click **+**, label it `brows3r-notarytool`, and copy the generated password
   immediately — it is shown only once.
4. Store it as the GitHub Actions secret `APPLE_PASSWORD` (see Section 6.4).

### 6.4 Required GitHub Actions secrets

Add all of the following under **Settings → Secrets and variables → Actions →
New repository secret**:

| Secret name | Value | Source |
|---|---|---|
| `APPLE_CERTIFICATE_P12_BASE64` | Base64-encoded `.p12` | Section 6.2 |
| `APPLE_CERTIFICATE_PASSWORD` | Export password chosen in Section 6.2 | Section 6.2 |
| `APPLE_SIGNING_IDENTITY` | Full certificate name, e.g. `Developer ID Application: Acme Inc (ABCD1234EF)` | Keychain Access |
| `APPLE_ID` | Apple ID email address used to log in to developer.apple.com | developer.apple.com account |
| `APPLE_PASSWORD` | App-specific password from appleid.apple.com | Section 6.3 |
| `APPLE_TEAM_ID` | 10-character team identifier, e.g. `ABCD1234EF` | developer.apple.com membership page |
| `TAURI_UPDATER_PRIVATE_KEY` | Full contents of `~/.tauri/brows3r.key` | Section 2.1 |
| `TAURI_UPDATER_KEY_PASSWORD` | Passphrase used during `tauri signer generate` | Section 2.1 |

### 6.5 Test notarization locally before releasing

You can submit any `.dmg` to Apple's notary service from your local machine
without triggering a full release. This is useful for validating certificate
and credentials setup before the first real tag.

```sh
# Build a local .dmg first (requires signing env vars from Section 2.2)
pnpm tauri build --target universal-apple-darwin

DMG=$(find src-tauri/target/universal-apple-darwin/release/bundle/dmg \
      -name "*.dmg" | head -1)

# Submit and wait for Apple's verdict (usually < 5 minutes)
xcrun notarytool submit "$DMG" \
  --apple-id "your@apple.id" \
  --team-id "ABCD1234EF" \
  --password "your-app-specific-password" \
  --wait

# Staple the ticket onto the .dmg
xcrun stapler staple "$DMG"

# Verify the staple was applied
xcrun stapler validate "$DMG"

# Verify the code signature
codesign --verify --deep --strict --verbose=2 \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/brows3r.app"

# Check with Gatekeeper
spctl --assess --type exec --verbose \
  "src-tauri/target/universal-apple-darwin/release/bundle/macos/brows3r.app"
```

A successful result shows `accepted source=Notarized Developer ID`.

---

## Section 7: Windows code signing (Authenticode)

Windows Defender SmartScreen and enterprise security policies require every
distributed `.exe` to carry an Authenticode signature from a trusted certificate
authority. Without it, users see a "Windows protected your PC" SmartScreen
warning, and many enterprise environments will block the installer outright.

### 7.1 Code signing certificate options

| Provider | Certificate type | Notes |
|---|---|---|
| [DigiCert](https://www.digicert.com/signing/code-signing-certificates) | OV or EV | EV provides immediate SmartScreen reputation; OV requires reputation build-up |
| [Sectigo](https://sectigo.com/ssl-certificates-tls/code-signing) | OV or EV | Comparable pricing to DigiCert |
| [GlobalSign](https://www.globalsign.com/en/code-signing-certificate/) | OV or EV | Well-supported in enterprise chains |
| [SSL.com](https://www.ssl.com/certificates/ev-code-signing/) | OV or EV | Often lower cost for indie developers |

**Recommendation:** EV (Extended Validation) certificates start with full
SmartScreen reputation immediately because the private key is stored on a
hardware token verified by the CA. OV certificates require accumulating
download volume before SmartScreen lowers its warning level. For a new app,
EV is worth the higher cost.

### 7.2 Export the PFX and base64-encode for GitHub

Most CAs issue OV certificates as a downloadable PFX. EV certificates are
bound to a hardware token and cannot be exported — for EV, use a CI signing
service (e.g. SSL.com eSigner, DigiCert KeyLocker) rather than the GitHub
secret approach below.

For OV certificates:

1. The CA will email a certificate or provide a download link. Import it into
   the Windows Certificate Store or Keychain.
2. Export the certificate + private key as a `.pfx`:
   - Windows: `certmgr.msc` → find your cert → right-click →
     **All Tasks → Export** → include private key → set a strong password →
     save as `brows3r-sign.pfx`.
   - macOS (if managing certs there): `Keychain Access` → select cert + key →
     **File → Export Items** → Personal Information Exchange (`.p12`) →
     set export password. Rename to `.pfx` — the formats are identical.
3. Base64-encode the `.pfx`:

   ```sh
   # macOS / Linux
   base64 -i brows3r-sign.pfx | pbcopy   # copies to clipboard on macOS

   # Windows PowerShell
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("brows3r-sign.pfx")) |
     Set-Clipboard
   ```

4. Delete the local `.pfx` once the secret is stored (keep the original
   CA-issued file in offline cold storage).

### 7.3 Required GitHub Actions secrets

Add the following under **Settings → Secrets and variables → Actions → New
repository secret**:

| Secret name | Value | Notes |
|---|---|---|
| `WINDOWS_CERTIFICATE_PFX_BASE64` | Base64-encoded `.pfx` from Section 7.2 | OV only; for EV use a signing service |
| `WINDOWS_CERTIFICATE_PASSWORD` | Export password chosen in Section 7.2 | Leave blank if no password was set |
| `TAURI_UPDATER_PRIVATE_KEY` | Full contents of `~/.tauri/brows3r.key` | Shared with macOS (Section 2.1) |
| `TAURI_UPDATER_KEY_PASSWORD` | Passphrase from `tauri signer generate` | Shared with macOS (Section 2.1) |

### 7.4 Local signing rehearsal

You can sign a locally built installer without triggering a full CI release.
Run these commands on a Windows machine or in a Windows VM with the Windows SDK
installed:

```powershell
# Set env vars for the Tauri updater (same as CI)
$env:TAURI_UPDATER_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\brows3r.key" -Raw
$env:TAURI_UPDATER_KEY_PASSWORD = "your-passphrase"

# Build the NSIS installer
pnpm tauri build

# Find the produced .exe
$exePath = Get-ChildItem `
  -Path "src-tauri\target\release\bundle\nsis" `
  -Filter "*.exe" -Recurse |
  Select-Object -First 1 -ExpandProperty FullName

# Sign with your local certificate (must be installed in the certificate store,
# or reference the PFX file directly with /f)
signtool sign `
  /f path\to\brows3r-sign.pfx `
  /p "your-export-password" `
  /tr http://timestamp.digicert.com `
  /td sha256 `
  /fd sha256 `
  $exePath

# Verify the signature
signtool verify /pa /v $exePath
```

`signtool` ships with the Windows SDK. On a fresh machine, install it via
**Visual Studio Installer → Individual Components → Windows SDK**.

### 7.5 Cross-signing and SmartScreen reputation

SmartScreen assigns reputation to both the signing certificate and the
download URL. A brand-new OV certificate starts with zero reputation, meaning
users will see a "Windows protected your PC" warning even on a validly signed
binary. The warning shows a "Run anyway" link; it does not block execution.

Strategies to build SmartScreen reputation faster:

1. **Use an EV certificate** — skips the reputation ramp-up entirely.
   The hardware token requirement means EV cannot use the GitHub secret
   approach; instead use a cloud signing service such as
   [SSL.com eSigner](https://www.ssl.com/how-to/automate-ev-code-signing-with-esigner/)
   or [DigiCert KeyLocker](https://www.digicert.com/signing/keylocker).
2. **Submit the binary to Microsoft** — use the
   [Microsoft Security Intelligence submission portal](https://www.microsoft.com/en-us/wdsi/filesubmission)
   to submit false-positive samples; approved binaries gain reputation.
3. **Distribute broadly** — reputation accumulates per unique download from
   different machines. Each version resets the counter, so minimize
   unnecessary version churn early on.
4. **Consistent publisher name** — the O= field in your certificate's subject
   must match the publisher name users see. Changing it resets reputation.

---

## Section 8: Linux packaging (AppImage + deb)

### 8.1 Build runner requirements

The CI workflow runs on `ubuntu-22.04`.  This specific image is pinned rather
than `ubuntu-latest` because AppImage binaries embed a minimum glibc version
equal to the host at build time.  Building on the oldest supported Ubuntu LTS
maximises runtime compatibility: an AppImage built on glibc 2.35 (Ubuntu 22.04)
runs on any distro shipping glibc ≥ 2.35 — that covers Ubuntu 22.04, 24.04,
Fedora 38+, Debian 12+, and most modern rolling-release distros.

Required APT packages on the build runner:

| Package | Purpose |
|---|---|
| `libwebkit2gtk-4.1-dev` | WebView2 engine — Tauri 2.x requires the 4.1 API series |
| `libssl-dev` | TLS for AWS SDK HTTP calls |
| `libgtk-3-dev` | GTK 3 widget toolkit headers (Tauri system tray and dialogs) |
| `libayatana-appindicator3-dev` | Cross-desktop system tray via Ayatana/libappindicator |
| `librsvg2-dev` | SVG rendering for app icons inside the bundle |
| `libfuse2` | FUSE 2 library — required at build time by `appimagetool` to mount and inspect AppImages |

Install all of them in one `apt-get` call to keep the runner cache coherent:

```sh
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends \
  libwebkit2gtk-4.1-dev \
  libssl-dev \
  libgtk-3-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libfuse2
```

### 8.2 Building locally

```sh
# Export the Tauri updater key (same as macOS/Windows — see Section 2.2)
export TAURI_UPDATER_PRIVATE_KEY="$(cat ~/.tauri/brows3r.key)"
export TAURI_UPDATER_KEY_PASSWORD="your-passphrase"

# Build both bundle formats in one invocation
pnpm tauri build --bundles deb,appimage
```

Artifacts land at:

| Format | Path |
|---|---|
| `.AppImage` | `src-tauri/target/release/bundle/appimage/*.AppImage` |
| `.deb` | `src-tauri/target/release/bundle/deb/*.deb` |
| `.AppImage.sig` | alongside the AppImage (Ed25519 signature) |
| `.deb.sig` | alongside the .deb (Ed25519 signature) |

### 8.3 AppImage runtime requirements (end-user machines)

An AppImage is a self-contained executable that mounts itself via FUSE at
runtime.  End users must have either `libfuse2` (FUSE 2) or `libfuse3`
installed.  Most desktop Linux distros ship one of these by default.

On Ubuntu 22.04+ and derivatives `libfuse2` may need to be installed manually:

```sh
sudo apt-get install libfuse2
```

As an alternative to FUSE, AppImages support extraction mode:

```sh
./brows3r_*.AppImage --appimage-extract
# Extracted to ./squashfs-root/
./squashfs-root/AppRun
```

This lets users run the application on systems where FUSE is unavailable or
restricted (e.g. some container environments).

### 8.4 AppImage signing (deferred)

The Tauri CLI signs each AppImage with the Ed25519 updater key automatically
(producing a `.sig` sidecar).  This is sufficient for the auto-update flow.

Traditional AppImage signing with `appimagetool --sign` (GPG-based, separate
from the Tauri key) is **not implemented in v1**.  It would add a dependency on
a GPG key lifecycle and a separate distribution channel for the public key.
Defer to a future release if GPG-based artifact verification is required by
distribution channels (e.g. the AppImage catalog).

### 8.5 Required GitHub Actions secrets

The Linux job shares the Tauri updater secrets with macOS and Windows.  No
additional Linux-specific secrets are required.

| Secret name | Value |
|---|---|
| `TAURI_UPDATER_PRIVATE_KEY` | Full contents of `~/.tauri/brows3r.key` (Section 2.1) |
| `TAURI_UPDATER_KEY_PASSWORD` | Passphrase from `tauri signer generate` (Section 2.1) |

---

## Appendix: Update endpoint feed format

The updater feed at `https://updates.brows3r.dev/{{target}}/{{current_version}}`
returns JSON shaped as Tauri expects:

```json
{
  "version": "1.2.3",
  "notes": "Release notes for this version.",
  "pub_date": "2026-05-09T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "<base64 Ed25519 signature>",
      "url": "https://releases.brows3r.dev/v1.2.3/brows3r_1.2.3_aarch64.dmg"
    },
    "darwin-x86_64": {
      "signature": "<base64 Ed25519 signature>",
      "url": "https://releases.brows3r.dev/v1.2.3/brows3r_1.2.3_x86_64.dmg"
    },
    "linux-x86_64": {
      "signature": "<base64 Ed25519 signature>",
      "url": "https://releases.brows3r.dev/v1.2.3/brows3r_1.2.3_amd64.AppImage"
    },
    "windows-x86_64": {
      "signature": "<base64 Ed25519 signature>",
      "url": "https://releases.brows3r.dev/v1.2.3/brows3r_1.2.3_x64-setup.exe"
    }
  }
}
```

The update server or static hosting must serve this document at the endpoint
URL before `tauri-plugin-updater` can deliver updates to end users.

---

## Section 9: Tagging and Release Procedure

This section is the mechanical checklist for cutting a release after all
pre-release validation from Sections 1–8 is complete.

### Step 1 — Update CHANGELOG.md

Rename the `[Unreleased]` block to the new version and date, and add a fresh
empty `[Unreleased]` block above it:

```markdown
## [Unreleased]

## [0.1.0] - 2026-05-09
### Added
- ...
```

Commit the changelog update on the release branch before tagging.

### Step 2 — Tag the release

```sh
git tag v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

The tag must match `v*.*.*` to trigger the release workflow
(`.github/workflows/release.yml`, documented in Sections 3 and 6–8).

### Step 3 — GitHub Actions release workflow

The workflow runs automatically on tag push. It runs three parallel jobs:

| Job | Runner | Artifacts |
|---|---|---|
| macOS | `macos-latest` | `.dmg` (universal), notarized |
| Windows | `windows-latest` | `.exe` (NSIS), `.msi` |
| Linux | `ubuntu-22.04` | `.AppImage`, `.deb` |

Each artifact is signed with the Ed25519 updater key from the
`TAURI_UPDATER_PRIVATE_KEY` GitHub Actions secret (Section 2.1). The workflow
also generates and publishes the `latest.json` updater feed for each platform
(see the Appendix for the feed format).

Monitor the run at:
`https://github.com/banduk/brows3r/actions`

### Step 4 — Verify artifacts on the Releases page

Once the workflow completes, open the GitHub Releases page and confirm:

- [ ] All three platform artifacts are present.
- [ ] Each artifact has a corresponding `.sig` sidecar.
- [ ] The `latest.json` feed is published at the updater endpoint.
- [ ] Release notes match the CHANGELOG entry.

Verify the macOS artifact with:

```sh
tauri signer verify \
  --pub-key-file ~/.tauri/brows3r.key.pub \
  path/to/brows3r_0.1.0_universal.dmg
```

Verify the macOS notarization with (Section 6.5):

```sh
spctl --assess --type exec --verbose \
  "brows3r.app"
```

### Step 5 — Test auto-update from a previous version

Install the previous release on each platform and verify that the in-app
updater detects and applies the new version:

1. Open brows3r (previous version).
2. Trigger an update check: **Help → Check for Updates** or wait for the
   periodic background check.
3. Confirm the update notification appears and the version string matches
   `v0.1.0`.
4. Click **Install and Restart**.
5. Verify the app relaunches on `v0.1.0`.

Repeat on macOS, Windows, and Linux.

If no previous release exists (first release), skip this step and note it in
the release post.

### Step 6 — Announce

- Publish the GitHub Release (change Draft → Published if the workflow left it
  as a draft).
- Post a release announcement in the project discussion forum or mailing list
  referencing the CHANGELOG entry.
- If the key was rotated since the last release, include a prominent note that
  users on older versions must download manually (see Section 4.2).

---

## Alternative release strategies (future)

The current pipeline (`release-please.yml` + chained build jobs +
`release-build.yml` for manual recovery) implements **continuous release**:
release-please keeps one open PR titled `chore(main): release X.Y.Z`,
and merging that PR cuts the version. This page documents the most common
community alternatives so the project can switch deliberately when the
context changes.

### Pattern 1 — Continuous release (current)

What we have. release-please opens/refreshes a release PR on every push to
`main`. Maintainer merges when ready.

**Strengths**: zero ceremony, conventional-commit-driven version inference,
PR works as a "ready-to-ship preview".

**When to switch away**: contributors complain about a perma-open PR, or
release cadence drops below ~monthly.

### Pattern 2 — Manual-only

Strip the `push` trigger from `release-please.yml`, leaving
`workflow_dispatch` only. Maintainer clicks "Run workflow" in Actions when
they want to consider a release.

**Strengths**: no open PR until the maintainer asks for one. Fewer email
notifications.

**Trade-off**: forgotten releases — feature accumulates on `main` but
nothing tells the maintainer "X commits since last release".

### Pattern 3 — Channel-based (Chrome / Firefox / VS Code)

Multiple long-lived branches map to release channels with distinct version
schemes:

```
main      → stable   v1.2.3
develop   → beta     v1.3.0-beta.4   ← continuous from `develop`
nightly   → nightly  v1.4.0-dev.20260512  ← cron-built
```

release-please supports this via the `target-branch` input plus per-branch
configs that set `prerelease: true` and `prerelease-type: "beta"`. Run one
job per branch in a matrix.

**Strengths**: enthusiasts test the beta, mainstream users stay on stable.
Catches regressions before they reach the latter.

**When to adopt**: brows3r grows a public beta tester pool.

### Pattern 4 — Release branches (Git Flow)

Cut `release/1.x` from `main` when the line stabilises; bug fixes land on
the release branch (via cherry-pick from `main`) for the lifetime of the
1.x series. Major version 2 branches from `main` later.

**Strengths**: supports LTS in parallel with active development. Common in
projects with downstream consumers locked to a major.

**Trade-off**: heavy process. Worth it only when "v1 is in production at
several places and we can't break them while building v2".

### Pattern 5 — Tag-and-forget

Delete `release-please.yml` entirely; you run `git tag v1.2.3 && git push
--tags` manually. Enable the `push.tags` trigger in `release.yml` so the
signed pipeline (or the unsigned `release-build.yml`) reacts to the tag.

**Strengths**: zero infra moving parts.

**Trade-off**: you maintain `CHANGELOG.md` and the three version files
(`package.json`, `Cargo.toml`, `tauri.conf.json`) by hand. No conventional-
commit version inference.

### Builds for arbitrary branches (today, no setup needed)

`release-build.yml` already accepts any ref via `workflow_dispatch`. To
hand a colleague a binary built from `feature/foo`:

```sh
gh workflow run release-build.yml --repo banduk/brows3r --ref feature/foo \
  -f tag=$(git rev-parse --short HEAD)
```

(The artefacts upload step uploads to a GitHub Release named after the
tag input — for a feature-branch dry-run you'll see a "release not found"
error after the build itself succeeds. The native bundles still appear in
the workflow run's *Artifacts* section, downloadable from the Actions UI.)

If feature-branch previews become routine, two cheap upgrades:

1. Make the upload step conditional on a real release existing, so the
   workflow succeeds for unreleased builds.
2. Wire a PR-comment bot ("/preview") that runs release-build for the
   PR's head branch and posts artefact URLs back to the PR.

Neither is implemented yet — drop them in when the pain justifies the
infra.

### Choosing one

| Symptom | Try |
|---|---|
| "Don't want the open release PR" | Pattern 2 — manual-only |
| "Solo and prefer typing tags" | Pattern 5 — tag-and-forget |
| "Want users to opt into beta channel" | Pattern 3 — channel-based |
| "Need v1 maintained while building v2" | Pattern 4 — release branches |
| "Need one-off binaries from feature branches" | Existing `release-build.yml` dispatch |

Default for brows3r-the-solo-project is Pattern 1. Re-evaluate when the
team grows past one or release cadence shifts.
