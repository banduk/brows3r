# Install

brows3r ships as a native desktop bundle for macOS, Linux, and Windows.

## From a release

Signed binaries land on the
[GitHub releases page](https://github.com/banduk/brows3r/releases) on every
tagged `v*.*.*` push. Download the artifact matching your platform:

| Platform | Artifact |
|---|---|
| macOS | `.dmg` (notarised, universal) |
| Windows | `.exe` (Authenticode-signed, x64 NSIS installer) |
| Linux | `.AppImage` or `.deb` |

> **Note**: there are no signed releases yet — the first signed tag is
> tracked in [issue #1](https://github.com/banduk/brows3r/issues). Until
> then, build from source.

## From source

### Prerequisites

| Tool | Version |
|---|---|
| Node | 22+ |
| pnpm | 10+ |
| Rust | 1.95+ (`rustup install stable`) |
| Platform deps | macOS: nothing extra · Linux: `libwebkit2gtk-4.1-dev`, `libssl-dev` · Windows: `WebView2` (preinstalled on Win11) |

### Build and run in dev mode

```sh
git clone https://github.com/banduk/brows3r
cd brows3r
pnpm install
pnpm tauri dev
```

The first run compiles the Rust backend (5–10 min cold). Subsequent runs are
incremental.

### Build a release bundle locally

```sh
pnpm tauri build
# or, with the helper that prints the artefact paths nicely:
./scripts/build-local.sh
```

Output lands in `src-tauri/target/release/bundle/`. Unsigned binaries trigger
Gatekeeper / SmartScreen warnings — see
[Release process](/contributing/release) for the signing setup.

### Cross-platform builds

Tauri 2 cannot cross-compile WebView bundles, so each OS must be built on a
native host. To produce all three from a single source tree, trigger the
`release-dev` GitHub Actions workflow:

```sh
./scripts/release-dev.sh   # wraps `gh workflow run release-dev.yml`
```

Wait ~15 minutes; the action attaches `.dmg`, `.exe`, `.AppImage`, and `.deb`
artefacts to the run page. No tag, no GitHub release, no signing secrets
required — convenient for handing a colleague on Windows a quick build.

Full signing + release runbook: [Release process](/contributing/release).
