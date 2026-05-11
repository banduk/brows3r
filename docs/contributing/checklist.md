# Release Checklist

Use this checklist when tagging a new release. Each section must be fully
checked before proceeding to the next.

---

## Pre-release verification

- [ ] All frontend tests green: `pnpm test --run` (CI frontend job confirms)
- [ ] `cargo test --workspace --all-targets` green (CI Rust unit job confirms)
- [ ] `cargo test --workspace --features integration` green (CI Linux
      integration job with LocalStack confirms)
- [ ] Manual smoke on each platform (macOS, Windows, Linux):
  - [ ] Add a credential profile
  - [ ] List buckets
  - [ ] Upload a file
  - [ ] Download a file
  - [ ] Preview an image, a text file, and a CSV
  - [ ] Delete a file
- [ ] Manual screen-reader pass per [Accessibility](../concepts/accessibility.md):
  - [ ] VoiceOver on macOS
  - [ ] Narrator on Windows
- [ ] `CHANGELOG.md` `[X.Y.Z]` block populated and accurate
- [ ] Version bumped consistently:
  - [ ] `src-tauri/Cargo.toml` `version` field
  - [ ] `package.json` `version` field
  - [ ] `src-tauri/tauri.conf.json` `version` field

---

## Sign and notarize

- [ ] All 5 code-signing secrets configured in GitHub repository settings:
  - [ ] `TAURI_UPDATER_PRIVATE_KEY` (updater signing key)
  - [ ] `TAURI_UPDATER_KEY_PASSWORD` (passphrase for updater key)
  - [ ] `APPLE_CERTIFICATE` (base64-encoded .p12)
  - [ ] `APPLE_CERTIFICATE_PASSWORD`
  - [ ] `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: …`)
  - [ ] `APPLE_ID` (Apple ID used for notarization)
  - [ ] `APPLE_PASSWORD` (app-specific password)
  - [ ] `WINDOWS_CERTIFICATE` (base64-encoded .pfx)
  - [ ] `WINDOWS_CERTIFICATE_PASSWORD`
- [ ] Test signing locally if possible: `pnpm tauri build` produces a signed
      binary (macOS: check with `codesign -vvv`, Windows: check with
      `signtool verify`)

---

## Tag and release

- [ ] Create and push the version tag:
  ```sh
  git tag v0.1.0 -m "Release v0.1.0"
  git push origin v0.1.0
  ```
- [ ] GitHub Actions release workflow triggers automatically (3 jobs: macOS,
      Windows, Linux)
- [ ] All 3 jobs succeed (check Actions tab)
- [ ] Verify all 4 artifacts are present on the Releases page:
  - [ ] `.dmg` (macOS universal)
  - [ ] `.exe` (Windows NSIS)
  - [ ] `.AppImage` (Linux)
  - [ ] `.deb` (Linux)
- [ ] Updater feed JSON (`latest.json`) is published and includes a valid
      signature for each platform artifact

---

## Post-release smoke

- [ ] Download the `.dmg` on macOS, install, launch — first-run welcome modal
      appears
- [ ] Download the `.exe` on Windows, install, launch — first-run welcome
      modal appears
- [ ] Download and run the `.AppImage` on Linux — first-run welcome modal
      appears
- [ ] Install the `.deb` on a Debian/Ubuntu system — first-run welcome modal
      appears
- [ ] Verify auto-update path (test with v0.0.1 → v0.1.0 if a prior signed
      release exists):
  - [ ] App detects update and prompts user
  - [ ] Update installs without error
  - [ ] App relaunches on the new version
- [ ] Open a GitHub issue if any artifact is broken or the auto-update path
      fails

---

## Announcement

- [ ] GitHub Releases page release notes updated (mirror the CHANGELOG
      `[0.1.0]` block)
- [ ] Optional: blog post or social announcement
