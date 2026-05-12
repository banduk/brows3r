/**
 * PreviewPane — MIME-router for the preview panel.
 *
 * Reads the active pane's first selected key from `usePanesStore`, calls
 * `useObjectHead` for size-limit + MIME-type info, then routes to the correct
 * renderer.
 *
 * Routing strategy:
 *   Detectors check MIME first, then fall back to extension (and basename for
 *   extension-less text files like Dockerfile/LICENSE). The fallback matters
 *   because S3 frequently stores objects with Content-Type=application/octet-stream
 *   — without an extension layer, every "aws s3 cp"-uploaded file would land
 *   on the hex viewer.
 *
 * Renderer table:
 *   image/*, *.png|jpg|gif|webp|svg|bmp|ico|tif|avif|heic     → ImagePreview
 *   video/*, *.mp4|mov|webm|mkv|avi|...                       → MediaPreview
 *   audio/*, *.mp3|wav|ogg|flac|aac|...                       → MediaPreview
 *   application/pdf, *.pdf                                    → PdfPreview
 *   text/html, *.html|htm|xhtml                               → HtmlPreview
 *   text/markdown, *.md                                       → MarkdownPreview
 *   archive (zip/tar/gz/...)                                  → ArchivePreview
 *   CSV / NDJSON / Parquet / top-level JSON array             → TablePreview
 *   text/* + code/config/plain-text extensions                → TextPreview
 *   *.bin|exe|dll|so|dylib|wasm                               → HexPreview
 *   everything else                                           → TextPreview
 *     (best-effort: backend's UTF-8 decode replaces invalid bytes with U+FFFD;
 *      user can switch to hex view if it looks like noise)
 *
 * Size limit (AC-6):
 *   If `head.contentLength > settings.previewSizeLimitMb * 1024 * 1024`, the
 *   pane shows a warning banner with a "Preview anyway" button. The limit
 *   defaults to 50 MB if settings have not loaded yet.
 *
 * Empty state: "Select a file to preview" when nothing is selected.
 * Validation gate: profile not validated → same placeholder.
 *
 * OCP:
 *  - Adding a new renderer is one `else if` branch in `renderContent`.
 *  - Adding more extensions to an existing renderer is one entry in its
 *    *_EXTS set.
 *  - Size-limit policy lives entirely here, applying uniformly to all renderers.
 */

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { settingsGet } from "@/api/settings";
import { extensionToLanguage } from "@/lib/shiki";
import { useObjectHead } from "@/query/hooks/useObjectHead";
import { keys } from "@/query/keys";
import { usePanesStore } from "@/store/panes";
import { ArchivePreview } from "./ArchivePreview";
import { EditorPreview } from "./EditorPreview";
import { HexPreview } from "./HexPreview";
import { HtmlPreview } from "./HtmlPreview";
import { ImagePreview } from "./ImagePreview";
import { MarkdownPreview } from "./MarkdownPreview";
import { type MediaKind, MediaPreview } from "./MediaPreview";
import { PdfPreview } from "./PdfPreview";
import { type TableMode, TablePreview } from "./TablePreview";
import { TextPreview } from "./TextPreview";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default 50 MB — matches the v1 proposal default. */
const DEFAULT_PREVIEW_LIMIT_MB = 50;

/**
 * MIME type prefixes / exact values that map to the image renderer.
 *
 * Covers the proposal's set: png/jpg/gif/webp/svg/bmp.
 */
const IMAGE_MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-bmp",
  // Also handle generic "image/*" prefix below.
]);

/**
 * File extensions that route to ImagePreview when MIME is missing/wrong.
 *
 * S3 frequently stores objects with Content-Type=application/octet-stream
 * (the default for `aws s3 cp` without `--content-type`). Without this
 * fallback those files would skip the image renderer.
 */
const IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".ico",
  ".tif",
  ".tiff",
  ".avif",
  ".heic",
  ".heif",
]);

/**
 * MIME types that map to the video renderer.
 *
 * Covers the proposal's set: mp4/mov/webm/mkv/avi.
 */
const VIDEO_MIMES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/x-msvideo",
  "video/avi",
]);

/** Video extensions for the same reason as IMAGE_EXTS. */
const VIDEO_EXTS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".avi",
  ".ogv",
  ".3gp",
  ".mpg",
  ".mpeg",
  ".wmv",
  ".flv",
]);

/**
 * MIME types that map to the audio renderer.
 *
 * Covers the proposal's set: mp3/wav/ogg/flac/aac.
 */
const AUDIO_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
  "audio/aac",
  "audio/x-aac",
]);

/** Audio extensions for the same reason as IMAGE_EXTS. */
const AUDIO_EXTS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".flac",
  ".aac",
  ".m4a",
  ".opus",
  ".wma",
  ".aiff",
  ".aif",
]);

/**
 * MIME types that map to the PDF renderer.
 */
const PDF_MIMES = new Set(["application/pdf"]);

/** PDF extension fallback. */
const PDF_EXTS = new Set([".pdf"]);

/**
 * MIME types that map to the HtmlPreview (rendered, not source-highlighted).
 *
 * The "view source" toggle on HtmlPreview re-uses TextPreview for the same
 * file, so the user can flip between rendered output and the underlying
 * markup without leaving the pane.
 */
const HTML_MIMES = new Set([
  "text/html",
  "application/xhtml+xml",
  "application/xhtml",
]);

const HTML_EXTS = new Set([".html", ".htm", ".xhtml"]);

/**
 * Extensions that we know contain plain-text payloads even when there is
 * no Shiki language match. Catches log files, config dotfiles, manifests,
 * lock files, etc. — content that is useful to see as text but isn't code
 * that needs syntax highlighting.
 */
const PLAIN_TEXT_EXTS = new Set([
  ".txt",
  ".log",
  ".out",
  ".err",
  ".conf",
  ".cfg",
  ".ini",
  ".env",
  ".properties",
  ".rc",
  ".lock",
  ".gitignore",
  ".gitattributes",
  ".dockerignore",
  ".editorconfig",
  ".npmrc",
  ".nvmrc",
  ".tool-versions",
  ".pem",
  ".crt",
  ".key",
  ".csr",
  ".cer",
  ".pub",
  ".asc",
  ".diff",
  ".patch",
  ".srt",
  ".vtt",
  ".readme",
  ".license",
  ".changelog",
  ".authors",
  ".contributors",
]);

/**
 * MIME types that map to the archive renderer.
 *
 * Covers ZIP, TAR, and GZ variants.
 */
const ARCHIVE_MIMES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "application/x-tar",
  "application/gzip",
  "application/x-gzip",
  "application/x-tgz",
]);

/**
 * File extensions that map to the archive renderer.
 */
const ARCHIVE_EXTS = new Set([".zip", ".tar", ".gz", ".tgz", ".tar.gz"]);

/**
 * File extensions that map to the tabular renderer.
 */
const TABULAR_EXTS = new Map<string, TableMode>([
  [".csv", "csv"],
  [".ndjson", "ndjson"],
  [".jsonl", "ndjson"],
  [".parquet", "parquet"],
]);

/**
 * File extensions that map to the hex renderer.
 *
 * Covers common binary file types that have no other renderer.
 */
const HEX_EXTS = new Set([
  ".bin",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".wasm",
  ".obj",
  ".o",
  ".a",
  ".lib",
]);

/**
 * Exact MIME types (besides `text/*`) that map to the text/code renderer.
 *
 * JSON, XML, YAML, and similar application/ types contain code that Shiki
 * can highlight.
 */
const TEXT_MIMES = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/toml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/x-python",
  "application/sql",
]);

// ---------------------------------------------------------------------------
// MIME helpers
// ---------------------------------------------------------------------------

/**
 * Returns the TableMode if this MIME/key should go to TablePreview, or `null`
 * otherwise.
 *
 * CSV and NDJSON are detected by MIME type; Parquet by MIME or extension.
 * application/json is handled separately in the router — only top-level arrays
 * go to TablePreview; scalar/object JSON falls through to TextPreview.
 */
function tabularMode(
  mime: string | null | undefined,
  key: string,
): TableMode | null {
  // Extension-based detection (highest specificity for tabular formats).
  const ext = extractExt(key);
  const extMode = TABULAR_EXTS.get(ext);
  if (extMode) return extMode;

  if (!mime) return null;
  const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";

  if (normalized === "text/csv" || normalized === "application/csv")
    return "csv";
  if (
    normalized === "application/x-ndjson" ||
    normalized === "application/jsonl" ||
    normalized === "text/jsonl"
  )
    return "ndjson";
  if (
    normalized === "application/vnd.apache.parquet" ||
    normalized === "application/x-parquet"
  )
    return "parquet";

  // application/json with top-level array detection is handled in the router.
  return null;
}

function isPdfMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (PDF_MIMES.has(normalized)) return true;
  }
  return PDF_EXTS.has(extractExt(key));
}

/**
 * HTML detection — proper renderer (sandboxed iframe). Falls back to
 * extension for octet-stream / missing MIME.
 */
function isHtmlMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (HTML_MIMES.has(normalized)) return true;
  }
  return HTML_EXTS.has(extractExt(key));
}

function isArchiveMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (ARCHIVE_MIMES.has(normalized)) return true;
  }
  // Extension fallback for octet-stream or missing MIME.
  const ext = extractExt(key);
  return ARCHIVE_EXTS.has(ext) || key.toLowerCase().endsWith(".tar.gz");
}

function isHexMime(mime: string | null | undefined, key: string): boolean {
  // Hex viewer for known binary extensions.
  const ext = extractExt(key);
  if (HEX_EXTS.has(ext)) return true;
  // Fallback: octet-stream with no other matching renderer.
  if (!mime) return false;
  const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
  return (
    normalized === "application/octet-stream" &&
    !isArchiveMime(mime, key) &&
    !isTextMime(mime, key)
  );
}

function isMarkdownMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalized === "text/markdown" || normalized === "text/x-markdown") {
      return true;
    }
  }
  const ext = extractExt(key);
  return ext === ".md" || ext === ".markdown";
}

function isVideoMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (VIDEO_MIMES.has(normalized)) return true;
    if (normalized.startsWith("video/")) return true;
  }
  return VIDEO_EXTS.has(extractExt(key));
}

function isAudioMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (AUDIO_MIMES.has(normalized)) return true;
    if (normalized.startsWith("audio/")) return true;
  }
  return AUDIO_EXTS.has(extractExt(key));
}

function isImageMime(mime: string | null | undefined, key: string): boolean {
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (IMAGE_MIMES.has(normalized)) return true;
    if (normalized.startsWith("image/")) return true;
  }
  return IMAGE_EXTS.has(extractExt(key));
}

/**
 * Returns `true` when the MIME type indicates text or code content.
 *
 * Detection layers, from highest to lowest priority:
 *  1. Exact MIME match (`text/*` except markdown/html, or one of TEXT_MIMES).
 *  2. Known code extension (Shiki language map).
 *  3. Known plain-text extension (logs, configs, dotfiles, certs, etc.).
 *  4. Extension-less file with no MIME (READMEs, LICENSE, Makefile, etc.) —
 *     these are almost always text.
 *
 * Excludes: markdown (own renderer), html (own renderer), known-binary
 * extensions (which go to hex).
 */
function isTextMime(mime: string | null | undefined, key: string): boolean {
  const ext = extractExt(key);

  // Excluded — handled by dedicated renderers.
  if (ext === ".md" || ext === ".markdown") return false;
  if (HTML_EXTS.has(ext)) return false;

  // Known-binary extensions never go to text.
  if (HEX_EXTS.has(ext)) return false;

  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalized === "text/markdown" || normalized === "text/x-markdown")
      return false;
    if (HTML_MIMES.has(normalized)) return false;
    if (normalized.startsWith("text/")) return true;
    if (TEXT_MIMES.has(normalized)) return true;
    // octet-stream with a useful extension → treat as text.
    if (normalized === "application/octet-stream") {
      if (extensionToLanguage(ext) !== null) return true;
      if (PLAIN_TEXT_EXTS.has(ext)) return true;
      if (isExtensionLessTextFile(key)) return true;
    }
    return false;
  }

  // No MIME at all — go by extension.
  if (extensionToLanguage(ext) !== null) return true;
  if (PLAIN_TEXT_EXTS.has(ext)) return true;
  if (isExtensionLessTextFile(key)) return true;
  return false;
}

/**
 * Recognise extension-less files that are nearly always text by their
 * basename. Matches case-insensitive: "Dockerfile" / "DOCKERFILE" / "dockerfile"
 * all work.
 */
function isExtensionLessTextFile(key: string): boolean {
  const basename = (key.split("/").pop() ?? "").toLowerCase();
  if (basename.includes(".")) return false;
  return EXTENSIONLESS_TEXT_NAMES.has(basename);
}

const EXTENSIONLESS_TEXT_NAMES = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "authors",
  "contributors",
  "copying",
  "install",
  "notice",
  "manifest",
  "makefile",
  "dockerfile",
  "rakefile",
  "gemfile",
  "procfile",
  "vagrantfile",
  "jenkinsfile",
  "containerfile",
  "brewfile",
  "podfile",
  "todo",
  "version",
]);

/** Extract the file extension from an S3 key (includes the dot). */
function extractExt(key: string): string {
  const basename = key.split("/").pop() ?? key;
  const dot = basename.lastIndexOf(".");
  if (dot === -1 || dot === basename.length - 1) return "";
  return basename.slice(dot);
}

// ---------------------------------------------------------------------------
// PreviewPane
// ---------------------------------------------------------------------------

export function PreviewPane(): React.ReactElement {
  const { panes, activePaneId } = usePanesStore();
  const activePane = panes.find((p) => p.id === activePaneId) ?? panes[0];

  // Derive the first selected key + its location.
  const location = activePane?.location ?? null;
  const firstKey = activePane ? ([...activePane.selection][0] ?? null) : null;

  const profileId = location?.profileId ?? null;
  const bucket = location?.bucket ?? null;

  const {
    data: head,
    isLoading: headLoading,
    isGated,
  } = useObjectHead(profileId, bucket, firstKey);

  // Load settings for the size limit; tolerate missing settings gracefully.
  const { data: settings } = useQuery({
    queryKey: keys.settings(),
    queryFn: settingsGet,
    // Settings may not be available in tests; never block the preview on it.
    retry: false,
  });

  const [previewAnyway, setPreviewAnyway] = useState(false);
  const [editMode, setEditMode] = useState(false);

  // Reset "preview anyway" and edit mode when selection changes.
  // We use a key-based reset in the wrapper instead of an effect for simplicity.

  // ---------------------------------------------------------------------------
  // Empty state — nothing selected
  // ---------------------------------------------------------------------------

  if (!firstKey || !profileId || !bucket) {
    return (
      <section
        aria-label="Preview"
        className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
        data-testid="preview-pane"
      >
        <p className="text-sm">Select a file to preview</p>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Validation gate
  // ---------------------------------------------------------------------------

  if (isGated) {
    return (
      <section
        aria-label="Preview"
        className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground"
        data-testid="preview-pane"
      >
        <p className="text-sm">Validate this profile to preview files</p>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Loading — waiting for HEAD
  // ---------------------------------------------------------------------------

  if (headLoading) {
    return (
      <section
        aria-label="Preview"
        aria-busy="true"
        className="flex h-full flex-col items-center justify-center"
        data-testid="preview-pane"
      >
        <div className="h-8 w-32 animate-pulse rounded bg-muted" />
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // Size-limit check (AC-6)
  // ---------------------------------------------------------------------------

  const limitMb = settings?.previewSizeLimitMb ?? DEFAULT_PREVIEW_LIMIT_MB;
  const limitBytes = limitMb * 1024 * 1024;
  const contentLength = head?.contentLength ?? null;

  if (contentLength !== null && contentLength > limitBytes && !previewAnyway) {
    const sizeMb = (contentLength / 1024 / 1024).toFixed(1);
    return (
      <section
        aria-label="Preview"
        className="flex h-full flex-col items-center justify-center gap-3 p-4 text-center text-muted-foreground"
        data-testid="preview-pane"
      >
        <p className="text-sm">
          File is {sizeMb} MB — above the {limitMb} MB preview limit.
        </p>
        <button
          type="button"
          onClick={() => setPreviewAnyway(true)}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="preview-anyway-btn"
        >
          Preview anyway
        </button>
      </section>
    );
  }

  // ---------------------------------------------------------------------------
  // MIME routing
  // ---------------------------------------------------------------------------

  const mime = head?.contentType ?? null;
  const editable = isEditable(mime, firstKey);

  // When in edit mode for any editable (non-binary) file, render Monaco.
  if (editMode && editable) {
    return (
      <section
        aria-label="Preview"
        className="flex h-full flex-col"
        data-testid="preview-pane"
      >
        <div className="flex items-center justify-end border-b px-2 py-1">
          <button
            type="button"
            onClick={() => setEditMode(false)}
            className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="exit-edit-mode-btn"
          >
            Exit edit mode
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <EditorPreview
            profileId={profileId}
            bucket={bucket}
            objectKey={firstKey}
          />
        </div>
      </section>
    );
  }

  return (
    <section
      aria-label="Preview"
      className="flex h-full flex-col"
      data-testid="preview-pane"
    >
      {editable && (
        <div className="flex items-center justify-end border-b px-2 py-1">
          <button
            type="button"
            onClick={() => setEditMode(true)}
            className="rounded-md border px-2 py-0.5 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="edit-in-monaco-btn"
          >
            Edit in Monaco
          </button>
        </div>
      )}
      {renderContent(profileId, bucket, firstKey, mime)}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Editable detection
// ---------------------------------------------------------------------------

/**
 * Returns true when a file is "text-derived" — anything we can safely round-trip
 * through Monaco as UTF-8 (text, HTML, Markdown, JSON arrays, CSV, NDJSON…).
 * The "Edit in Monaco" button is gated on this so users can edit HTML,
 * Markdown, JSON, etc., not just files routed to TextPreview.
 *
 * Excludes: images, video, audio, PDF, archives, known-binary extensions.
 */
function isEditable(mime: string | null | undefined, key: string): boolean {
  if (isImageMime(mime, key)) return false;
  if (isVideoMime(mime, key)) return false;
  if (isAudioMime(mime, key)) return false;
  if (isPdfMime(mime, key)) return false;
  if (isArchiveMime(mime, key)) return false;
  if (isHexMime(mime, key)) return false;

  // Text-derived: plain text, code, HTML, Markdown, JSON, CSV, NDJSON.
  if (isTextMime(mime, key)) return true;
  if (isHtmlMime(mime, key)) return true;
  if (isMarkdownMime(mime, key)) return true;
  if (tabularMode(mime, key) !== null) return true;
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalized === "application/json") return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Content router — pure, no hooks
// ---------------------------------------------------------------------------

function renderContent(
  profileId: string,
  bucket: string,
  key: string,
  mime: string | null,
): React.ReactElement {
  if (isImageMime(mime, key)) {
    return (
      <ImagePreview profileId={profileId} bucket={bucket} objectKey={key} />
    );
  }

  if (isVideoMime(mime, key)) {
    return (
      <MediaPreview
        profileId={profileId}
        bucket={bucket}
        objectKey={key}
        kind={"video" as MediaKind}
      />
    );
  }

  if (isAudioMime(mime, key)) {
    return (
      <MediaPreview
        profileId={profileId}
        bucket={bucket}
        objectKey={key}
        kind={"audio" as MediaKind}
      />
    );
  }

  if (isPdfMime(mime, key)) {
    return <PdfPreview profileId={profileId} bucket={bucket} objectKey={key} />;
  }

  if (isHtmlMime(mime, key)) {
    return (
      <HtmlPreview profileId={profileId} bucket={bucket} objectKey={key} />
    );
  }

  if (isMarkdownMime(mime, key)) {
    return (
      <MarkdownPreview profileId={profileId} bucket={bucket} objectKey={key} />
    );
  }

  if (isArchiveMime(mime, key)) {
    return (
      <ArchivePreview profileId={profileId} bucket={bucket} objectKey={key} />
    );
  }

  // Tabular formats: CSV, NDJSON, Parquet (by MIME or extension).
  const tableMode = tabularMode(mime, key);
  if (tableMode) {
    return (
      <TablePreview
        profileId={profileId}
        bucket={bucket}
        objectKey={key}
        mode={tableMode}
      />
    );
  }

  // application/json with top-level array → TablePreview (json mode).
  // Non-array JSON falls through to TextPreview via the worker returning empty
  // headers, which renders "no tabular data found" — the spec calls this
  // "falls through to TextPreview" but we show a clear empty state instead
  // since we cannot determine the shape without fetching the body here.
  if (mime) {
    const normalized = mime.toLowerCase().split(";")[0]?.trim() ?? "";
    if (normalized === "application/json") {
      return (
        <TablePreview
          profileId={profileId}
          bucket={bucket}
          objectKey={key}
          mode="json"
        />
      );
    }
  }

  if (isTextMime(mime, key)) {
    return (
      <TextPreview profileId={profileId} bucket={bucket} objectKey={key} />
    );
  }

  if (isHexMime(mime, key)) {
    return <HexPreview profileId={profileId} bucket={bucket} objectKey={key} />;
  }

  // Last-resort fallback: nothing matched, the extension is not on the
  // known-binary list, and we have no specific renderer. Try text — the
  // backend's UTF-8 decode replaces invalid bytes with U+FFFD, so users
  // at least see *something* and can switch to hex if it looks like noise.
  return <TextPreview profileId={profileId} bucket={bucket} objectKey={key} />;
}
