# Multipart cleanup

Cancelled or crashed multipart uploads leave orphaned parts in S3. They are
invisible in normal `ListObjectsV2` output but they still incur storage
cost. brows3r ships a Settings panel that surfaces and aborts them.

## Where it lives

Settings → Multipart cleanup. The panel shows per-bucket totals of
in-progress multipart uploads, their key prefixes, and the time elapsed
since `InitiateMultipartUpload`. Selecting one or many → "Abort" issues
`AbortMultipartUpload` for each.

## Why it matters

- AWS does **not** auto-clean abandoned multiparts; you must configure
  a bucket lifecycle rule or abort manually.
- brows3r's own transfer queue tracks every multipart it starts in the
  Rust-side `multipart_bookkeeping` table (`redb`) and issues
  `AbortMultipartUpload` on cancel. That covers the brows3r-originated
  case. The cleanup panel exists for everything else — failed `aws s3
  cp`, dead Lambda jobs, abandoned SDK runs, etc.

## How discovery works

The scanner walks `ListMultipartUploads` for the active bucket (or every
bucket if you point it at the bucket list). Pagination is honoured; the
panel streams partial results as they arrive so the UI never blocks.

Each entry shows:

- Key
- `UploadId`
- Owner / Initiator
- Initiated-at timestamp
- "Age" relative-time chip

You can sort by any of these.

## Safety

Abort is destructive — you lose the parts that have been uploaded so far.
The confirmation dialog shows the count + estimated wasted storage cost
based on the parts already paid for. If you're not sure whether an upload
is still in progress, leave it alone — a healthy in-progress upload
shows the initiator and an obviously-recent timestamp.

## Capability gaps

`ListMultipartUploads` requires `s3:ListBucketMultipartUploads`. Without
that permission the panel shows "Insufficient permission" instead of an
empty state, so the user knows the panel is not just blank.
