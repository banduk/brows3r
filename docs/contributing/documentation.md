# Documenting brows3r

This page explains how the documentation itself is structured, built, and
published. It is — yes — documentation about documentation. The point is
to make adding a page or editing an existing one a one-command operation,
with no surprises about where the file should live or what gets published
when.

## Layout

```
docs/
├── .vitepress/
│   └── config.mts            # VitePress site config (nav, sidebar, theme)
├── public/                   # Static assets copied to /
│   ├── brows3r-banner.png
│   ├── brows3r-header.png
│   └── brows3r-icon.png
├── index.md                  # Landing page (hero + features grid)
├── guide/                    # User-facing tour
│   ├── getting-started.md
│   ├── install.md
│   ├── first-profile.md
│   ├── keyboard.md
│   ├── view-modes.md
│   ├── preview.md
│   ├── operations.md
│   ├── bookmarks.md
│   ├── inspector.md
│   └── multipart.md
├── concepts/                 # Engineering deep-dives
│   ├── architecture.md
│   ├── credentials.md
│   ├── cache.md
│   ├── media-server.md
│   ├── capabilities.md
│   ├── performance.md
│   └── accessibility.md
└── contributing/             # Contributor onboarding
    ├── index.md
    ├── dev.md
    ├── release.md
    ├── security.md
    ├── checklist.md
    └── documentation.md      # ← this page
```

Every markdown file in this tree is reachable via clean URL — `.md`
extensions are stripped (`cleanUrls: true` in the VitePress config).

## What gets generated at build time

```
dist-docs/                    # VitePress output (git-ignored)
├── ...                       # All hand-written pages
└── api/
    ├── ts/                   # TypeDoc-generated
    └── rust/                 # rustdoc-generated
```

The docs workflow in `.github/workflows/docs.yml` orchestrates three
steps:

1. **VitePress build.** `pnpm docs:build` renders the markdown tree into
   `dist-docs/`.
2. **TypeDoc.** `pnpm docs:api:ts` scans `src/api`, `src/lib`, `src/store`,
   and `src/query/hooks` and writes HTML to `dist-docs/api/ts/`.
3. **rustdoc.** `cargo doc --no-deps --document-private-items` in
   `src-tauri/` produces `target/doc/`, which the workflow copies into
   `dist-docs/api/rust/`.

The combined `dist-docs/` is uploaded as a Pages artefact and deployed
on every push to `main`.

## Adding a new page

1. **Pick the section.** Is it user-facing? `docs/guide/`. Engineering
   deep-dive? `docs/concepts/`. Process / how-to-contribute? `docs/contributing/`.
2. **Create the file.** Markdown with no frontmatter is enough — VitePress
   takes the first `#` heading as the title. Use frontmatter only when
   you want a custom layout (`layout: home` etc.).
3. **Add it to the sidebar.** Open `docs/.vitepress/config.mts`. Find the
   group matching your section and add a `{ text: "…", link: "…" }`
   entry. The link is the URL path without `.md`.
4. **Preview locally.**
   ```sh
   pnpm docs:dev          # http://localhost:5173/
   ```
5. **Run the production build to catch dead links** — VitePress fails
   the build on broken internal links by default:
   ```sh
   pnpm docs:build
   ```

If your page references something that only exists in CI (TypeDoc or
rustdoc output), VitePress is configured to allow those paths via
`ignoreDeadLinks` in the config.

## Conventions

### Headings

- Page title = single H1 (`#`). One per file.
- Sections = H2 (`##`).
- Subsections = H3 (`###`).
- The right-hand outline pulls from H2/H3 (`outline: { level: [2, 3] }`).

### Code blocks

- Always fence with the language: ` ```ts `, ` ```rs `, ` ```sh `.
- Inline code: backticks. Always backtick any file path, command, env
  var, function name, or angle-bracket placeholder — Vue/VitePress will
  otherwise parse `<Name>` as a custom tag and fail the build.

### Links

- **Internal**: relative paths, no `.md` extension.
  Good: `[Architecture](../concepts/architecture)`.
  Bad: `[Architecture](../concepts/architecture.md)` (works but
  inconsistent).
- **External**: full URL with `https://`.
- **GitHub**: full URL to the canonical repo. The repo slug is
  `banduk/brows3r` everywhere as a placeholder; substitute before
  publication.

### Tone

- Tight, opinionated, second-person ("you click", "we cache").
- No marketing copy. State trade-offs.
- Anchor every claim to an artefact: a file path, a function, a CLI
  command, a workflow.

### Diagrams

ASCII-art for architecture diagrams (renders in every reader, ages well,
diffable). For richer diagrams (sequence, state machines), use
[Mermaid](https://mermaid.js.org/) — VitePress supports it natively in
fenced code blocks tagged ` ```mermaid `.

## API reference generation

### TypeScript / JS

Driven by `typedoc.json` at the repo root. Conventions:

- Every exported symbol from the four entry-point trees (`src/api`,
  `src/lib`, `src/store`, `src/query/hooks`) is documented.
- Comments use TSDoc syntax (` /** ... */ `, with `@param`, `@returns`,
  `@throws`, `@example` tags).
- Internal types (only referenced, not re-exported) are excluded
  automatically by `excludeInternal: true`.
- Test files (`__tests__/**`, `*.test.ts`) and perf tests
  (`__perf__/**`) are excluded.

Add a new entry point by editing `typedoc.json`'s `entryPoints` array.

### Rust (Tauri)

Driven by `cargo doc`. Conventions:

- Module-level `//!` doc-comments for every `pub mod`.
- Item-level `///` doc-comments for every `pub` item.
- Use `# Examples` sections in doc-comments wherever the API is
  non-obvious — they double as doctests.

`--document-private-items` is on so contributors see the *whole* crate,
not just the public IPC surface. The published site is for engineers,
not API consumers.

## Local development tips

| Command | Use |
|---|---|
| `pnpm docs:dev` | Live-reload preview at `http://localhost:5173/`. |
| `pnpm docs:build` | Full production build into `dist-docs/`. Catches dead links. |
| `pnpm docs:preview` | Serve the production build locally. |
| `pnpm docs:api:ts` | Regenerate TypeDoc into `dist-docs/api/ts/`. |
| `(cd src-tauri && cargo doc --no-deps --open)` | rustdoc + open in browser. |

The dev server picks up markdown changes instantly, sidebar/config changes
require a restart.

## How the workflow runs

`.github/workflows/docs.yml`:

- **Triggers**: push to `main`, PRs that touch `docs/**`, `src/**`,
  `src-tauri/**`, `typedoc.json`, the workflow itself, or
  `package.json` / `pnpm-lock.yaml`. Manual via the Actions tab too.
- **Permissions**: `pages: write` + `id-token: write` scoped to the job
  — the GitHub Pages template.
- **Concurrency**: `group: pages, cancel-in-progress: false` so PR
  builds don't fight the production deploy.
- **PR builds**: stop at the artefact upload step. No deploy.
- **Main pushes**: deploy via `actions/deploy-pages@v4`.

The `DOCS_BASE` env var lets you override the published base path:
- Project Pages site (`https://<org>.github.io/brows3r/`): set to
  `/brows3r/` (the default in the workflow).
- User/org Pages site (`https://<org>.github.io/`): set to `/`.

## When to update this page

This page is the canonical answer to "where does X go?". Update it when:

- You add a new top-level section (e.g. a `recipes/` folder).
- You change a build tool (e.g. swap TypeDoc for an alternative).
- You change the workflow's trigger paths or deploy target.
- You change the `ignoreDeadLinks` rules in the VitePress config.
- You add a new asset convention (e.g. screenshots under `public/img/`).

If you're touching the docs infra and this page goes out of date, the
PR is incomplete. Reviewers should flag it.
