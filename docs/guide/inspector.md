# Inspector

The Inspector (<kbd>Cmd</kbd>+<kbd>I</kbd> or the "Inspect" link in the
selection summary) surfaces metadata that's hidden in normal listings.

## Bucket scope

When invoked with no object selected, the Inspector shows bucket-level
information:

- **Versioning**: enabled / suspended / never-enabled.
- **Encryption**: SSE-S3 / SSE-KMS / SSE-C / none. KMS key alias if
  available.
- **Lifecycle rules**: human-readable summary of each rule + a raw-XML
  toggle for engineers who want the source of truth.
- **Replication**: source/destination buckets, RoleArn, status.
- **Bucket policy**: parsed JSON with a syntax-highlight render.
- **Public access block**: the four `BlockPublicAccess` settings.
- **Tags**: bucket tags.
- **Region**: discovered region.
- **Object Lock**: enabled / disabled. If enabled, default retention.

Most of these surface as collapsible sections — a single fetch on Inspector
open hydrates them all, with per-section refresh available.

## Object scope

With one object selected:

- **HEAD metadata**: Content-Type, Content-Length, ETag, last modified,
  Cache-Control, Content-Encoding, Content-Disposition, custom headers.
- **Storage class**: STANDARD / IA / GLACIER / DEEP_ARCHIVE / etc. with
  the available transitions.
- **Versions**: full version timeline if the bucket is versioned —
  shows IDs, modified-at, ETags, "IsLatest", delete markers.
- **ACL**: per-grant breakdown (canonical user, group, email-address).
- **Tags**: object tags.
- **Object Lock**: retention mode + retain-until-date if applicable.
- **Server-side encryption**: per-object SSE state (can differ from bucket
  default).
- **Lock state**: brows3r's internal resource lock (when another
  transfer is in flight against the same key — see
  [Concepts → Cache & SWR](/concepts/cache#resource-locks)).

## Capability gaps

Operations that the bucket / key doesn't support are surfaced as disabled
controls with a hover-explanation, not red banners:

- "Move" is greyed when the source has Object Lock retention beyond the
  current time.
- "Restore from Glacier" appears as an action only when the storage class
  permits it.
- "Set ACL" is muted when the bucket has Object Ownership =
  `BucketOwnerEnforced` (ACLs disabled).

Each disabled control has a tooltip explaining *why* — the philosophy is
"capability gaps feel intentional". The classification logic lives in
[Concepts → Capability cache](/concepts/capabilities).

## Multiple selection

With more than one object selected, the Inspector enters bulk mode:

- Common metadata (storage class, encryption) is shown when uniform
  across the selection; mixed values show as "—".
- Total size + count appear in the header.
- Bulk actions (tag, restore, change storage class) operate over the
  whole selection with progress reporting via the Transfer Manager.
