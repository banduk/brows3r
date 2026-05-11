# Preview

The preview panel renders the focused object in the active pane. brows3r
chooses a renderer based on MIME type first, then falls back to file
extension — this matters because S3 frequently stores objects with
`Content-Type: application/octet-stream` (the default when `aws s3 cp`
runs without `--content-type`).

## Routing

| Renderer | MIME / extension |
|---|---|
| **Image** | `image/*`, `.png .jpg .jpeg .gif .webp .svg .bmp .ico .tif .avif .heic` |
| **Video** | `video/*`, `.mp4 .m4v .mov .webm .mkv .avi .ogv .3gp .mpg .wmv .flv` |
| **Audio** | `audio/*`, `.mp3 .wav .ogg .flac .aac .m4a .opus .wma .aiff` |
| **PDF** | `application/pdf`, `.pdf` |
| **HTML** | `text/html`, `.html .htm .xhtml` — sandboxed iframe + "View source" toggle |
| **Markdown** | `text/markdown`, `.md` — GFM + syntax highlight |
| **Archive** | `application/zip`, `.zip .tar .gz .tgz .tar.gz` — entry listing, no in-app extract |
| **Table** | `.csv .ndjson .jsonl .parquet` or top-level JSON arrays |
| **Text / code** | `text/*` + extension-mapped languages — Shiki syntax highlight |
| **Hex** | `.bin .exe .dll .so .dylib .wasm .obj .o .a .lib` (known binaries) |

Anything that isn't matched to a specific renderer falls through to **Text**
as a best-effort: the backend UTF-8 decodes the bytes, replacing invalid
sequences with U+FFFD. If the result looks like noise, switch to Hex from
the preview toolbar.

## Size limit

Previews are capped at 50 MB (configurable in Settings → Preview). Larger
objects show a "Preview anyway" button — clicking it bypasses the cap
for that file. This is on top of the 1 MB text-fetch cap built into
`object_get_text` (the backend Range-reads the first MB and replaces
invalid bytes — a "Truncated" banner appears in the preview).

## Text & editor options

The Shiki-rendered text view and the Monaco editor share a settings
popover (gear icon in the toolbar). Preferences persist in
`useUiStore.textPreviewPrefs`:

- **Theme**: `auto` (follows the global UI theme) / `light` / `dark`
- **Word wrap**: on / off (affects both Shiki and Monaco)
- **Font size**: 9–28 px stepper
- **Line numbers**: editor-only (toggle visible in the popover)

The "Edit in Monaco" button on a text preview switches to the editor with
the same theme/wrap/font preferences. Save (Cmd+S) goes through
`object_put_text` with an `If-Match` ETag precondition — on conflict you
get an inline "Refresh / Save anyway" banner.

## Media (image / video / audio / PDF)

Media bytes never cross the IPC boundary. The flow is:

1. Component calls `mediaRegister(profileId, bucket, key)` over IPC.
2. Rust mints a single-use session token + returns a loopback URL
   (`http://127.0.0.1:<port>/m/<token>`).
3. The HTML element (`<img>`, `<video>`, `<audio>`, `<iframe>` for PDF.js
   via react-pdf) loads bytes from the loopback server.
4. The Rust server validates the token, streams from S3 with a `Range`
   request, and forwards bytes to the WebView.

The loopback server emits `Access-Control-Allow-Origin: *` so that
`fetch()`-based renderers (pdf.js) can read responses cross-origin from
the WebView. Tokens are unguessable and revoked on component unmount; see
[Concepts → Media server](/concepts/media-server) for the threat model.

## "Fetched X ago"

The status bar shows when the object's HEAD was last fetched. Useful for
spotting stale previews after a concurrent upload — the bar re-renders
every 15 seconds, and the tooltip carries the absolute timestamp.
