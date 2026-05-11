# Proposal: brows3r — Native S3 File Browser

## Why

AWS S3 is ubiquitous but its management tooling is painful. The web console is slow and navigation is tree-unfriendly. Third-party GUIs (Cyberduck, S3 Browser) are either Windows-only, slow, or lack modern UX. Engineers and data teams working across multiple AWS accounts waste significant time context-switching, downloading files to inspect them, and using the CLI for basic operations.

brows3r aims to be the definitive native S3 browser: a Tauri-based desktop app (macOS/Linux/Windows) that feels as fast as a local file manager, supports multiple AWS credential profiles simultaneously, and handles every common file operation with an experience on par with tools like Finder or Files.

## Current behavior and project context

Greenfield project. No prior codebase. The user's stack preferences from `identity.md`:
- Frontend: TypeScript with shadcn/ui components
- Package manager: pnpm or bun
- Linting: biome (TS)
- Anti-preferences: magic strings, classes when a function would do

Tauri 2.x is the chosen app shell (Rust backend, WebView frontend). AWS SDK for Rust (`aws-sdk-s3`) will be used in the Tauri backend for all S3 calls. The frontend is a React + Vite app inside Tauri.

## What changes

This is the initial full-scope proposal. The feature set is divided into phases to allow incremental delivery, but the architecture must support the full scope from day one.

## Decisions

- Bucket policy is deferred from v1. Bucket policy may be detected as present, but there is no policy editor or policy viewer in v1.
- Permission detection uses lazy API failure classification. The app attempts the requested read/write operation, classifies `AccessDenied`, `NoSuchBucket`, unsupported-feature, and storage-class errors, caches the capability result in Rust, and then renders subtle disabled-state explanations for future attempts.
- Resolved design questions are removed from `## Open questions` instead of kept as historical open items.
- Every major v1 feature area needs acceptance criteria: view modes, inspector behavior, permission-disabled controls, cache validation/freshness, errors, notifications, resource locks, settings, search, shortcuts, region discovery, and local media access.
- Cached bucket/object data is not shown until the active credentials are validated. After validation, cached data may be shown with stale-while-revalidate behavior.
- Bucket regions are discovered in the background for all listed buckets and cached by Rust for per-bucket clients.
- Bucket and object encryption/KMS settings are read-only in v1.
- Multipart upload cleanup uses an explicit cleanup scanner for old multipart uploads, with user confirmation before aborting uploads the app did not start in the current session.
- Performance requirements include both user-facing targets and lab benchmark conditions.
- Cross-account download+upload fallback is automatic only below a configured size threshold; larger fallbacks require explicit confirmation.
- Rust owns the authoritative cache. TanStack Query is a short-lived frontend adapter cache for render state and deduping UI requests.
- Local media streaming URLs use signed session tokens.
- Display paths are human-readable, while copied canonical URIs are percent-encoded and use stable internal profile IDs.
- High-impact property edits require a diff preview and confirmation before save.
- All navigation/view modes are in scope for the implementation phase plan.
- The properties inspector ships read-only first; editing is available only through explicitly scoped operations in v1.
- The notification/error foundation is implemented early and reused by all background and user-initiated operations.
- Settings cover shortcuts, cache limits, view defaults, notification behavior, transfer confirmations, and fallback thresholds.
- Search has two v1 modes: current-location local filtering and bucket-wide prefix search.
- Versioning configuration is visible, but object version listing, restore, and delete-marker workflows are not v1 features.
- Keyboard shortcuts use a command registry plus a baseline shortcut map.
- S3-compatible storage providers such as MinIO, Cloudflare R2, and Wasabi are supported through a v1 baseline set of provider compatibility flags plus an extension mechanism documented for the design phase.
- Auto-update is required for v1.
- Diagnostics are user-controlled: the app can collect/export logs, exceptions, and diagnostic bundles, but nothing is sent automatically.
- Credential storage backend is the `keyring` crate. `tauri-plugin-stronghold` is not used in v1.
- Storage class change is the v1 trigger that exercises the diff preview/confirmation framework. Other future high-impact bucket settings (lifecycle, public access block, object lock, website hosting, replication) will adopt the same framework when they become editable post-v1.
- Resource locks have explicit lifecycle: released on success, failure, or cancellation; cleared on app startup; and auto-expire after a TTL unless the owning operation heartbeats.
- View-mode switching has documented exceptions for selection/location preservation, listed inline with the navigation model.
- v1 default values are codified inline in `## Settings (with v1 defaults)` so acceptance criteria can be tested out of the box.

### Architecture decisions

**Tauri 2.x** as the application shell:
- Rust backend handles all AWS SDK calls, credential management, and file I/O
- Frontend is a React 18 + Vite + TypeScript SPA served inside the WebView
- Communication via Tauri commands (invoke) and events (emit/listen) — never expose AWS credentials to the frontend JS context
- Tauri plugins used: `tauri-plugin-fs`, `tauri-plugin-dialog`, `tauri-plugin-shell`, `tauri-plugin-notification`

**Credential management** (Rust side only):
- Reads `~/.aws/credentials` and `~/.aws/config` to populate available profiles
- Supports manual entry of access key + secret + optional session token
- Supports configurable endpoint URLs and provider compatibility flags for S3-compatible storage providers such as MinIO, Cloudflare R2, and Wasabi (see Provider compatibility flags below)
- Supports AWS profile role chaining from `~/.aws/config`; inline AssumeRole + MFA entry is not a v1 requirement
- Credentials stored via the OS native keychain using the `keyring` crate — never plaintext on disk beyond what AWS CLI already stores. `tauri-plugin-stronghold` is not used in v1 and is only revisited if a future need (e.g. cross-process encrypted vault with master password) emerges.
- Multiple profiles can be "connected" simultaneously, each rendered as a top-level workspace pane

**Provider compatibility flags** (per profile, applied to the underlying S3 client):
- `endpoint_url`: full base URL including scheme; required for non-AWS providers
- `region_override`: optional region string; if absent, falls back to AWS resolution or `us-east-1` for providers that ignore region
- `addressing_style`: `virtual_hosted` (default) or `path_style` (required for MinIO and many self-hosted setups)
- `signature_version`: `sigv4` (default) or `sigv2` (legacy compatibility toggle)
- `checksum_mode`: `standard` (default) or `disabled` (for providers that reject SDK-emitted checksum trailers, including some R2/MinIO configurations)
- `accept_self_signed_tls`: boolean, default `false`; per-profile opt-in for self-signed certs
- `expect_continue`: `auto` (default), `on`, or `off`; some providers reject `Expect: 100-continue`
- `chunked_upload`: `auto` (default), `force_on`, or `force_off`
- `bucket_name_validation`: `aws_strict` (default) or `relaxed` (allows non-AWS bucket naming)
- The flag set is the v1 baseline. A documented extension mechanism in design lets new flags be added without breaking existing profiles; unknown flags are ignored with a warning rather than an error.

**S3 navigation model**:
- Buckets list as root directories per profile/account
- Prefix-based navigation rendered as a virtual directory tree (delimiter `/`)
- Virtual directories (CommonPrefixes) shown as folders
- Real objects shown as files with size, last modified, storage class, ETag
- Users can switch between navigation/view modes per pane:
  - Details list: default table view optimized for S3 metadata, sorting, multi-select, and bulk operations
  - Icon/grid view: Finder-style icon browsing with thumbnails where previews are cheap
  - Gallery view: large preview-first browsing for images, video, PDFs, and documents
  - Column view: macOS Finder-style cascading navigation through bucket/prefix/object levels
  - Tree view: expandable virtual folder hierarchy for scanning nested prefixes
  - Flat key view: raw S3 object keys without virtual folder grouping, useful when prefixes are data conventions rather than folders
  - Dual-pane view: side-by-side locations for copy/move workflows across prefixes, buckets, profiles, or accounts
- View-mode switching exceptions for selection/location preservation:
  - Details, Icon/grid, Gallery, Tree: preserve both location and selection.
  - Flat key view: preserves location; virtual-folder selections collapse to the underlying object selections (folders are not selectable here).
  - Column view: preserves location; selection in a deeper column resets when its parent column changes.
  - Dual-pane view: each pane retains its own location and selection independently.
- Pagination handled transparently — infinite scroll backed by `list_objects_v2` continuation tokens
- Path bar shows a human-readable `profile://bucket/prefix/` display path; Copy Path produces a canonical percent-encoded URI that uses a stable internal profile ID to avoid collisions between duplicate profile display names

**File operations** (all implemented as Tauri commands, progress streamed via events):
- Upload: single file, multi-file, folder (recursive), drag-and-drop from OS
- Download: single file, multi-file selection, folder (recursive prefix download)
- Delete: single or multi-selection, with confirmation for >1 item or folders
- Copy: within bucket (server-side `copy_object`), cross-bucket, cross-account (download+upload fallback when cross-account only below the configured automatic fallback threshold; larger fallbacks require confirmation)
- Move: copy then delete source
- Rename: copy to new key, delete old key
- Create folder: PUT zero-byte object at `prefix/` key
- Generate presigned URL: configurable expiry, copied to clipboard
- Set object metadata / tags: custom key-value pairs
- Change storage class: `copy_object` with new StorageClass; runs through the diff preview/confirmation framework as the v1 trigger for that framework
- Multipart upload cleanup scanner: lists old multipart uploads for selected buckets and offers a guarded cleanup flow; uploads started by brows3r can be marked safe to abort, while unknown uploads require explicit user confirmation

**Bucket and object properties**:
- Bucket properties/settings can be viewed from an inspector panel, including region, versioning, encryption/KMS state, lifecycle rules, object lock, public access block, CORS, tags, replication, logging, website hosting, notifications, ownership controls, requester pays, and related S3 configuration surfaces supported by the active credentials
- Bucket policy is deferred from v1 and is not exposed as a viewer or editor surface in v1
- Object properties/settings can be viewed from the same inspector pattern, including key, size, content type, cache control, content disposition, content encoding, custom metadata, tags, storage class, server-side encryption/KMS state, object lock/legal hold/retention, version ID, ETag/checksum, last modified, and restore/archive status where applicable
- The v1 inspector is read-only by default; object metadata, object tags, storage class, and text object content are editable only through explicitly scoped file operations, not by making every inspector field inline-editable
- Encryption/KMS settings are read-only in v1 for both buckets and objects
- Properties that are read-only, unsupported for the selected resource, deferred from v1, or blocked by IAM permissions remain visible but disabled with subtle explanatory copy such as "Requires `s3:PutBucketVersioning`", "Deferred from v1", or "Not available for this storage class"
- Permission or capability gaps must feel intentional, not broken: use muted inline notices, disabled controls with reasons, and optional "learn more" details instead of error-looking banners unless an attempted save fails
- The properties inspector is not open by default, but it must be discoverable from selection details, context menus, toolbar actions, keyboard shortcuts, and a small visible affordance in the preview/details area

**File preview** (rendered in frontend, data fetched via Tauri):
- Text / code: syntax-highlighted via Shiki (loaded lazily per language)
- Images: JPEG, PNG, GIF, WEBP, SVG, BMP — rendered directly in WebView after streaming from S3
- Video: MP4, WebM, MOV — streamed via a local Tauri HTTP server on a random port with signed session-token URLs (avoids WebView memory limits)
- Audio: MP3, WAV, OGG, FLAC — same signed local server approach
- PDF: rendered via PDF.js
- Parquet / CSV / JSON / NDJSON: tabular preview via TanStack Table — first N rows fetched, parsed in a Web Worker
- Markdown: rendered via remark/rehype
- Archives (ZIP, TAR, GZ): list contents without full download using range requests where possible; full download required for extraction
- Unknown / binary: hex viewer with printable ASCII column
- Preview panel opens to the right (split view) or full-screen; keyboard navigable (arrow keys cycle through selection)

**Editing**:
- Text files: Monaco Editor embedded — edit in place, Save uploads the new version directly to S3 (content replaces object)
- JSON/YAML: Monaco with schema validation (user-provided schema URLs optional)
- Edits are staged locally in memory; Save uses an ETag precondition so the upload is rejected if the object changed since it was opened, then the user is shown a clear conflict message with refresh/retry choices

**Performance techniques**:
- Virtual list (TanStack Virtual) for all directory listings — renders only visible rows regardless of thousands of entries
- Directory listings, bucket properties, object metadata, thumbnails, and recently opened previews use longer-lived caches by default so browsing feels instant after first load
- Cache ownership: Rust is authoritative for S3 listings, bucket regions, bucket properties, object metadata, thumbnails, preview handles, and capability results; TanStack Query is only a short-lived frontend adapter cache for render state and duplicate request suppression
- Cached bucket/object data is shown only after the active credentials are validated for the profile; after validation, stale-while-revalidate behavior renders the last known state, refreshes in the background, and reconciles the UI when fresh S3 data arrives
- Capability results are discovered lazily by classifying API responses, then cached in Rust so repeated unsupported or denied operations become disabled UI with subtle reasons
- User-triggered mutations update visible cached state optimistically where safe, with rollback and a clear notification if the S3 operation fails
- Manual refresh via `R` or toolbar button bypasses stale cache for the current location and updates all visible metadata/properties
- Bucket regions are discovered in the background after bucket listing and cached by Rust for region-specific clients; operations can lazy-load a missing region if background discovery has not finished
- Parallel prefix fetches for large "folders" — Rust side fans out `list_objects_v2` pages concurrently using `tokio::spawn`
- Presigned URLs used for large file previews (images/video/audio) to avoid piping bytes through Tauri IPC
- Streaming downloads: Rust fetches via `get_object` body stream, writes to disk in chunks, emits progress events every 256 KB
- Streaming uploads: `put_object` for <5 MB, multipart upload for >=5 MB with per-part progress events
- Transfer queue: all uploads and downloads go through a Rust-side queue with configurable concurrency (default: 4 parallel transfers)
- Background prefetch of directory listings one level ahead (optional, off by default)

**Errors and progress**:
- All errors are captured and presented through a polished in-app notification system with severity, affected resource, operation name, timestamp, retry action when possible, and copyable technical details
- Background errors are shown only in the notifications area so passive work does not interrupt the user
- Errors caused by the current user interaction are shown in the notifications area and also surfaced inline or in a modal/toast-style message near the interaction so the failure is impossible to miss
- Any operation expected to take noticeable time uses determinate progress when possible, not only a spinner; unknown-duration operations show an indeterminate progress bar with contextual status text
- Progress UI can be minimized by the user, but minimized operations remain accessible from the notifications/transfer area with current state, cancel/retry controls, and final success/failure result
- Buckets, prefixes, and objects involved in a running operation are temporarily locked for conflicting actions; attempted edits, moves, deletes, or metadata changes are blocked with a clear warning explaining which operation is in progress
- Resource lock lifecycle is explicit: locks are released on operation success, failure, and cancellation; stale locks are cleared on app startup; and each lock auto-expires after a configurable TTL unless the owning operation heartbeats. A released lock makes previously blocked actions immediately available again.

**UI / UX**:
- Framework: React 18 + Vite + TypeScript
- Component library: shadcn/ui (Radix UI primitives) + Tailwind CSS
- Layout: three-pane — sidebar (profiles/bookmarks), main file list, preview/details panel
- Themes: system-default light/dark, with manual override
- Keyboard-first: full keyboard navigation for all operations is mandatory (arrow keys, Enter, Space, Delete, Cmd+C/X/V/Z, Cmd+A, quick view-mode switching, pane focus switching, search, refresh, upload/download, and command palette)
- Keyboard shortcuts are backed by a command registry, discoverable in menus/tooltips/command palette, configurable in settings, and follow platform conventions (`Cmd` on macOS, `Ctrl` on Windows/Linux)
- Baseline shortcut map: arrows move selection, Enter opens, Space previews, Backspace navigates up, Delete deletes, Cmd/Ctrl+C copies, Cmd/Ctrl+X moves, Cmd/Ctrl+V pastes, Cmd/Ctrl+A selects all, Cmd/Ctrl+F searches, Cmd/Ctrl+R refreshes, Cmd/Ctrl+Shift+P opens command palette, Cmd/Ctrl+1-7 switches view modes, Cmd/Ctrl+Option/Alt+Left/Right switches panes
- Drag-and-drop: between panes (S3 to S3 move/copy), from OS (upload), to OS (download to drag target — requires Tauri drag-out API)
- Breadcrumb path bar with click-to-navigate segments
- Multi-select: Shift+click range, Cmd/Ctrl+click individual
- Search: two modes in v1 — current-location local filter over the cached listing, and bucket-wide prefix search backed by paginated `list_objects_v2`; global substring search is not a v1 feature
- Inspector/details affordance: collapsed by default, but clearly available for viewing bucket/object properties and reaching explicitly scoped edit operations without making the main browser feel like a settings screen
- High-impact property changes use a diff preview and confirmation before save. In v1 this is wired to storage class changes; lifecycle, public access block, object lock, website hosting, and replication adopt the same framework when they become editable post-v1
- Bookmarks: save any path as a named bookmark
- Recent locations: auto-tracked, shown in sidebar
- File icons: `vscode-icons` or similar icon set mapped by extension
- Transfer manager panel: shows active and completed transfers with progress bars, cancel/retry
- Notifications: in-app notifications area for errors, warnings, background work, and completed operations; OS-level notification on transfer completion via `tauri-plugin-notification`
- Diagnostics: user-triggered log/exception collection with exportable diagnostic bundles; no automatic telemetry or background sending

**Settings** (with v1 defaults):
- Default download directory (default: OS Downloads folder)
- Transfer concurrency (default: 4 parallel transfers)
- Cache TTL (default: 5 minutes) and maximum cache size (default: 256 MB), with options to clear cache and force refresh current location
- Preview file size limit (default: 50 MB — warn/skip for larger)
- Keyboard shortcut bindings and conflict resolution (default: baseline shortcut map above)
- Default view mode per scope (global, profile, bucket) (default: Details)
- Notification behavior and whether completed background transfers trigger OS notifications (default: in-app on, OS notifications on for completed transfers)
- Cross-account download+upload fallback threshold (default: 100 MB; objects up to this size auto-fallback, larger require confirmation)
- Transfer confirmation thresholds for large, cross-account, or potentially billable operations (default: confirm for >1 GB total, >100 objects, or any cross-account operation)
- S3-compatible endpoint URL, region behavior, and provider compatibility flags per profile (default flags per Provider compatibility flags section)
- Auto-update channel (default: stable) and update check behavior (default: every 24h)
- Diagnostics/log collection controls and export location (default: collection off; local log retention 7 days; export to user-chosen file)
- List view memory budget for large listings (default: 250 MB for a 10k-row view on the documented baseline)
- Resource lock TTL (default: 5 minutes; heartbeated by the owning operation)
- Startup behavior (default: reopen last session)
- Proxy settings (default: system proxy)

### Tech stack summary

| Layer | Choice |
|---|---|
| App shell | Tauri 2.x |
| Rust edition | 2021 |
| S3 SDK | `aws-sdk-s3` (official AWS SDK for Rust) |
| Frontend framework | React 18 + Vite 5 |
| Language | TypeScript 5.x (strict) |
| UI components | shadcn/ui + Tailwind CSS v4 |
| Table/list virtualization | TanStack Virtual + TanStack Table |
| Code editor | Monaco Editor |
| Syntax highlighting | Shiki |
| PDF preview | PDF.js |
| Auto-update | Tauri updater |
| Linting | Biome |
| Package manager | pnpm |
| Testing (frontend) | Vitest + Testing Library |
| Testing (Rust) | cargo test (unit) + integration tests against LocalStack |
| State management | Zustand |
| Data fetching / cache | Rust authoritative cache + TanStack Query short-lived Tauri adapter |

## Non-goals

- Web app or Electron version (Tauri is the target; Electron is explicitly avoided for performance and bundle size)
- Inline AssumeRole + MFA UI in v1; v1 relies on AWS profile/config role chaining
- Bucket policy editor or viewer in v1
- KMS/encryption mutation in v1 — encryption state is visible but read-only
- Object version listing, restore, and delete-marker workflows in v1; versioning configuration and object version ID may be visible as read-only properties
- Automatic telemetry, crash reporting, or background log upload
- Real-time collaborative editing
- Offline mode beyond the session cache
- CloudFront / S3 static site management
- CLI companion tool

## Acceptance Criteria

### AC-1: Credential management
- Given a machine with `~/.aws/credentials` containing named profiles, when the app opens, then all profiles are listed without manual entry.
- Given a user enters access key + secret manually, when they save, then the credential is stored in the OS keychain and survives app restart.
- Given a user configures a profile with the v1 baseline provider compatibility flags (endpoint URL, addressing style, signature version, checksum mode, TLS, expect-continue, chunked upload, bucket-name validation, region override) for an S3-compatible provider, when they validate the profile, then the app connects to that endpoint using the configured flags without applying AWS-only bucket assumptions.
- Given a profile is selected and credentials are expired/invalid, when the user navigates, then an actionable error is shown with a "Re-authenticate" prompt.
- Given a profile uses role chaining configured in `~/.aws/config`, when the app validates the profile, then it uses the AWS SDK credential provider chain without requiring an inline MFA UI.

### AC-2: Bucket navigation
- Given a valid credential profile is connected on a 2020+ Mac with broadband latency below 100 ms to AWS, when the user opens it, then all accessible bucket names are visible within 3 seconds or a progress state is shown.
- Given the user clicks a bucket, when the prefix listing loads, then objects and virtual directories are rendered correctly using `/` as delimiter.
- Given a prefix contains >1000 objects, when the user scrolls through the list, then additional pages load automatically and the visible list does not fully re-render or lose scroll position.
- Given bucket listing completes, when background region discovery runs, then each bucket region is cached in Rust and region-specific operations use the cached region or lazy-load it if missing.
- Given two profiles have the same display name, when the user copies the path for a selected object, then the copied URI uses the stable internal profile ID and percent-encoded bucket/key components.

### AC-3: Navigation/view modes
- Given a bucket or prefix is open, when the user switches between Details, Icon/grid, Gallery, and Tree modes, then both location and selection are preserved.
- Given Flat key view is entered, when virtual-folder selections existed in the previous mode, then location is preserved and the selection collapses to the underlying object selections (no folder selections in this mode).
- Given Column view is entered or its parent column changes, then location is preserved and the deeper-column selection resets.
- Given Dual-pane view is entered or exited, then each pane retains its own independent location and selection.
- Given the user chooses a default view mode in settings, when a new compatible location opens, then that view mode is used unless the bucket/profile has an override.
- Given Flat key view is active, when a prefix contains nested keys, then raw object keys are shown without virtual folder grouping.
- Given Dual-pane view is active, when two locations are open, then copy/move operations clearly show source and destination profile/bucket/prefix before starting.

### AC-4: File operations
- Given a user selects one or more files and clicks Delete, when they confirm, then the objects are deleted and the listing refreshes.
- Given a user drags a local file onto the file list panel, when the drop occurs, then an upload is initiated and visible in the transfer manager.
- Given a user copies a file within the same bucket, when the copy completes, then the destination key exists and the source key is unchanged (verified by listing).
- Given a user moves a file, when the move completes, then the destination key exists and the source key no longer exists.
- Given a multipart upload is in progress and the user cancels it, then the multipart upload is aborted on S3 (no incomplete parts left billable).
- Given the app detects old multipart uploads through the cleanup scanner, when the user confirms cleanup, then selected uploads are aborted and the result is recorded in notifications.
- Given cross-account server-side copy fails and the object is below the default 100 MB fallback threshold, when fallback is allowed, then the app switches to download+upload and shows progress plus a notification.
- Given cross-account server-side copy fails and the object is above the default 100 MB fallback threshold, when fallback would require download+upload, then the user must explicitly confirm before transfer starts.
- Given a bucket, prefix, or object is involved in a running operation, when the user attempts a conflicting operation, then the action is blocked with a clear warning naming the running operation.
- Given a running operation completes, fails, or is cancelled, when the user retries a previously blocked action on the same resource, then the lock is released and the action proceeds.
- Given the app starts after a crash with stale locks recorded, when the user opens any affected location, then the stale locks are cleared at startup and no false "operation in progress" warnings are shown.
- Given an operation holding a lock stops heartbeating, when the configured lock TTL expires, then the lock auto-expires and a notification is recorded so the user can retry or investigate.

### AC-5: Bucket and object properties
- Given a bucket is selected, when the inspector opens, then supported bucket properties are shown read-only, bucket policy is absent/deferred from v1, and encryption/KMS mutation is clearly marked read-only.
- Given an object is selected, when the inspector opens, then object metadata, tags, storage class, encryption state, version ID, ETag/checksum, and restore/archive status are shown where available.
- Given a property is blocked by IAM permissions or unsupported for the selected resource, when the inspector renders it, then the control remains visible but disabled with muted explanatory copy.
- Given an inspector operation receives `AccessDenied` or an unsupported-feature response, when the error is classified, then Rust caches that capability result and future UI renders the disabled reason without presenting it as a bug.
- Given a user changes the storage class of one or more selected objects, when they confirm, then a diff preview shows the prior and new storage class for each affected object and the change only proceeds after explicit confirmation.

### AC-6: File preview
- Given the user selects an image file under the preview size limit, when the preview panel opens, then the image is visible within 2 seconds.
- Given the user selects a text/code file, when the preview opens, then syntax highlighting is applied matching the file extension.
- Given the user selects a CSV file with ≤10 MB, when the preview opens, then a scrollable table with correct column headers and row data is shown.
- Given the user selects a video file, when the preview opens, then the video is streamable through a signed session-token local URL and playback controls are functional.
- Given a signed local media URL expires or the session ends, when the URL is reused, then the local server rejects the request.
- Given the user selects a file over the default 50 MB preview size limit, then a warning is shown with an option to download instead.

### AC-7: Editing
- Given the user opens a text file in the editor, makes changes, and clicks Save, then the object on S3 is updated with an ETag precondition and the cached listing reflects the new ETag/size.
- Given the object changed on S3 after the user opened it, when they click Save, then the save is rejected and the user is shown a conflict message with refresh/retry choices.
- Given the user opens a file and closes the editor without saving, then no change is made to S3.

### AC-8: Performance and cache
- Given a profile has been validated and a directory with 500 objects is already cached in Rust, when the user opens it within the default 5-minute cache TTL, then the listing renders within 200 ms without blocking on the network.
- Given a profile has not been validated in the current session, when cached data exists for that profile, then bucket/object cache contents are not displayed until credential validation succeeds.
- Given cached data is displayed, when background revalidation returns fresher S3 data, then the UI reconciles additions, updates, and removals without losing selection or scroll position.
- Given a list view contains 10,000 mocked entries on a 2020+ Mac baseline, when the user scrolls continuously for 10 seconds in a lab benchmark, then the app maintains 55+ fps p95 and does not exceed the default 250 MB list view memory budget.

### AC-9: Errors, notifications, and progress
- Given a background operation fails, when the user is not directly interacting with it, then the error appears only in the in-app notifications area with operation name, resource, timestamp, retry action when possible, and copyable details.
- Given the current user interaction fails, when the error occurs, then the error appears both in the notifications area and inline or in a modal/toast near the interaction.
- Given an operation can report bytes, object counts, or pages, when it runs longer than a brief threshold, then a determinate progress bar is shown instead of only a spinner.
- Given the user minimizes an active progress UI, when the operation continues, then it remains accessible from the notifications/transfer area with cancel/retry where applicable.

### AC-10: Search, bookmarks, and recents
- Given a current-location local filter is active, when the user types a query, then results filter from the cached listing without issuing S3 requests.
- Given bucket-wide prefix search is active, when the user types a prefix query, then results are fetched via paginated `list_objects_v2` and can be canceled.
- Given a user bookmarks a location, when the app restarts, then the bookmark is available in the sidebar.
- Given the user navigates to locations, when the recent list is opened, then recent profile/bucket/prefix locations are shown without exposing data from unvalidated profiles.

### AC-11: Settings and shortcuts
- Given the user opens settings, then download directory, transfer concurrency, cache TTL, max cache size, preview limit, shortcut bindings, default view mode, notifications, fallback threshold, transfer confirmations, S3-compatible endpoint settings, auto-update behavior, diagnostics controls, startup behavior, and proxy settings are configurable.
- Given a shortcut conflict is created, when the user saves settings, then the conflict is shown and the user must resolve or intentionally override it.
- Given the command palette opens, when the user searches for a command, then the command registry shows available actions and their current shortcuts.

### AC-12: Auto-update and diagnostics
- Given auto-update is enabled, when a signed update is available, then the user is clearly prompted to install it.
- Given update checking fails, when the app is otherwise usable, then the failure is shown in notifications without blocking browsing.
- Given an error occurs, when the user chooses to collect diagnostics, then the app creates an exportable bundle containing relevant local logs, exception details, app version, OS version, and redacted runtime metadata.
- Given diagnostics are collected, when the bundle is ready, then the user decides where to save it or whether to send it manually; the app never uploads logs, exceptions, or telemetry automatically.

### AC-13: Multi-account
- Given two credential profiles are connected, when the user has both open in split panes, then operations on each are independent (no credential bleed).
- Given the user performs a cross-account copy, when S3 ACLs would block server-side copy, then the app follows the default 100 MB download+upload fallback threshold, notifies the user, and asks for confirmation when required.

### AC-14: Transfer manager
- Given a download is in progress, when the user checks the transfer manager, then a progress bar with percentage and speed (MB/s) is visible.
- Given a transfer fails, when the user clicks Retry in the transfer manager, then the transfer restarts from the beginning (not resumable in v1).

## Implementation task outline

### Phase 1 — Scaffold and credential management (Week 1-2)
1. Initialize Tauri 2 project: `pnpm create tauri-app` with React + TypeScript + Vite template
2. Set up Biome, Tailwind CSS v4, shadcn/ui
3. Set up Zustand store and TanStack Query with Tauri invoke adapter
4. Implement Rust: authoritative cache service interface and frontend adapter boundary
5. Implement Rust: parse `~/.aws/credentials` and `~/.aws/config`, including AWS profile role chaining
6. Implement Rust: S3-compatible endpoint configuration with the v1 baseline provider compatibility flag set (endpoint URL, region override, addressing style, signature version, checksum mode, TLS self-signed acceptance, expect-continue, chunked upload, bucket-name validation) and a documented extension mechanism for future flags
7. Implement Rust: credential validation via `sts:GetCallerIdentity` for AWS and provider-appropriate validation for compatible endpoints
8. Implement Rust: OS keychain store/retrieve via `keyring` crate
9. Implement frontend: Credential Manager UI (list, add, edit, delete profiles, endpoint settings)
10. Implement frontend: command registry foundation and baseline shortcut map
11. Implement frontend: notification/error foundation used by all later operations
12. Write unit tests: credential parsing, keychain round-trip, endpoint settings, command registry conflicts, notification rendering

### Phase 2 — S3 navigation (Week 3-4)
1. Implement Rust: `list_buckets`, `list_objects_v2` with pagination, parallel page fetching
2. Implement Rust: background bucket-region discovery and cached per-bucket client lookup
3. Implement Rust: permission-aware listing cache with TTL, stale-while-revalidate, validation-before-display, and invalidation on mutation
4. Implement Rust: canonical path encoder using stable internal profile IDs
5. Implement frontend: three-pane layout (sidebar, file list, preview placeholder)
6. Implement frontend: bucket list rendering, virtual directory tree navigation, and breadcrumb path bar
7. Implement frontend: all navigation/view modes — Details, Icon/grid, Gallery, Column, Tree, Flat key, and Dual-pane
8. Implement frontend: TanStack Virtual list for large file entries
9. Implement frontend: keyboard navigation and command-driven view switching
10. Write tests: list rendering with 1000+ mocked entries, pagination trigger, view-mode switching, flat key rendering, canonical URI copying

### Phase 3 — File operations (Week 5-6)
1. Implement Rust: `delete_objects` (batch), `copy_object`, multipart upload, `get_object` streaming download
2. Implement Rust: transfer queue with tokio concurrency, progress event emission, and resource locks with full lifecycle (acquire, heartbeat, release on success/failure/cancellation, TTL auto-expire, startup cleanup of stale locks)
3. Implement Rust: cross-account fallback threshold logic and confirmation requirement for large download+upload fallback
4. Implement Rust: multipart upload cleanup scanner for old uploads
5. Implement Rust: presigned URL generation
6. Implement frontend: Transfer Manager panel (active, completed, failed, minimized progress)
7. Implement frontend: drag-and-drop upload (from OS) and move/copy (S3-to-S3)
8. Implement frontend: multi-select with Shift+click and Cmd/Ctrl+click
9. Implement frontend: context menu and command-registry actions for all file operations
10. Implement frontend: resource-lock warnings for conflicting actions
11. Write integration tests against LocalStack: upload, download, copy, move, delete, fallback threshold behavior, multipart cleanup scanner, resource lock lifecycle (release on terminal states, TTL expiry, startup cleanup)

### Phase 4 — File preview (Week 7-8)
1. Implement Rust: local HTTP server for streaming media (random port, session-scoped, signed session-token URLs)
2. Implement frontend: preview panel split view with resizable divider
3. Implement frontend: image preview
4. Implement frontend: text/code preview with Shiki (lazy language loading)
5. Implement frontend: Monaco Editor integration for editable text files with ETag precondition save conflicts
6. Implement frontend: read-only properties inspector for buckets and objects, including disabled/deferred explanations
7. Implement Rust: lazy capability classification cache for denied or unsupported inspector/API operations
8. Implement frontend: CSV/JSON tabular preview with TanStack Table in Web Worker
9. Implement frontend: PDF preview via PDF.js
10. Implement frontend: video/audio streaming preview via signed local server URLs
11. Implement frontend: Markdown preview via remark/rehype
12. Implement frontend: hex viewer for unknown binary
13. Write tests: preview renders correct content for each file type with mocked data, media token rejects expired URLs, inspector disabled states, ETag conflict handling

### Phase 5 — Polish and settings (Week 9-10)
1. Implement settings screen: download dir, concurrency, cache TTL, max cache size, preview size limit, shortcut bindings, default view mode, notification behavior, fallback threshold, transfer confirmations, S3-compatible endpoints, auto-update behavior, diagnostics controls, startup behavior, and proxy settings
2. Implement bookmarks and recent locations with validation-before-display behavior
3. Implement search: current-location local filter and bucket-wide prefix search with cancellation
4. Implement OS notifications on transfer completion according to notification settings
5. Implement light/dark theme with system default detection
6. Implement high-impact property edit confirmation/diff framework for future mutable bucket settings
7. Accessibility pass: ARIA labels, focus management, keyboard-only walkthrough, command palette usability
8. App icon, window chrome, native menus (File, Edit, View, Go, Help)
9. Implement Tauri updater integration with signed release artifacts and user-facing update prompts
10. Implement user-triggered diagnostics collection/export with redaction for credentials, tokens, bucket secrets, and local paths where appropriate
11. Build pipeline: GitHub Actions for macOS universal binary, Linux AppImage/deb, Windows NSIS installer, and signed updater artifacts
12. Performance profiling: flame graph of listing render, transfer throughput benchmarks under documented lab conditions
13. End-to-end smoke test suite against LocalStack and at least one S3-compatible provider target in CI or documented manual sandbox testing

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| AWS credential leakage via frontend JS context | Low if architecture followed | All AWS calls are Rust-only Tauri commands; credentials never cross IPC boundary |
| S3-compatible providers diverge from AWS S3 behavior | High | Add provider compatibility settings, test against LocalStack and at least one compatible provider target, and show provider-specific unsupported capability reasons |
| WebView video streaming performance on Windows | Medium | Local HTTP server approach avoids large IPC payloads; test early on Windows |
| Local media URL exposure to other local processes | Medium | Bind the server to loopback only, require signed session-token URLs, expire tokens with the app session, and reject stale URLs |
| Monaco Editor bundle size (~2 MB gzip) | Medium | Lazy-load Monaco only when editing; use Shiki for read-only preview |
| S3 API rate limiting on large buckets with many parallel requests | Medium | Configurable concurrency cap; exponential backoff with jitter on 503/429 |
| Background bucket-region discovery adds API cost/latency | Medium | Run discovery after bucket names render, cache regions in Rust, cap concurrency, and lazy-load missing regions only when needed |
| Stale capability cache hides actions after IAM changes | Medium | Store capability results with TTL, allow manual refresh to clear capability state, and retry on explicit user action |
| Cached data exposure after profile/account changes | Low | Validate active credentials before displaying cached bucket/object data and keep cache keys scoped by stable profile ID/account identity |
| Cross-account copy blocked by bucket policy | Medium | Detect `AccessDenied` on `copy_object`, fall back to download+upload only below the configured threshold, and require confirmation for larger objects |
| Cross-account download+upload fallback surprises users with cost or data movement | Medium | Show source/destination, size, account IDs where available, progress, and threshold-based confirmation before large fallback transfers |
| Multipart upload cleanup scanner aborts uploads not created by brows3r | Medium | Clearly separate brows3r-started uploads from unknown uploads and require explicit confirmation for unknown cleanup |
| Destructive or high-impact property edits cause broad S3 behavior changes | Medium | Keep v1 inspector read-only for bucket settings, require diff preview/confirmation for future high-impact edits, and show permission/capability reasons subtly |
| Rust and frontend cache divergence | Medium | Treat Rust as authoritative, keep TanStack Query short-lived, reconcile through Tauri events after mutations and revalidation |
| Auto-update supply-chain compromise | Low | Require signed update artifacts, verify signatures through Tauri updater, and provide clear update provenance in the UI |
| Diagnostic bundles leak secrets or sensitive paths | Medium | Redact credentials, tokens, presigned URLs, account IDs where appropriate, and local file paths before export; require explicit user action to save or send bundles |
| LocalStack parity gaps in integration tests | Low | Pin LocalStack version; document known gaps; supplement with AWS sandbox tests manually |
