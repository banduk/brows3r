# Cache & SWR

brows3r's caching philosophy is one sentence:

> **Rust is the authoritative cache. TanStack Query is a short-lived
> render adapter.**

This page explains what that means in practice — what is cached where, who
invalidates what, and the invariants the codebase relies on.

## Layers

```
┌──────────────────────────── WebView ─────────────────────────────┐
│  Zustand stores                                                   │
│   - panes, ui, inspector, transfers, command_palette, …           │
│   - in-memory only; persist plugin saves to localStorage          │
│                                                                   │
│  TanStack Query                                                   │
│   - per-query render cache (gcTime 5 min, staleTime per-query)    │
│   - invalidated by Tauri events from Rust                         │
└────────────────────────────────────────────────────────────────────┘
                              ▲   │   IPC
                              │   ▼
┌──────────────────────────── Rust ────────────────────────────────┐
│  cache (redb)                                                     │
│   - listings, HEADs, bucket metadata, validation state            │
│   - stale-while-revalidate semantics                              │
│   - emits cache::changed events on every mutation                 │
│                                                                   │
│  s3_client_pool                                                   │
│   - per-(profile, region) SDK clients, 30-min idle TTL            │
└────────────────────────────────────────────────────────────────────┘
```

## Rust-side SWR

The `cache` module wraps `redb` (embedded key-value store) with
stale-while-revalidate logic. For every read:

1. If a cached entry exists and is **fresh** (within `freshFor`), return it.
2. If a cached entry exists and is **stale** (within `staleWhileRevalidateFor`),
   return it immediately AND fire a background refresh.
3. If no cached entry exists, fetch synchronously.

Refresh writes back to `redb` and emits `cache::changed` (Tauri event) with
the affected query key. TanStack Query on the frontend has a listener that
invalidates the matching query key, which triggers a re-render with the
freshly cached value.

This gives the user "instant" navigation: clicking a previously-visited
folder shows cached content immediately and the live listing updates as
soon as Rust finishes the network round-trip.

## TanStack Query as adapter, not source

The frontend never **decides** that a query is stale on its own. The rules:

- `staleTime: Infinity` on every query — TanStack Query never refetches
  on its own.
- Refetches happen exclusively via `queryClient.invalidateQueries` calls
  triggered by Tauri events.
- The `installEventBridge()` call in `App.tsx` mounts the listeners that
  translate Rust events into TanStack invalidations.

This means: if Rust thinks state is fresh, the UI agrees. There is no race
where the UI shows different data than what Rust has just read from S3.

## Resource locks

Long-running operations (multi-MB uploads, recursive deletes) acquire a
TTL-protected lock on the key/prefix they're mutating. The lock is stored
in `redb` and:

- Has a heartbeat (Rust refreshes every 30s while the operation runs).
- Expires after 90s without a heartbeat (covers crashes).
- Is published to the WebView so the UI can mute conflicting operations.

A locked object's row gets a subtle "🔒 transferring" badge. Right-click
actions that would clash (Delete, Rename, Move) are disabled with a
tooltip pointing at the Transfer Manager.

## Capability cache

A separate slice of the Rust cache tracks per-(profile, bucket, operation)
capability state. See [Capability cache](/concepts/capabilities) for the
full semantics — TL;DR: "we tried operation X on bucket Y once, it
returned NotImplemented, so we're not going to enable that button again
for the rest of the session."

## Invalidation matrix

| Event | Invalidates |
|---|---|
| `objects:created` | All listings under the parent prefix |
| `objects:deleted` | All listings under the parent prefix; the object's HEAD |
| `objects:updated` | The object's HEAD; the parent listing's `modified` field |
| `buckets:created` / `:deleted` | The bucket list for the profile |
| `profile:validated` | All listings for the profile |
| `multipart:aborted` | The multipart cleanup listing for the bucket |

These are emitted by the Rust command handlers AFTER the S3 call confirms,
not before. The frontend's optimistic UI lives in Zustand and is committed
on success / rolled back on error.

## What is NOT cached

- Object bodies (binary content). Range-reads are not cached; each
  preview fetch goes to S3.
- Signed loopback URLs (they're one-shot).
- Presigned URLs (they're delivered to the user immediately and
  discarded).
- Validation credentials. We re-validate on session restart.

## Why redb

- Single-process, embedded, no daemon.
- Zero-copy reads.
- Crash-consistent without a separate WAL config.
- 1-2 MB of dependency size.

The trade-off: redb is not concurrent-write-friendly across processes.
brows3r is single-process by design, so that's fine.
