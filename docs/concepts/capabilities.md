# Capability cache

> Capability gaps feel intentional. Permissions, unsupported features, and
> storage-class limitations are classified, cached, and surfaced as
> disabled controls — never as red banners.

S3-compatible backends vary wildly in what they implement. MinIO doesn't
have storage class transitions. Cloudflare R2 returns a custom error for
unsupported lifecycle rules. Wasabi rejects multipart copy. Even AWS S3
behaves differently depending on bucket configuration (Object Ownership,
Object Lock, encryption mode). A naïve UI would error-banner the user
into oblivion.

The capability cache solves this by classifying every "this operation
returned a permission/unsupported error" event into one of five buckets,
caching the verdict per (profile, bucket, operation), and letting the UI
mute controls accordingly.

## Classification

| Class | Cause | UI effect |
|---|---|---|
| `Permitted` | The operation succeeded at least once. | Control is enabled. |
| `Denied` | `AccessDenied` / `Forbidden` from the SDK. | Control disabled, tooltip "Your role lacks `s3:<Op>`". |
| `NotImplemented` | `NotImplemented` / `MethodNotAllowed`. | Control hidden entirely. |
| `StorageClassBlocked` | `InvalidStorageClass` / `NoSuchTransition`. | Control disabled with the offending class chip. |
| `Unknown` | Never observed. | Control enabled (optimistic). |

## Where it lives

Rust side — `capability` module:

- One key per `(profile_id, bucket, operation)` tuple.
- Persisted in `redb` so a fresh session inherits prior verdicts.
- TTL: 24 h for `Denied`/`NotImplemented`, 7 d for `StorageClassBlocked`,
  forever for `Permitted` (until invalidated explicitly).
- Invalidated by: profile revalidation, bucket recreation, user-initiated
  "reset capabilities" in Settings → Diagnostics.

## Update flow

```
Operation runs ─► success      ► record Permitted
                ─► AccessDenied ► record Denied (24h TTL)
                ─► NotImplemented ► record NotImplemented (24h TTL)
                ─► InvalidStorageClass ► extract class, record StorageClassBlocked (7d TTL)
                ─► other ► do nothing
```

The recording happens in the error-classifying layer
(`AppError::ProviderSpecific` → `CapabilityClass::*`). The mapping is one
match arm per S3 error code — adding new providers is one entry per
new code.

## Why not just retry and find out?

Two reasons:

1. **User experience.** A button that lights up only to throw an error
   when clicked is worse than a button that's clearly off. Disabled
   controls with hover-explanations let users plan around the gap
   instead of stumbling into it.
2. **Quotas.** Repeatedly trying a forbidden operation can trigger
   exponential-backoff penalties on some backends (and IAM rate limits).

## How the UI consumes it

The frontend exposes `useCapability(profileId, bucket, operation)`:

```ts
const { isAllowed, reason } = useCapability(
  profileId,
  bucket,
  "PutBucketLifecycleConfiguration",
);

return (
  <Button disabled={!isAllowed} title={reason}>
    Edit lifecycle
  </Button>
);
```

The hook returns optimistic defaults (`isAllowed = true`) until the cache
populates, so first-time use of an operation isn't artificially blocked.

## Diagnostics

Settings → Diagnostics has a "Capability cache" panel that:

- Lists every cached verdict for the active profile.
- Lets you reset per-(bucket, operation) entries or the whole table.
- Shows the most recent observation timestamp.

Useful when the user has just been granted new permissions and wants to
re-enable a previously-disabled control without waiting for the TTL.
