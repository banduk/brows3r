# brows3r — Local Dev Quickstart

A new contributor should be able to clone the repo and run the app in under
10 minutes by following this guide.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Rust + Cargo | stable (via rustup) | `curl https://sh.rustup.rs -sSf \| sh` |
| Node.js | 20 LTS or later | [nodejs.org](https://nodejs.org/) or `fnm`/`nvm` |
| pnpm | 9 or later | `npm install -g pnpm` |
| OS build deps (Linux only) | — | see below |

### Linux system packages

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

macOS and Windows require no extra system packages beyond Xcode Command Line
Tools / Visual Studio C++ Build Tools, which the Tauri pre-requisites guide
covers.

---

## Clone and install

```sh
git clone https://github.com/banduk/brows3r.git
cd brows3r
pnpm install
```

`pnpm install` runs `postinstall`, which calls `lefthook install` to set up
git hooks automatically. No separate hook installation step is needed.

---

## Run in dev mode

```sh
pnpm tauri dev
```

This starts the Vite dev server (with HMR) and the Tauri native shell
concurrently. The first run compiles the Rust backend; subsequent runs use
the incremental cache and are faster.

To iterate on the frontend alone without the Tauri shell (useful for
component work):

```sh
pnpm dev
```

---

## Running tests

### Frontend unit and component tests

```sh
pnpm test --run
```

Uses Vitest. The `--run` flag exits after a single pass (no watch mode).

### Rust unit tests

```sh
cargo test --lib
```

Runs all `#[cfg(test)] mod tests` blocks inside the library crate. Fast and
requires no external services.

### Integration tests (LocalStack required)

```sh
pnpm test:integration
```

Equivalent to:

```sh
LOCALSTACK_URL=http://localhost:4566 cargo test --features integration
```

See the LocalStack setup section below.

---

## LocalStack setup

LocalStack provides a local S3-compatible endpoint for integration tests.

```sh
docker run --rm -d \
  -p 4566:4566 \
  localstack/localstack
```

Verify it is up:

```sh
curl -s http://localhost:4566/_localstack/health | grep '"s3"'
```

You should see `"s3": "running"` or similar.

The integration tests create and destroy their own buckets; no manual bucket
setup is required.

---

## MinIO contract tests (optional)

MinIO exercises the `path_style`, `expect_continue=off`, and
`checksum_mode=disabled` compat flags. Run these only when touching
`profiles/compat_flags.rs` or the S3 client builder.

```sh
docker run --rm -d \
  -p 9000:9000 \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data
```

Then run the contract suite:

```sh
MINIO_URL=http://localhost:9000 cargo test --features minio-contract
```

---

## Pre-commit hooks

Lefthook runs automatically on `git commit`:

- `biome check` — lints and format-checks TS/JS/JSON files.
- `cargo clippy` — Rust linter (warnings are errors in CI).
- `commitlint` — enforces the Conventional Commit format on the message.

If a hook rejects your commit, fix the issue and re-stage. Never use
`--no-verify`.

---

## Editor setup

### VS Code (recommended extensions)

| Extension | Purpose |
|---|---|
| `rust-lang.rust-analyzer` | Rust language server |
| `biomejs.biome` | Biome lint/format (replaces ESLint + Prettier) |
| `bradlc.vscode-tailwindcss` | Tailwind class autocomplete |
| `tauri-apps.tauri-vscode` | Tauri command palette and snippets |

Biome is the formatter for all TS/JS/JSON files. Disable any conflicting ESLint
or Prettier extensions for this workspace.

### Settings snippet

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "biomejs.biome",
  "[rust]": {
    "editor.defaultFormatter": "rust-lang.rust-analyzer"
  }
}
```

---

## Useful commands

| Command | Description |
|---|---|
| `pnpm lint` | Biome lint check (no writes) |
| `pnpm lint:fix` | Biome lint + auto-fix |
| `pnpm typecheck` | TypeScript type check (`tsc --noEmit`) |
| `cargo clippy --all-targets -- -D warnings` | Rust lint (CI level) |
| `cargo fmt --check` | Rust format check |
| `pnpm tauri build` | Production build (requires signing env vars) |
