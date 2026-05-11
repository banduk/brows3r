# brows3r — Architecture Overview

This is a distilled summary of the full design for contributors. For the
authoritative, deep version see
`.crafter/features/s3-native-browser/design.md` in the source tree.

---

## High-Level Architecture

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

Three load-bearing constraints drive every choice:

1. **AWS credentials never cross the IPC boundary.** All S3 SDK calls live in
   Rust; the WebView sees only opaque request IDs, listing payloads, and
   progress events.
2. **Rust is the authoritative cache.** TanStack Query on the frontend is a
   short-lived render adapter — it never contradicts Rust state.
3. **Capability gaps feel intentional.** Permission, unsupported-feature, and
   storage-class errors are classified, cached in Rust, and surfaced as
   disabled controls with subtle reasons — not red banners.

---

## Module Layout (simplified)

### Rust (`src-tauri/src/`)

```
src-tauri/src/
├── main.rs               # tauri::Builder wiring
├── lib.rs                # re-exports for tests
├── error.rs              # AppError enum + IPC serialisation
├── ids.rs                # ProfileId, BucketId, ObjectKey newtypes
├── settings/             # typed Settings struct, load/save, defaults
├── profiles/             # ProfileStore, AWS config parser, keychain,
│                         #   compat flags, validation (STS probe)
├── s3/                   # ClientPool, list, object CRUD, multipart,
│                         #   presign, tags, metadata, inspector
├── cache/                # CacheKey/Entry/TTL/SWR, redb store,
│                         #   invalidation hooks, capability classification
├── transfers/            # TransferQueue, upload (multipart), download,
│                         #   progress events
├── locks/                # ResourceLock registry, heartbeat, TTL expiry,
│                         #   startup cleanup
├── notifications/        # in-app log + OS notification bridge
├── media_server/         # axum on loopback, signed session tokens
├── path/                 # display path vs. canonical URI, percent-encoding
├── search/               # local filter, prefix search, cancellation
├── diagnostics/          # log collector, redactor, zip exporter
├── updater/              # tauri-plugin-updater wiring
└── commands/             # one file per command domain (Tauri #[command])
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

### Frontend (`src/`)

```
src/
├── lib/            # typed invoke/listen wrappers, branded IDs, error map,
│                   #   formatters
├── api/            # one file per backend domain (wraps invoke)
├── store/          # Zustand slices (UI, panes, transfers, notifications,
│                   #   locks, settings, command palette)
├── query/          # TanStack Query client, canonical keys, domain hooks
├── commands/       # CommandDef registry, shortcut map, palette source
├── views/
│   ├── shell/      # three-pane layout, sidebar, statusbar
│   ├── sidebar/    # profiles, bookmarks, recents
│   ├── browser/    # main pane chrome, breadcrumb, path bar
│   ├── modes/      # DetailsView, IconGridView, GalleryView, ColumnView,
│   │               #   TreeView, FlatKeyView, DualPaneView
│   ├── inspector/  # bucket + object inspector panels
│   ├── preview/    # Image, Text, Editor (Monaco), Media, PDF, Table,
│   │               #   Markdown, Hex, Archive renderers
│   ├── transfers/  # transfer manager panel
│   ├── notifications/
│   ├── settings/   # 14-panel settings screen
│   ├── search/
│   └── diff/       # high-impact edit diff/confirm modal
└── workers/        # Web Workers: csv, json, parquet (parquet-wasm)
```

---

## Tauri Command Surface

Every command returns `Result<T, AppError>`. Commands that emit progress also
emit `Event`s and return a `requestId` for correlation. Payloads use
`serde` with camelCase renaming so TypeScript types are mechanical.

### Profiles

| Command | Output | Notes |
|---|---|---|
| `profiles_list` | `Vec<ProfileSummary>` | AWS config + keychain manual profiles |
| `profile_get` | `ProfileDetail` | non-secret fields only |
| `profile_create_manual` | `ProfileSummary` | secret stored in OS keychain |
| `profile_update` | `ProfileSummary` | name + compat flags only |
| `profile_delete` | `()` | also removes keychain entry |
| `profile_validate` | `ValidationReport` | `sts:GetCallerIdentity` / provider probe |
| `profile_set_active_for_pane` | `()` | per-pane, does not re-validate |

### Buckets / Objects

| Command | Output | Notes |
|---|---|---|
| `buckets_list` | `Vec<BucketSummary>` | SWR; emits `buckets:updated` after revalidate |
| `bucket_region_get` | `Region` | served from cache |
| `objects_list` | `ListPage` | delimiter `/`; backend fans out parallel pages |
| `objects_list_flat` | `ListPage` | no `CommonPrefixes`; flat-key view |
| `object_head` | `ObjectHead` | feeds inspector + preview gating |
| `object_get_text` | `TextPayload` | inline body for editor + small preview |
| `object_put_text` | `PutResult` | ETag precondition; 412 → conflict |
| `object_copy` | `requestId` | server-side copy with fallback |
| `object_move` | `requestId` | copy then delete |
| `object_delete_batch` | `DeleteReport` | batched via `delete_objects` |
| `object_create_folder` | `()` | PUT zero-byte `prefix/` |
| `object_set_metadata` | `PutResult` | copy-to-self with new metadata |
| `object_set_storage_class` | `requestId` | requires diff confirmation token |
| `object_presign` | `PresignedUrl` | clipboard-only |

### Transfers

| Command | Output | Notes |
|---|---|---|
| `transfer_upload` | `requestId` | streams progress events |
| `transfer_upload_many` | `Vec<requestId>` | concurrent, respects cap |
| `transfer_download` | `requestId` | streaming, 256 KB progress |
| `transfer_download_many` | `Vec<requestId>` | mixed prefix/key |
| `transfer_cancel` | `()` | server-side multipart abort if active |
| `transfer_retry` | `requestId` | restarts (not resumable in v1) |
| `transfer_list` | `Vec<TransferState>` | active + completed + failed |
| `multipart_scan` | `Vec<MultipartUpload>` | brows3r-started uploads |
| `multipart_abort` | `()` | refuses unknown source without `confirmedUnknown` |

### Inspector / Capability

| Command | Output | Notes |
|---|---|---|
| `bucket_inspect` | `BucketInspector` | versioning, encryption, lifecycle, … |
| `object_inspect` | `ObjectInspector` | head + tags + ACL summary |
| `capability_get` | `CapabilityMap` | cached classification per `(profile, bucket?, op)` |
| `capability_clear` | `()` | manual refresh |

### Misc (Locks, Notifications, Search, Settings, Media, Updater, Diagnostics)

| Command | Output | Notes |
|---|---|---|
| `locks_list` | `Vec<ResourceLock>` | for UI warnings |
| `lock_release_stale` | `()` | manual override |
| `notifications_list` | `Vec<Notification>` | also broadcast as events |
| `notification_dismiss` | `()` | |
| `search_local_filter` | `Vec<EntryRef>` | over current cached page; no IPC |
| `search_prefix` | `requestId` | streams `search:page`; cancellable |
| `search_cancel` | `()` | |
| `settings_get` | `Settings` | |
| `settings_update` | `Settings` | shortcut conflicts → `Err(ConflictReport)` |
| `media_register` | `{ url, expiresAt }` | mints signed loopback URL |
| `media_revoke` | `()` | |
| `updater_check` | `UpdateStatus` | |
| `updater_install` | `()` | |
| `diagnostics_collect` | `BundleRef` | |
| `diagnostics_export` | `()` | |
| `diff_preview_create` | `DiffId` | storage-class change today; reusable |
| `diff_preview_cancel` | `()` | explicit cancel path |

---

## Event Surface (server → client)

| Event | Payload |
|---|---|
| `buckets:updated` | `{ profileId }` |
| `objects:updated` | `{ profileId, bucket, prefix }` |
| `transfer:progress` | `{ requestId, bytesDone, bytesTotal?, partsDone, partsTotal? }` |
| `transfer:state` | `{ requestId, state }` — queued / running / done / failed / canceled |
| `lock:acquired` | `{ lockId, scope, opName }` |
| `lock:released` | `{ lockId, reason }` — success / failure / cancel / ttl / startup_cleanup |
| `notification:new` | `{ id, severity, message, … }` |
| `search:page` | `{ requestId, page }` |
| `media:revoked` | `{ token }` |
| `updater:status` | `{ status }` |

---

## Validation Gate (defense-in-depth)

Cached bucket/object data is rendered only after `profile_validate` succeeds
in the current session. Enforcement lives in two independent layers:

1. **Rust** (`cache::store`) — short-circuits read-through and refuses to
   serve listings for any profile whose `validated_at` is unset for the
   current session.
2. **Frontend** (`useValidatedProfile(profileId)` hook) — gates rendering of
   bucket lists, object lists, inspector panels, and bookmarks/recents.

The backend is the source of truth. The frontend hook is defense-in-depth, not
the gate.

---

## Optimistic Update Boundary

Optimistic updates (TanStack Query `onMutate` + rollback `onError`) apply only
to mutations where the post-state is fully predictable:

- In scope: create-folder, single delete, single rename.
- Out of scope: storage-class change (diff-gated), batch-delete with mixed
  outcomes, cross-account fallback (async via transfer queue),
  object-metadata edits (require server ETag echo).

On `objects:updated` the adapter reconciles to the authoritative Rust listing —
Rust always wins on divergence.

---

## Decisions

### D1 — Embedded KV: `redb`, not `sled`

`sled` is effectively unmaintained (last meaningful release Sept 2023). `redb`
2.x is used for both the cache store and multipart bookkeeping. Both consumers
store rebuildable state, so KV failure is recoverable.

### D2 — Optimistic UI ships in v1, bounded scope

Optimistic updates are implemented in v1 but only for predictable-post-state
mutations. Diff-gated, batched, cross-account, and metadata-edit mutations
remain event-driven.

### D3 — Settings screen as a single commit

The 14-panel settings screen ships in one task (task 56 in `tasks.md`). Each
panel is a thin form sharing the same primitives and validation hooks; the
marginal review value of splitting across three PRs is low compared to the
merge-conflict cost.

### D4 — Tauri plugins land as a single early bootstrap commit

All four required Tauri plugins (`fs`, `dialog`, `shell`, `notification`)
install in task 5 with their capability allowlists. Subsequent tasks consume
already-installed plugins, eliminating a class of "command added but plugin
missing" runtime failures.

### D5 — A11y baseline distributed across UI tasks

The a11y baseline (focus management, ARIA roles, tab order) ships with the
shell scaffold task; each subsequent UI task carries axe-core assertions. The
dedicated a11y task handles deeper command-palette polish and the screen-reader
pass.

### D6 — CI runs the full test suite

`cargo test --workspace --all-targets` plus a Linux-only integration job
spinning LocalStack via `services:`. Integration tests gate on
`--features integration` so unit tests stay fast on macOS/Windows runners.

---

## Where to Find More

- Full design, rationale, and open questions:
  `.crafter/features/s3-native-browser/design.md` (in the source tree)
- Release and signing runbook: [Release process](../contributing/release.md)
- Security model: [Security](../contributing/security.md)
- Local dev setup: [Dev environment](../contributing/dev.md)
