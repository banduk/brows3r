# Design - s3-native-browser

## Context

This is a greenfield Tauri 2.x desktop app. The approved proposal locks in a
React + Vite + TS + shadcn/ui frontend driven by a Rust backend that owns all
AWS S3 SDK calls, credential handling, the authoritative cache, the transfer
queue, the resource-lock registry, and a loopback HTTP server for streaming
media previews. Every architectural choice in this design serves three load-
bearing constraints from the proposal:

1. **AWS credentials never cross the IPC boundary.** All `aws-sdk-s3` calls
   live in Rust; the WebView only sees opaque request IDs, listing payloads,
   and progress events.
2. **Rust is the authoritative cache.** TanStack Query on the frontend is a
   short-lived adapter for render-state and request deduping; it never
   contradicts Rust state.
3. **Capability gaps feel intentional.** Permission, unsupported-feature, and
   storage-class errors are classified, cached in Rust, and surfaced to the UI
   as disabled controls with subtle reasons — not as red banners.

The proposal is approved with zero findings. Two implementation-time watch
items from round-3 review are folded in here:

- The diff-preview/confirmation framework (v1 trigger: storage class) gets a
  documented "cancel from diff preview" path with a derived test case.
- View-mode switching `*-to-Column` adopts the same "location preserved,
  deeper-column selection resets" rule as `Column→Column` parent change, with
  a derived test case.

## Goals And Non-Goals

### Goals

- Bootstrap a Tauri 2.x app whose Rust backend exposes a stable, typed command
  surface for every v1 file/bucket/object operation in the proposal.
- Implement the v1 navigation/view modes, file operations, previews, editing,
  inspector, transfer manager, settings, search, bookmarks, command registry,
  notifications, auto-update, and user-controlled diagnostics.
- Ship cross-platform binaries (macOS universal, Linux AppImage/deb, Windows
  NSIS) with a signed Tauri updater channel.
- Maintain conventional commits and a green CI on every commit. Each task in
  `tasks.md` is exactly one shippable commit and leaves the tree green.

### Non-Goals (carried verbatim from proposal)

- Web/Electron version.
- Inline AssumeRole + MFA UI in v1.
- Bucket policy viewer/editor in v1.
- KMS/encryption mutation in v1.
- Object version listing/restore/delete-marker workflows in v1.
- Automatic telemetry/crash reporting/log upload.
- Real-time collaborative editing.
- Offline mode beyond the session cache.
- CloudFront / S3 static-site management.
- CLI companion tool.

## Architecture Decision

Single-process Tauri app with a hard split between the Rust core and the
WebView SPA. All AWS interaction is Rust-only. The WebView talks to Rust
exclusively via `invoke` (request/response) and `listen` (server-pushed
events for progress, cache invalidation, lock changes, and transfer state).

```
+--------------------- Tauri Process ---------------------+
|                                                         |
|  WebView (React + Vite + TS, shadcn/ui, Tailwind v4)    |
|  - Zustand UI state                                     |
|  - TanStack Query adapter (short-lived render cache)    |
|  - TanStack Virtual / TanStack Table                    |
|  - Monaco (lazy), Shiki (lazy per language), PDF.js     |
|        |  invoke(cmd, payload) / listen(event)          |
|        v                                                |
|  Tauri command router (Rust)                            |
|        |                                                |
|        v                                                |
|  Core services (Rust)                                   |
|   - profile_manager  - cache (authoritative SWR)        |
|   - s3_client_pool   - transfer_queue (tokio)           |
|   - capability_cache - resource_locks (TTL+heartbeat)   |
|   - notifications    - command_registry (server side)   |
|   - keychain (keyring)  - settings (json)               |
|   - cache store (redb)  - multipart bookkeeping (redb)  |
|   - media_server (loopback, signed session tokens)      |
|        |                                                |
|        v                                                |
|  aws-sdk-s3 (per-profile, per-region clients)           |
|        |                                                |
+--------|------------------------------------------------+
         v
   AWS S3 / S3-compatible (MinIO, R2, Wasabi, LocalStack)
```

### Why this shape

- **Rust owns IO and policy.** Cache TTL, resource locks, capability
  classification, transfer concurrency, and credential resolution are policy
  decisions that must be deterministic across reloads and multiple panes;
  putting them in Rust keeps a single source of truth.
- **WebView is a renderer.** The frontend issues commands and reacts to
  events. It never re-derives S3 truth from optimistic state alone.
- **Loopback media server.** WebView memory limits and IPC payload size make
  in-band streaming of MP4/MOV/large audio infeasible; a loopback HTTP server
  with signed, session-scoped tokens is the proposal's chosen mitigation.
- **Per-profile, per-region clients.** Each `(profile_id, region)` tuple maps
  to a long-lived `aws-sdk-s3::Client` instance; this is the cleanest way to
  avoid region redirects and to apply per-profile compatibility flags.

## Alternatives Considered

- **Electron** — explicitly rejected by the proposal (bundle size, perf).
- **All-AWS-SDK in JS via Tauri-passthrough** — rejected: would expose
  credentials to JS context, violating the security goal.
- **`tauri-plugin-stronghold` for credential storage** — rejected for v1 by
  the proposal in favour of `keyring`; revisit only if a cross-process
  encrypted vault becomes a requirement.
- **TanStack Query as authoritative cache** — rejected: SWR semantics across
  multi-pane panes and lock-aware invalidation belong in Rust.
- **Single global S3 client with dynamic credential injection** — rejected:
  region redirects, per-profile compatibility flags, and concurrent multi-
  account work make per-(profile,region) clients simpler and safer.
- **In-band IPC streaming for media preview** — rejected for memory and CPU
  reasons; loopback HTTP server with signed tokens chosen instead.

## Module Layout

### Workspace root

```
brows3r/
├── .github/workflows/        # ci.yml, release.yml
├── .crafter/                 # planning artifacts (existing)
├── docs/                     # arch notes, ADRs, screenshots
├── scripts/                  # dev helpers (localstack up, fmt, etc.)
├── src/                      # frontend (Vite root)
├── src-tauri/                # Rust backend (Cargo workspace member)
├── lefthook.yml              # git hooks
├── biome.json                # frontend lint/format
├── commitlint.config.cjs     # conventional commit enforcement
├── pnpm-workspace.yaml
├── package.json              # frontend scripts
├── tsconfig.json
├── vite.config.ts
├── tailwind.config.ts (v4 css-first; small ts shim)
├── README.md
├── LICENSE                   # MIT
└── CHANGELOG.md              # Keep a Changelog format
```

### `src-tauri/` (Rust)

```
src-tauri/
├── Cargo.toml                # workspace = false; binary crate
├── tauri.conf.json
├── build.rs
├── icons/
└── src/
    ├── main.rs               # tauri::Builder wiring
    ├── lib.rs                # re-exports for tests
    ├── error.rs              # AppError + IntoResponse for IPC
    ├── ids.rs                # ProfileId, BucketId, ObjectKey newtypes
    ├── settings/
    │   ├── mod.rs            # typed Settings struct + load/save
    │   └── defaults.rs       # v1 defaults (single source of truth)
    ├── profiles/
    │   ├── mod.rs            # Profile, ProfileStore
    │   ├── aws_config.rs     # ~/.aws/credentials + ~/.aws/config parser
    │   ├── compat_flags.rs   # provider compatibility flag schema + apply
    │   ├── keychain.rs       # keyring crate wrapper
    │   └── validation.rs     # sts:GetCallerIdentity, provider probes
    ├── s3/
    │   ├── mod.rs            # ClientPool, region discovery
    │   ├── client.rs         # build aws-sdk-s3 Client from Profile+Region
    │   ├── list.rs           # list_buckets, list_objects_v2 (paged, fanout)
    │   ├── object.rs         # head, get (stream), put, copy, delete
    │   ├── multipart.rs      # multipart upload + scanner
    │   ├── presign.rs
    │   ├── tags.rs
    │   ├── metadata.rs
    │   └── inspector.rs      # bucket/object property fetchers (read-only)
    ├── cache/
    │   ├── mod.rs            # CacheKey, CacheEntry<T>, TTL, SWR
    │   ├── store.rs          # in-memory + disk-backed (redb) for listings
    │   ├── invalidation.rs   # mutation hooks
    │   └── capability.rs     # classified denied/unsupported results
    ├── transfers/
    │   ├── mod.rs            # TransferQueue, Transfer, TransferState
    │   ├── upload.rs         # single + multipart with progress
    │   ├── download.rs       # streaming get + chunked write
    │   └── progress.rs       # progress event emission helper
    ├── locks/
    │   ├── mod.rs            # ResourceLock, LockRegistry
    │   └── lifecycle.rs      # heartbeat, TTL expiry, startup cleanup
    ├── notifications/
    │   ├── mod.rs            # in-app notification log
    │   └── os.rs             # tauri-plugin-notification bridge
    ├── media_server/
    │   ├── mod.rs            # axum-on-loopback bound to 127.0.0.1:0
    │   └── tokens.rs         # signed session-scoped tokens
    ├── path/
    │   ├── mod.rs            # display path vs canonical URI
    │   └── encode.rs         # percent-encoding + stable profile_id slug
    ├── search/
    │   ├── mod.rs            # current-location filter, prefix search
    │   └── cancel.rs         # cancellation tokens
    ├── diagnostics/
    │   ├── mod.rs            # log collector + redaction
    │   └── bundle.rs         # zip exporter
    ├── updater/
    │   └── mod.rs            # tauri-updater wiring
    └── commands/             # one file per command surface (Tauri commands)
        ├── mod.rs            # register_invoke_handler
        ├── profiles_cmd.rs
        ├── buckets_cmd.rs
        ├── objects_cmd.rs
        ├── transfers_cmd.rs
        ├── inspector_cmd.rs
        ├── locks_cmd.rs
        ├── search_cmd.rs
        ├── settings_cmd.rs
        ├── media_cmd.rs
        ├── notifications_cmd.rs
        ├── diagnostics_cmd.rs
        └── updater_cmd.rs
```

Tests live alongside modules as `#[cfg(test)] mod tests` for unit tests, plus
`src-tauri/tests/` for integration tests against LocalStack.

### `src/` (React frontend)

```
src/
├── main.tsx                  # mounts <App/>
├── App.tsx                   # router + layout shell
├── index.css                 # Tailwind v4 entrypoint
├── lib/
│   ├── tauri.ts              # typed invoke<T>() and listen<T>() wrappers
│   ├── ids.ts                # branded types for ProfileId etc.
│   ├── errors.ts             # mapping AppError -> UI presentation
│   └── format.ts             # bytes, dates, relative time
├── api/                      # one file per backend domain — wraps invoke
│   ├── profiles.ts
│   ├── buckets.ts
│   ├── objects.ts
│   ├── transfers.ts
│   ├── inspector.ts
│   ├── locks.ts
│   ├── search.ts
│   ├── settings.ts
│   ├── media.ts
│   ├── notifications.ts
│   ├── diagnostics.ts
│   └── updater.ts
├── store/                    # Zustand slices
│   ├── ui.ts                 # active pane, view mode, selection
│   ├── panes.ts              # multi-pane (incl. dual-pane) state
│   ├── transfers.ts          # mirrors backend transfer events
│   ├── notifications.ts
│   ├── locks.ts              # mirrors backend lock events
│   ├── settings.ts           # mirrors persisted settings
│   └── command_palette.ts
├── query/
│   ├── client.ts             # TanStack Query client + Tauri adapter
│   ├── keys.ts               # canonical query keys
│   └── hooks/                # useBuckets, useObjects, useInspector, ...
├── commands/
│   ├── registry.ts           # CommandDef registry, lookup, palette source
│   ├── shortcuts.ts          # baseline map + conflict resolver
│   └── definitions/          # one file per command group
├── views/
│   ├── shell/                # three-pane layout, sidebar, statusbar
│   ├── sidebar/              # profiles, bookmarks, recents
│   ├── browser/              # main pane: shared chrome + breadcrumb + path
│   ├── modes/                # one file per view mode
│   │   ├── DetailsView.tsx
│   │   ├── IconGridView.tsx
│   │   ├── GalleryView.tsx
│   │   ├── ColumnView.tsx
│   │   ├── TreeView.tsx
│   │   ├── FlatKeyView.tsx
│   │   └── DualPaneView.tsx
│   ├── inspector/            # bucket + object inspector panels
│   ├── preview/              # preview pane router and renderers
│   │   ├── ImagePreview.tsx
│   │   ├── TextPreview.tsx       # Shiki
│   │   ├── EditorPreview.tsx     # Monaco (lazy)
│   │   ├── MediaPreview.tsx      # video/audio via media_server
│   │   ├── PdfPreview.tsx
│   │   ├── TablePreview.tsx      # CSV/JSON/NDJSON/Parquet via worker
│   │   ├── MarkdownPreview.tsx
│   │   ├── HexPreview.tsx
│   │   └── ArchivePreview.tsx
│   ├── transfers/            # transfer manager panel
│   ├── notifications/        # notifications panel + toasts
│   ├── settings/             # settings screen
│   ├── search/               # search box + results
│   └── diff/                 # high-impact edit diff/confirm framework
├── workers/                  # Web Workers
│   ├── csv.worker.ts
│   ├── json.worker.ts
│   └── parquet.worker.ts     # uses parquet-wasm (lazy)
└── test/                     # Vitest setup + helpers
    ├── setup.ts
    └── mocks/                # tauri invoke/listen mocks
```

## Tauri Command Surface

Every command returns `Result<T, AppError>`. Commands that emit progress also
emit one or more `Event`s and return a stable `request_id` so the frontend can
correlate. Payloads use `serde::{Serialize, Deserialize}` with camelCase
renaming so TS types are mechanical.

### Profiles

| Command | Input | Output | Notes |
|---|---|---|---|
| `profiles_list` | — | `Vec<ProfileSummary>` | union of `~/.aws/credentials`, `~/.aws/config`, and keychain-stored manual profiles |
| `profile_get` | `{ profileId }` | `ProfileDetail` | non-secret fields only |
| `profile_create_manual` | `{ name, accessKeyId, secretAccessKey, sessionToken?, compatFlags }` | `ProfileSummary` | secret persisted via `keyring` |
| `profile_update` | `{ profileId, patch }` | `ProfileSummary` | name + compat flags only |
| `profile_delete` | `{ profileId }` | `()` | also removes keychain entry |
| `profile_validate` | `{ profileId }` | `ValidationReport` | `sts:GetCallerIdentity` for AWS, list-bucket probe for compat providers |
| `profile_set_active_for_pane` | `{ paneId, profileId }` | `()` | does not validate; uses last validation status |

### Buckets / Objects

| Command | Input | Output | Notes |
|---|---|---|---|
| `buckets_list` | `{ profileId, force? }` | `Vec<BucketSummary>` | SWR; emits `buckets:updated` after revalidate |
| `bucket_region_get` | `{ profileId, bucket }` | `Region` | served from cache; lazy-resolved if missing |
| `objects_list` | `{ profileId, bucket, prefix, continuationToken?, force? }` | `ListPage` | `delimiter="/"`; backend fans out parallel pages internally for large prefixes |
| `objects_list_flat` | `{ profileId, bucket, prefix, continuationToken? }` | `ListPage` | for flat-key view; no `CommonPrefixes` |
| `object_head` | `{ profileId, bucket, key, versionId? }` | `ObjectHead` | feeds inspector + preview gating |
| `object_get_text` | `{ profileId, bucket, key, maxBytes }` | `TextPayload` | inline text/JSON/CSV body for editor + small preview |
| `object_put_text` | `{ profileId, bucket, key, body, ifMatchEtag }` | `PutResult` | ETag precondition; surfaces 412 as conflict |
| `object_copy` | `{ source, destination, options }` | `requestId` | server-side copy; falls back per threshold |
| `object_move` | `{ source, destination, options }` | `requestId` | copy then delete |
| `object_delete_batch` | `{ profileId, bucket, keys, versionIds? }` | `DeleteReport` | batched via `delete_objects` |
| `object_create_folder` | `{ profileId, bucket, prefix }` | `()` | PUT zero-byte `prefix/` |
| `object_set_metadata` | `{ key, metadata, tags?, ifMatchEtag }` | `PutResult` | uses `copy_object` to self with new metadata |
| `object_set_storage_class` | `{ targets, newStorageClass, confirmedDiffId }` | `requestId` | requires diff-preview confirmation token |
| `object_presign` | `{ profileId, bucket, key, expiresSec }` | `PresignedUrl` | clipboard-only (frontend copies) |

### Transfers

| Command | Input | Output | Notes |
|---|---|---|---|
| `transfer_upload` | `{ profileId, bucket, prefix, sourcePath, options }` | `requestId` | streams progress events |
| `transfer_upload_many` | `{ profileId, bucket, prefix, sourcePaths, options }` | `Vec<requestId>` | enqueues concurrently respecting cap |
| `transfer_download` | `{ profileId, bucket, key, destPath }` | `requestId` | streaming `get_object`, 256 KB progress |
| `transfer_download_many` | `{ tasks }` | `Vec<requestId>` | mixed prefix/key download |
| `transfer_cancel` | `{ requestId }` | `()` | aborts multipart upload server-side if active |
| `transfer_retry` | `{ requestId }` | `requestId` | restarts (not resumable in v1) |
| `transfer_list` | `{ filter? }` | `Vec<TransferState>` | active + completed + failed |
| `multipart_scan` | `{ profileId, bucket, olderThan? }` | `Vec<MultipartUpload>` | tags brows3r-started uploads |
| `multipart_abort` | `{ profileId, bucket, uploadId, key, source }` | `()` | refuses unknown source unless `confirmedUnknown=true` |

### Inspector / Capability

| Command | Input | Output | Notes |
|---|---|---|---|
| `bucket_inspect` | `{ profileId, bucket }` | `BucketInspector` | aggregates region, versioning, encryption (read-only), lifecycle, object lock, PAB, CORS, tags, replication, logging, website, notifications, ownership controls, requester-pays |
| `object_inspect` | `{ profileId, bucket, key, versionId? }` | `ObjectInspector` | head + tags + acl-summary + restore status |
| `capability_get` | `{ profileId, scope }` | `CapabilityMap` | cached classification per `(profile, bucket?, op)` |
| `capability_clear` | `{ profileId, scope? }` | `()` | manual refresh |

### Locks / Notifications / Search / Settings / Media / Updater / Diagnostics

| Command | Input | Output | Notes |
|---|---|---|---|
| `locks_list` | `{ scope? }` | `Vec<ResourceLock>` | for UI warnings |
| `lock_release_stale` | `{ lockId }` | `()` | last-resort manual override |
| `notifications_list` | `{ since? }` | `Vec<Notification>` | also broadcast as events |
| `notification_dismiss` | `{ id }` | `()` | |
| `search_local_filter` | `{ paneId, query }` | `Vec<EntryRef>` | runs over the current cached page |
| `search_prefix` | `{ profileId, bucket, prefix, query, requestId }` | `requestId` | streams `search:page` events; cancellable via `search_cancel` |
| `search_cancel` | `{ requestId }` | `()` | |
| `settings_get` | — | `Settings` | |
| `settings_update` | `{ patch }` | `Settings` | shortcut conflicts return `Err(ConflictReport)` unless `force=true` |
| `media_register` | `{ profileId, bucket, key }` | `{ url, expiresAt }` | mints a signed local URL via media_server |
| `media_revoke` | `{ token }` | `()` | |
| `updater_check` | — | `UpdateStatus` | |
| `updater_install` | — | `()` | |
| `diagnostics_collect` | `{ includeRecentErrors, redactionLevel }` | `BundleRef` | |
| `diagnostics_export` | `{ bundleRef, destPath }` | `()` | |
| `diff_preview_create` | `{ kind, before, after }` | `DiffId` | for storage-class change today; framework reused later |
| `diff_preview_cancel` | `{ diffId }` | `()` | derived from review residual item — explicit cancel-from-preview |

### Events (server → client)

- `buckets:updated { profileId }`
- `objects:updated { profileId, bucket, prefix }`
- `transfer:progress { requestId, bytesDone, bytesTotal?, partsDone, partsTotal? }`
- `transfer:state   { requestId, state }` (queued | running | done | failed | canceled)
- `lock:acquired   { lockId, scope, opName }`
- `lock:released   { lockId, reason }` (success | failure | cancel | ttl | startup_cleanup)
- `notification:new { id, severity, message, ... }`
- `search:page    { requestId, page }`
- `media:revoked  { token }`
- `updater:status { status }`

### Error model

A single `AppError` enum, carried over IPC as `{ kind, message, retryable, details? }`:

```
AppError {
  Auth { reason },                  // expired / invalid / missing
  AccessDenied { op, resource },
  NotFound { resource },
  Conflict { etagExpected, etagActual? },   // ETag precondition failures
  RateLimited { retryAfterMs? },
  Unsupported { op, provider },     // for compat providers
  Network { source },
  Cancelled,
  Locked { lockId, opName },
  Validation { field, hint },
  ProviderSpecific { code, message }, // covers MinIO/R2/Wasabi quirks
  Internal { trace_id },            // anything else; trace_id ties to log
}
```

Frontend maps `AppError.kind` to a presentation policy (toast vs inline vs
notification log only).

## Credential And Profile Model

- **Discovery sources, in order**:
  1. `~/.aws/credentials` profiles.
  2. `~/.aws/config` profiles (including `source_profile` / `role_arn` chains
     resolved by AWS SDK credential provider chain — no inline MFA UI).
  3. Manual profiles created in-app (secret material in OS keychain via
     `keyring` crate keyed by `brows3r:<profileId>`).
  4. Environment variables (`AWS_PROFILE`, `AWS_REGION`, etc.) — surfaced
     read-only, not edited.
- **Profile identity**: each profile has a stable internal `profile_id`
  (UUIDv4 minted on first registration, persisted in the local settings
  store) plus a `display_name` shown in UI. The canonical URI uses
  `profile_id`; the breadcrumb uses `display_name`. Two profiles with the
  same display name remain unambiguous in copied paths.
- **Active profile per pane**: panes are independent. Switching pane
  credentials does not flush other panes.
- **Validation gate**: cached bucket/object data for a profile is rendered
  only after `profile_validate` succeeds in the current session. Cache
  contents are not flushed on validation failure; they are simply hidden
  until validation succeeds. Enforcement lives in two layers: (a) the Rust
  `cache::store` short-circuits read-through and refuses to serve listings
  for any profile whose `validated_at` is unset for the current session;
  (b) the frontend exposes a single `useValidatedProfile(profileId)` hook
  that gates rendering of bucket lists, object lists, inspector panels,
  and bookmarks/recents. Backend remains the source of truth — the hook
  is defense-in-depth, not the gate.
- **Compat flags**: stored as part of the profile record (not in keychain).
  Schema versioned with `flags_schema = 1`; unknown flags warn and pass
  through, satisfying the proposal's extension mechanism.

## Frontend State Management

- **Zustand** for UI state: pane focus, view mode per pane, selection,
  sidebar open/closed, theme, command palette open, transfer panel
  visibility. Persisted slice: theme, sidebar widths, default view mode
  override, last session.
- **TanStack Query** for server-state mirrors. Query keys are canonical and
  centralized in `src/query/keys.ts`. Cache time matches Rust SWR but is
  capped at 30s in the adapter — Rust events drive
  `queryClient.invalidateQueries` when listings change.
- **Event mirroring**: `lib/tauri.ts` registers global listeners on app
  mount that push `transfer:*`, `lock:*`, `notification:new`,
  `objects:updated`, `buckets:updated`, `media:revoked`, and
  `updater:status` into the appropriate Zustand slice or invalidate the
  matching query.
- **Cache invalidation rules**:
  - mutations (put/delete/copy/move/folder/storage-class) emit
    `objects:updated` on success → adapter invalidates `['objects',
    profileId, bucket, prefix]` and `['inspector', ...]` for affected keys.
  - profile change or validation failure clears all queries scoped to that
    `profileId` from the adapter, but does not touch Rust cache.
  - manual refresh (`Cmd/Ctrl+R`) calls the relevant `*_force=true` command
    and invalidates the corresponding adapter query.

### Optimistic Updates With Rollback

For mutations where the post-state is fully predictable from the request
(create-folder, single delete, single rename), the adapter performs an
optimistic update via TanStack Query's `onMutate` and a rollback on
`onError`:

- A small `optimistic.ts` helper builds the predicted post-state per
  mutation kind (folder created, key removed, key renamed) and stages it
  in the adapter cache.
- On Rust success (`objects:updated` event) the optimistic state is
  reconciled against the authoritative backend listing — Rust always wins
  on divergence; a notification fires if the reconciliation drops or
  changes a row the user just touched.
- On Rust failure (`AppError`) the adapter rolls back to the
  pre-mutation snapshot and `present(error)` surfaces the cause.
- Mutations that are **not** safe for optimism in v1: storage-class
  change (gated by diff confirmation), batch-delete with mixed outcomes,
  cross-account fallback (uses the transfer queue and is async by
  design), object-metadata edits (require server ETag echo). These wait
  for the backend event before reflecting state.

Rollback semantics are unit-tested per mutation kind; reconciliation
divergence is integration-tested against LocalStack.

## Streaming Strategy

### Upload

- Single-file < 5 MB → `put_object`.
- Single-file ≥ 5 MB → multipart upload, default part size 8 MB, capped at
  10,000 parts (so files up to ~80 GB use 8 MB; larger files dynamically
  scale part size to stay under the part cap).
- Per-part progress events; cancellation calls `abort_multipart_upload`
  before releasing the lock.
- Concurrency: per-transfer parts dispatched via `tokio::Semaphore`,
  default 4 in-flight parts per transfer; transfer-level concurrency
  capped by the global `transfer_concurrency` setting (default 4).

### Download

- Streaming `get_object` body, 256 KB chunk write, progress event every
  256 KB or every 250 ms (whichever is more frequent up to a 50 ms floor).
- Folder downloads expand a prefix into individual download tasks
  pre-flight, then enqueue.

### Multipart bookkeeping

- Each in-progress multipart upload is recorded in a `redb` table
  `multipart_active` with `(profileId, bucket, key, uploadId, started_at,
  source="brows3r")` so the cleanup scanner can distinguish brows3r-started
  uploads from foreign ones without confirmation.

## Resource Locks

- Scope key: `(profileId, bucket, prefix?, key?)`. Conflicting ops on a
  prefix/key match by longest-prefix.
- Lifecycle: acquire → heartbeat every TTL/3 → release on terminal state.
- TTL: default 5 minutes (settings-configurable).
- Startup cleanup: at app start, all locks not heartbeated within TTL are
  cleared and a `lock:released { reason: "startup_cleanup" }` event is
  emitted.
- Auto-expire: a background task scans every TTL/2 and releases stale
  locks; emits notification entry so the user can investigate.

## Capability Cache

- Keyed by `(profileId, bucket?, op)`.
- Populated lazily when an API call returns `AccessDenied`, `NotImplemented`,
  unsupported-feature, or storage-class-related errors.
- TTL: 30 minutes default; cleared on profile re-validation, on user-
  initiated manual refresh, or on explicit `capability_clear`.
- UI consumes via `useCapabilities(...)`; disabled controls render with
  subtle reasons (e.g. `Requires s3:PutBucketVersioning`,
  `Deferred from v1`, `Not available for STANDARD_IA`).

## Diff Preview / Confirmation Framework

- v1 trigger: storage class change.
- Flow: caller invokes `diff_preview_create` with `before` / `after`
  payloads → backend persists diff in-memory keyed by `DiffId` →
  frontend renders the diff modal → on user confirm, the mutating
  command (`object_set_storage_class`) is called with `confirmedDiffId`
  and the backend rejects if the diff has been canceled or expired.
- Cancel path: `diff_preview_cancel { diffId }` removes the pending diff;
  any subsequent attempt to use the diff returns `AppError::Validation`.
  This addresses the round-3 residual watch item with a derived test
  case in `views/diff/__tests__/cancel.test.tsx` and an integration test
  in `src-tauri/tests/diff_preview.rs`.

## Loopback Media Server

- `axum` server bound to `127.0.0.1:0` at app start; port stored in app
  state and passed to frontend on demand.
- `media_register` mints a 64-byte random token, stores
  `(token → (profileId, bucket, key, expiresAt, sessionId))` in memory,
  and returns `http://127.0.0.1:<port>/m/<token>`.
- Server validates token, range header, and session; streams via
  `get_object` with byte-range support so video seeks work.
- Tokens expire after 1 hour or on session end (whichever is first); a
  `media:revoked` event is emitted on revocation.

## View Modes And Selection

- View-mode switch contract is implemented in `views/modes/switching.ts`:
  - Details/Icon/Gallery/Tree → preserve location and selection.
  - Flat key view → preserve location; collapse virtual-folder selections
    to underlying object selections.
  - Column view (entry from any other mode and parent-column change) →
    preserve location; deeper-column selection resets. (Derived test
    case for `*-to-Column` entry per round-3 residual item.)
  - Dual-pane → each pane independent; entry/exit preserves per-pane
    location and selection.

## Search

- Local filter: pure frontend over the cached `ListPage`s for the current
  pane. No IPC.
- Bucket-wide prefix search: `search_prefix` walks `list_objects_v2`
  pages with `prefix` set, emits `search:page` events, and is cancellable
  via `search_cancel`. Walk concurrency capped by transfer concurrency.

## Settings Persistence

- File: `${app_config_dir}/settings.json` (Tauri-resolved, per-OS).
- Schema versioned (`schemaVersion: 1`); unknown keys preserved on save to
  forward-compat with future flags.
- `defaults.rs` is the single source of truth for v1 defaults listed in the
  proposal and is the seed used when the file is missing.

## Cross-Platform Considerations

- **Paths**: backend uses `camino::Utf8PathBuf` for all S3-related local
  paths (the WebView is always UTF-8); fallback to `std::path::PathBuf`
  only when a Tauri plugin returns it.
- **Dialogs**: `tauri-plugin-dialog` for open/save; default download dir
  resolved from `tauri::api::path::download_dir()` and overridable in
  settings.
- **Keychain**: `keyring` crate maps to Keychain (mac), Secret Service /
  libsecret (linux), Credential Manager (win). Linux requires
  `dbus`/`secret-service`; ship a fallback to encrypted file with a
  user-supplied passphrase only if `keyring` init fails (logged, prompted,
  off by default).
- **Drag-out**: Tauri 2's `drag` API on macOS and Windows; on Linux this
  remains best-effort and falls back to "Save to..." dialog.
- **Media server port**: always loopback; firewall prompts avoided by
  binding to `127.0.0.1` only.

## Test Strategy

- **Rust unit** (`cargo test --lib`): credential parsing, compat-flag
  application, cache TTL/SWR semantics, lock lifecycle including TTL/
  startup cleanup, capability classification, diff preview
  create/cancel/expire, settings load/save with unknown keys, multipart
  source tagging, path encoder.
- **Rust integration** (`src-tauri/tests/`, gated by `LOCALSTACK_URL` env
  var; CI spins LocalStack via `services:` block in GitHub Actions):
  list/get/put/copy/delete, multipart upload + cancellation server-side
  abort, multipart cleanup scanner, presign generation, cross-account
  fallback path (simulated via two LocalStack regions), media server
  range requests + token expiry.
- **Rust contract tests for compat providers**: a small matrix run
  manually or in nightly CI against MinIO docker container covering
  `path_style`, `expect_continue=off`, and `checksum_mode=disabled`.
- **Frontend unit/component** (Vitest + Testing Library): all view
  modes, breadcrumb/path bar, virtual list smoke (1k mocked rows),
  shortcut conflict resolver, command palette, inspector disabled-state
  rendering, diff preview modal incl. explicit cancel, transfer manager
  state mirroring, notifications panel, settings form, search modes.
- **Web Worker tests**: CSV/JSON parser sanity on representative
  fixtures.
- **E2E (Playwright via Tauri webdriver)**: smoke flow — add manual
  profile (LocalStack), list bucket, upload file, preview, download,
  delete; gated to nightly + release branches because of LocalStack
  startup cost.
- **Performance harness** (cargo bench + Vitest perf marker): list
  rendering 10k mocked entries scrolled 10s, asserting 55+ fps p95 and
  ≤250 MB list view memory budget per AC-8.

## Risks And Mitigations

(Inherits the proposal's risk table; design-level additions below.)

- **Tauri 2 + Tailwind v4 friction** — Tailwind v4 is css-first; pin
  exact versions and lock the `vite-plugin-tauri` and `@tailwindcss/vite`
  combination known to build.
- **Monaco bundle inflated** — code-split: Monaco loaded only by
  `EditorPreview.tsx`; preview-only text uses Shiki.
- **`keyring` crate Linux flakiness** — feature-gate a passphrase-
  encrypted file fallback; never silent.
- **LocalStack S3 parity** — pin LocalStack image; document known gaps
  (object-lock retention edge cases) and supplement with manual AWS
  sandbox runs at release time.
- **Auto-update supply chain** — sign update artifacts with a project-
  controlled key; verify via Tauri updater public key in `tauri.conf.json`.

## Decisions

This section records design-level decisions taken in response to plan-
review round 1, including conscious deviations from reviewer suggestions
where applicable.

### D1 — Embedded KV: `redb`, not `sled`

Plan-review finding #3 flagged `sled` as effectively unmaintained
(maintainer publicly paused the project; last meaningful release Sept
2023). We swap to `redb` 2.x for both the listings/metadata cache
(`cache::store`) and the multipart bookkeeping table (`s3::multipart`).
Rationale:

- `redb` is actively maintained and stable on a 2.x line.
- API shape (transactions, typed tables) is similar enough that the
  module surface in this design does not change.
- Both consumer surfaces store rebuildable state — cache contents are
  re-derived from S3 on miss; multipart bookkeeping is recoverable from
  `list_multipart_uploads`. KV failure is recoverable.

If `redb` later becomes a constraint (e.g. on a niche platform), the
fallback is in-memory only with periodic dump to a JSON sidecar; this
would not require a redesign because both consumers already tolerate
disk-state loss.

### D2 — Optimistic UI updates ship in v1, with bounded scope

Plan-review finding #22 flagged that optimistic updates were silent in
the design. We choose to implement them in v1 rather than defer, but
only for the predictable-post-state mutations enumerated in the
"Optimistic Updates With Rollback" section above. Diff-gated, batched,
cross-account, and metadata-edit mutations stay event-driven. Backend
remains the source of truth — the adapter reconciles to Rust state on
event arrival and rolls back on failure.

### D3 — Settings screen ships as a single commit

Plan-review finding #17 suggested splitting the 14-panel settings
screen into three commits. We keep it as one task (the single
settings-screen commit, currently task 56 in `tasks.md`) gated by
explicit per-panel test coverage in its Done-when criterion. Rationale:
each panel is a thin form bound to a typed `Settings` field — the panels
share the same form primitives and validation hooks, so the marginal
review value of three smaller PRs is low compared to the merge-conflict
cost of editing a shared form module across three PRs.

### D4 — Tauri plugins land as a single early bootstrap commit

Plan-review findings #4 and #5 flagged that no task installed the
required Tauri plugins (`fs`, `dialog`, `shell`, `notification`). Rather
than scatter installs across the consuming tasks, all four plugins
install in a single early `chore(tauri):` commit (task 5 in the
renumbered list) with their minimal capability allowlists declared in
`src-tauri/capabilities/default.json`. Subsequent tasks then consume
already-installed plugins. Rationale: capability JSON is centralised
truth; bundling the install eliminates a class of "command added but
plugin missing" runtime failures.

### D5 — A11y baseline distributed across UI tasks, not bolted on at the end

Plan-review finding #16 flagged that the original task 53 was the only
a11y commit, which created retrofit risk. The a11y *baseline* (focus
management, ARIA roles for lists/buttons, tab order) is now part of the
shell scaffold task; subsequent UI tasks each carry a one-line axe-core
assertion in their Vitest scope. The dedicated a11y task remains for
deeper command-palette polish and the screen-reader pass.

### D6 — CI runs the full test suite, not just `--lib`

Plan-review findings #6, #10, and #24 flagged the original CI surface
as too narrow. The renumbered task 4 ships `cargo test --workspace
--all-targets` plus a Linux-only integration job spinning LocalStack
via `services:`. Integration tests gate on a `--features integration`
flag so unit tests stay fast and macOS/Windows runners (where
LocalStack `services:` is not supported) still run lib + frontend.
Per-platform integration coverage is deferred to a nightly/manual
sandbox workflow against AWS itself.

## Open Questions Carried Forward

None at the proposal level. Two derived test cases (cancel-from-diff-
preview and `*-to-Column` view mode entry) are absorbed into the
relevant tasks in `tasks.md`.
