# Contributing to brows3r

brows3r is open source under the [MIT License](https://github.com/banduk/brows3r/blob/main/LICENSE).
Contributions of every size are welcome — bug reports, doc fixes,
typo PRs, new features, packaging help for a distro we don't yet target.

This page is the contributor's overview. The deeper pages are:

- [Dev environment](/contributing/dev) — toolchain, layout, conventions.
- [Release process](/contributing/release) — how signed builds happen.
- [Security](/contributing/security) — credential boundary, vuln disclosure.
- [Release checklist](/contributing/checklist) — pre-release sanity.

## Quick path

1. **Open an issue** describing the bug or feature. For small fixes
   (typos, doc clarifications, obvious bugs) the issue is optional —
   send the PR directly.
2. **Fork + branch.** Branch names look like `fix/<slug>` or
   `feat/<slug>`. The repo uses `main` as the integration branch.
3. **Run the dev loop.**
   ```sh
   pnpm install
   pnpm tauri dev
   ```
4. **Write tests** for any behaviour change. The frontend uses Vitest +
   React Testing Library + vitest-axe. The Rust side uses `cargo test`
   with `#[tokio::test]`.
5. **Run the checks** locally:
   ```sh
   pnpm typecheck
   pnpm lint
   pnpm test
   cargo test --lib              # in src-tauri/
   cargo clippy --all-targets    # in src-tauri/
   ```
   These also run in CI; failing CI is a request-changes signal.
6. **Open the PR.** Reference the issue. Describe the user-facing change
   in the first paragraph of the body — that paragraph ships in the
   changelog.

## Commit convention

[Conventional Commits](https://www.conventionalcommits.org/). Commitlint
enforces this on every commit via lefthook. Common types:

| Type | Use |
|---|---|
| `feat` | New user-visible behaviour |
| `fix` | Bug fix |
| `perf` | Measurable perf improvement |
| `refactor` | No behaviour change |
| `docs` | Docs only |
| `chore` | Tooling, deps, config |
| `test` | Tests only |
| `ci` | CI/CD config |

Scope is optional but encouraged: `feat(preview): rendering toggle for HTML`.

Squash-merge is the default; the PR title becomes the commit title.

## What we look for in PRs

In priority order:

1. **The invariants in the [credential boundary](/concepts/credentials)
   are not weakened.** PRs that move credentials into the WebView, or
   skip the validation gate, will be sent back unless there's a very
   good reason.
2. **Capability gaps are surfaced kindly.** New operations should classify
   their errors and update the capability cache; controls should mute
   themselves when the cache says so.
3. **Behaviour change → test.** Anything user-facing needs a test.
4. **Type-correct.** No `as any`, no `@ts-ignore` without a comment
   pointing at a tracked issue.
5. **Bundle size.** Heavy dependencies (Monaco, Shiki, pdf.js,
   parquet-wasm) must be code-split into their own chunk — see
   `manualChunks` in `vite.config.ts`.

## Reporting a security issue

Don't open a public issue. Email security disclosures to
`security@<the-org-hosting-the-repo>` (or whatever address is configured
in `SECURITY.md`). Full policy in [Security](/contributing/security).

## Code of Conduct

This project follows the [Contributor Covenant 2.1](https://www.contributor-covenant.org/).
Be kind, be specific, assume good faith.

## License

By contributing you agree that your contributions will be licensed under
the [MIT License](https://github.com/banduk/brows3r/blob/main/LICENSE).
