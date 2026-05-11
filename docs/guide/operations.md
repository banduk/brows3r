# Bulk operations

Every file operation is available from the Toolbar, the right-click context
menu, the command palette (<kbd>Cmd</kbd>+<kbd>K</kbd>), and a keyboard
shortcut. The reasoning for each:

- **Toolbar**: discoverability for new users.
- **Context menu**: zero-keystroke access for one-off actions.
- **Command palette**: keyboard-only flow, fuzzy-named so users don't
  have to remember exact names.
- **Keyboard shortcut**: power-user muscle memory.

This page walks through the non-obvious behaviour of each operation.

## Upload

- **Drag-and-drop**: drop files (or a folder) onto a pane. brows3r enqueues
  one transfer per file; folder structure is preserved via key prefixes.
- **Toolbar button**: opens the native file picker.
- **Progress** is reported via the Transfer Manager (sliding panel from the
  bottom of the window). Each transfer shows bytes/sec, ETA, and a cancel
  button.

Files larger than 5 MB use multipart upload by default (configurable in
Settings → Transfers). On cancel mid-upload, the backend issues a
`AbortMultipartUpload` to avoid orphaned parts — see
[Multipart cleanup](/guide/multipart) for the scanner that catches the rest.

## Download

- **Single file**: button or context menu → native Save dialog → range-read
  in the background.
- **Recursive folder / bucket**: button explicitly warns that S3 has no
  native "download folder" — the operation lists all keys under the prefix
  and writes them to a chosen directory. Compressed `.zip` of the
  selection is a planned enhancement.
- The Transfer Manager surfaces the rolled-up progress.

## Copy / Cut / Paste

- **Copy** (Cmd+C) marks selection as "to copy"; **Paste** (Cmd+V) drops it
  into the active prefix.
- **Cut** (Cmd+X) is "copy + delete-on-success" — atomic from the user's
  perspective; brows3r only deletes after the copy confirms.
- Same-bucket → server-side `CopyObject` (no bytes move through Rust).
- Cross-profile / cross-region → byte stream via Rust, multipart if large.

## Move / Rename

- **Rename** (F2) is "copy to new key + delete old" within the same prefix.
- **Move** is the same operation but the user picks a destination prefix.
- Both surface a confirmation dialog (configurable in Settings →
  Confirmations) because they are destructive on the source side.

If the destination already exists, brows3r shows a per-file conflict
prompt: Overwrite / Skip / Rename-with-suffix / Cancel.

## Delete

Hard delete is gated on a confirmation dialog with the count + total
bytes. brows3r does **not** soft-delete — there is no "Trash" prefix.

For versioned buckets, the delete creates a delete marker; clearing
versions is a separate action in the Inspector → Versions tab.

## Create folder

S3 has no folders. brows3r creates a 0-byte object whose key ends with
`/` (the "folder marker" convention used by the AWS console). It shows
up in any compatible client.

## Presigned URL

Right-click an object → "Copy presigned URL". Default TTL is 1 hour
(configurable). The URL is generated in Rust using the bucket's region
and the active credentials; brows3r writes it to the clipboard via
`@tauri-apps/plugin-clipboard-manager`. The URL itself never appears in
a log.

## Transfer queue

- Concurrent transfers default to 4 (configurable).
- The queue persists across app restarts (`redb` store) — interrupted
  transfers resume on next launch with `Range:` requests for downloads
  and `UploadPart` for uploads.
- Errors are classified (retryable network vs. permanent permission) and
  surfaced inline. Retryable errors auto-retry with exponential backoff up
  to 5 times; permanent errors stop the transfer and require user action.
