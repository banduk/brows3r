# Contributing to brows3r

Thanks for considering a contribution. This file is the short version; the
full guide lives at [your-org.github.io/brows3r/contributing/](https://your-org.github.io/brows3r/contributing/).

## Quick path

1. **Open an issue** describing the bug or feature. Tiny fixes (typos,
   docs) can skip this and go straight to a PR.
2. **Fork + branch.** `fix/<slug>` or `feat/<slug>`. Integration branch
   is `main`.
3. **Install + run.**
   ```sh
   pnpm install
   pnpm tauri dev
   ```
4. **Add tests** for any behaviour change.
5. **Run the checks locally.**
   ```sh
   pnpm typecheck
   pnpm lint
   pnpm test --run
   cargo test --workspace --all-targets --manifest-path src-tauri/Cargo.toml
   cargo clippy --workspace --all-targets --manifest-path src-tauri/Cargo.toml
   ```
6. **Open the PR.** Reference the issue. First paragraph of the body ships
   in the changelog.

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/), enforced by
commitlint via lefthook. Types: `feat`, `fix`, `perf`, `refactor`, `docs`,
`chore`, `test`, `ci`. Scope is optional but encouraged:
`feat(preview): segmented Rendered/Source toggle in HtmlPreview`.

## What reviewers look for

In priority order:

1. **Credential boundary intact.** No PR moves credentials, signatures,
   or session tokens into the WebView. Every S3 call stays in Rust.
2. **Capability gaps surfaced kindly.** New operations classify their
   errors and update the capability cache; controls mute themselves
   when the cache says so. No new red error banners for permission /
   not-implemented cases.
3. **Behaviour change → test.** Anything user-facing gets a Vitest +
   axe a11y test on the frontend or a `cargo test` on the Rust side.
4. **Type-correct.** No `as any`, no `@ts-ignore` without a tracked
   issue.
5. **Bundle size.** Heavy deps (Monaco, Shiki grammars, pdf.js,
   parquet-wasm) must be code-split — see `manualChunks` in
   `vite.config.ts`.

## Reporting security issues

Don't open a public issue. Send to the address in [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Contributor Covenant 2.1](CODE_OF_CONDUCT.md).
By participating you agree to abide by it.

## License

By contributing you agree your contributions will be licensed under
the [MIT License](LICENSE).
