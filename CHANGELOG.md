# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0](https://github.com/banduk/brows3r/compare/v0.1.0...v0.2.0) (2026-05-11)


### Features

* native s3 browser (v1) ([9c4c0ff](https://github.com/banduk/brows3r/commit/9c4c0ff3d2a15d3450e95a00458e1f1857d35639))


### Bug Fixes

* **ci:** release-please uses node release-type with extra-files ([9ffd928](https://github.com/banduk/brows3r/commit/9ffd9282e2045f3bc0cdc1b9c5ead0d282c586a9))
* **diagnostics:** redactor home_dir works on windows via USERPROFILE ([ff91d15](https://github.com/banduk/brows3r/commit/ff91d1518a476f846d3874d8e60679e7562fe011))

## [Unreleased]

### Added

### Changed

### Deprecated

### Removed

### Fixed

### Security

## [0.1.0] — 2026-05-10

### Added

**Navigation and view modes (AC-3)**

- Details list view: default table with sortable columns (key, size, last
  modified, storage class, ETag), multi-select, and bulk operations
- Icon/grid view: Finder-style thumbnail browsing
- Gallery view: large preview-first browsing for images, video, PDFs, and
  documents
- Column view: macOS Finder-style cascading navigation through
  bucket/prefix/object levels with selection reset on parent column change
- Tree view: expandable virtual folder hierarchy for scanning nested prefixes
- Flat key view: raw S3 object keys without virtual folder grouping, with
  virtual-folder selections collapsed to underlying objects
- Dual-pane view: side-by-side locations for copy/move workflows across
  prefixes, buckets, profiles, or accounts with independent pane state
- View-mode switching preserves selection and location per the documented
  per-mode exceptions
- Keyboard shortcuts `Cmd/Ctrl+1-7` to switch view modes

**File operations (AC-4)**

- Upload: single file, multi-file, folder (recursive), drag-and-drop from OS
- Download: single file, multi-file selection, folder (recursive prefix
  download)
- Delete: single and batch (`delete_objects`), with confirmation for >1 item
  or folders
- Copy: within bucket (server-side `copy_object`), cross-bucket, and
  cross-account with automatic download+upload fallback below the configured
  100 MB threshold and explicit confirmation above it
- Move: server-side copy then delete source
- Rename: copy to new key then delete old key
- Create folder: PUT zero-byte object at `prefix/` key
- Presigned URL generation with configurable expiry, copied to clipboard
- Object metadata setter: custom key-value pairs via Tauri command
- Object tag setter: key-value tag pairs
- Storage class change with diff preview and explicit confirmation (v1 trigger
  for the high-impact edit framework)
- Multipart upload cleanup scanner: lists old uploads, separates brows3r-owned
  from unknown, and requires explicit confirmation before aborting unknown ones
- Resource locks with full lifecycle: acquired on operation start,
  heartbeated, released on success/failure/cancellation, auto-expired after
  TTL, cleared on app startup
- Optimistic UI updates with rollback on S3 operation failure (Decision D2)

**Inspector — bucket and object properties (AC-5)**

- Read-only bucket inspector: region, versioning, encryption/KMS state,
  lifecycle rules, object lock, public access block, CORS, tags, replication,
  logging, website hosting, notifications, ownership controls, requester pays
- Read-only object inspector: key, size, content type, cache control, content
  disposition, content encoding, custom metadata, tags, storage class,
  server-side encryption/KMS state, object lock/legal hold/retention, version
  ID, ETag/checksum, last modified, restore/archive status
- Disabled-state copy for blocked, unsupported, or deferred properties (e.g.
  "Requires `s3:PutBucketVersioning`", "Deferred from v1") with no
  error-looking banners (AC-5)
- Lazy capability classification cache in Rust: classifies `AccessDenied` and
  unsupported-feature responses, caches results, renders disabled reasons
  without repeated API calls

**File preview (AC-6)**

- Image preview: JPEG, PNG, GIF, WEBP, SVG, BMP streamed directly in WebView
- Text/code preview: syntax highlighting via Shiki with lazy per-language
  loading
- Monaco Editor: in-place editing with ETag precondition save and clear
  conflict message with refresh/retry on version mismatch (AC-7)
- Media streaming: video (MP4, WebM, MOV) and audio (MP3, WAV, OGG, FLAC)
  served via a loopback HTTP server on a random port with signed session-token
  URLs; expired tokens are rejected by the server
- PDF preview via PDF.js
- Markdown preview via remark/rehype
- Hex viewer for unknown binary files with printable ASCII column
- Archive preview (ZIP, TAR, GZ): list contents via range requests without
  full download
- Tabular preview (CSV, JSON, NDJSON, Parquet) parsed in Web Workers and
  rendered with TanStack Table; first N rows shown with correct column headers
- Preview size limit warning (default 50 MB) with download-instead option

**Validation gate (AC-8)**

- 2-layer enforcement: cached bucket/object data not displayed until active
  credentials are validated for the profile
- Stale-while-revalidate: after validation, cached data is shown immediately
  and reconciled when fresh S3 data arrives without losing selection or scroll
  position
- Background revalidation injects additions, updates, and removals into the
  virtual list without a full re-render

**Notifications (AC-9)**

- In-app notification panel: background errors and completed operations with
  operation name, resource, timestamp, and copyable technical details
- Toast messages: inline/modal for current-interaction errors
- Inline disabled notices: muted copy for permission/capability gaps
- OS-level notifications via `tauri-plugin-notification` on transfer
  completion (configurable)

**Search, bookmarks, and recent locations (AC-10)**

- Local filter: typed query filters cached listing without S3 requests
- Bucket-wide prefix search: paginated `list_objects_v2` with cancellation
- Bookmarks: saved named paths persisted across sessions, shown in sidebar
- Recent locations: auto-tracked profile/bucket/prefix history, not shown for
  unvalidated profiles

**Settings screen — 14 panels (AC-11)**

- Default download directory
- Transfer concurrency (default: 4)
- Cache TTL (default: 5 min) and max cache size (default: 256 MB) with
  clear/force-refresh actions
- Preview file size limit (default: 50 MB)
- Keyboard shortcut bindings with conflict detection and resolution
- Default view mode per scope (global, profile, bucket)
- Notification behavior including OS notification toggle for completed transfers
- Cross-account download+upload fallback threshold (default: 100 MB)
- Transfer confirmation thresholds (default: >1 GB total, >100 objects, any
  cross-account operation)
- S3-compatible endpoint URL, region, and provider compatibility flags per
  profile
- Auto-update channel and check interval (default: stable, every 24 h)
- Diagnostics and log collection controls with 7-day local retention default
- Startup behavior (default: reopen last session)
- Proxy settings (default: system proxy)

**Auto-update and diagnostics (AC-12)**

- Tauri updater integration: prompts user when a signed update is available on
  the configured channel; update check failures appear in notifications without
  blocking browsing
- User-triggered diagnostics bundle: local logs, exception details, app
  version, OS version, and redacted runtime metadata (credentials, tokens,
  presigned URLs, local paths redacted before export)
- Bundle is saved to a user-chosen location; no automatic upload or telemetry

**Multi-account and multi-pane (AC-13)**

- Multiple credential profiles connected simultaneously, each as an
  independent pane with no credential bleed
- Cross-account copy with server-side attempt, `AccessDenied` detection, and
  threshold-based download+upload fallback

**Transfer manager (AC-14)**

- Active and completed transfers with progress bar, percentage, and speed
  (MB/s)
- Per-transfer cancel button; failed transfers show Retry (restarts from
  beginning in v1)
- Configurable concurrency cap (default: 4)
- Minimized progress accessible from notification/transfer area

**Platform and OS integration**

- Drag and drop: OS→S3 upload, S3↔S3 cross-pane move/copy, S3→OS drag-out
  on macOS and Windows; Linux falls back to a save dialog
- Native menus on macOS (File, Edit, View, Go, Help)
- Command registry + command palette (Cmd/Ctrl+K) with discoverable actions
  and configurable shortcuts
- Multi-platform packaging: macOS universal .dmg (signed + notarized),
  Windows .exe NSIS (Authenticode), Linux AppImage + .deb
- GitHub Actions release pipeline with 3 platform jobs and signed Tauri
  updater feed

### Documentation

- [Architecture overview](docs/architecture.md): Tauri 2 layering, cache
  ownership model, IPC boundary, and v1 design decisions
- [Developer guide](docs/dev.md): local setup with LocalStack and MinIO, pnpm
  commands, and onboarding in <10 minutes from clone
- [Security model](docs/security.md): credential boundary, media-server token
  model, diagnostic bundle redaction
- [Release guide](docs/release.md): tagging flow, signing secrets, and
  updater feed verification
- [Performance guide](docs/perf.md): lab benchmark conditions, AC-8 budgets,
  and how to reproduce cargo bench / Vitest perf results
- [Accessibility guide](docs/a11y.md): VoiceOver and Narrator pass notes,
  skip-link decisions, ARIA live region coverage
