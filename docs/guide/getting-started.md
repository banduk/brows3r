# What is brows3r?

**brows3r** is a native desktop application for browsing S3 and S3-compatible
object storage. It exists because the AWS console is slow, the AWS CLI has no
preview, and every existing GUI client either talks to the network without
authorization or hides what is happening behind opaque progress bars.

The design goals, in priority order:

1. **Engineers feel at home.** Keyboard-first. Seven view modes. A command
   palette. Inline previews for the file types people actually deal with at
   work (text, JSON, Parquet, PDFs, logs, archives).
2. **Credentials never leak.** AWS keys live in the OS keychain. The WebView
   has no access to them — every S3 call is mediated by Rust.
3. **Operations feel local.** Drag-and-drop upload. Recursive folder
   download. Bookmarks at any level. Inspector for bucket and object
   metadata. Multipart cleanup scanner.
4. **Honest about what S3 cannot do.** "Move" is a copy-then-delete with
   transactional rollback. Recursive operations are paged. "Open in
   editor" warns when the object is locked or read-only. No magic.

This site documents the user-facing features in [Guide](/guide/getting-started),
the engineering decisions in [Concepts](/concepts/architecture), and the
contribution process in [Contributing](/contributing/).

## Status

brows3r is in active development. The current focus is the v1 release —
a feature-complete browser for AWS S3 and the two most common S3-compatible
backends (MinIO, Cloudflare R2). Track progress in the
[GitHub repository](https://github.com/banduk/brows3r) and the
[changelog](https://github.com/banduk/brows3r/blob/main/CHANGELOG.md).

## Quickstart

If you just want to try it:

```sh
git clone https://github.com/banduk/brows3r
cd brows3r
pnpm install
pnpm tauri dev
```

You need:

- Node 22+, pnpm 10+
- Rust toolchain 1.95+
- A platform that Tauri 2 supports (macOS, Linux, Windows)

The first build takes 5–10 minutes because Cargo compiles the AWS SDK and a
few hundred transitive crates. Subsequent runs are incremental.

Once the app opens, follow [First profile](/guide/first-profile) to point it
at an S3 bucket.

## Language

brows3r ships in six languages: English, Português (Brasil), Español,
Français, Deutsch, and 简体中文. The interface auto-detects the OS locale
on first launch; you can change it any time from **Settings → General →
Language**. The preference is persisted.

Adding a new language is a 3-step PR — see
[`docs/contributing/i18n.md`](https://github.com/banduk/brows3r/blob/main/docs/contributing/i18n.md).
