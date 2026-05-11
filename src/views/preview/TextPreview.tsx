/**
 * TextPreview — syntax-highlighted code/text renderer.
 *
 * Lifecycle:
 *  1. Mount: fetch the object body via `objectGetText` (first 1 MB).
 *  2. Determine language via `extensionToLanguage(extractExt(key))`.
 *  3. If a language is matched: lazy-load Shiki + the grammar, render
 *     highlighted HTML via `dangerouslySetInnerHTML`.
 *  4. If no language match: render plain `<pre>` with no highlighting.
 *  5. Show a loading skeleton while Shiki is initialising.
 *  6. Truncation banner when the backend signals `truncated = true`.
 *
 * Theme follows `useUiStore().theme`.
 *
 * OCP:
 * - Language dispatch lives in `extensionToLanguage` — adding new extensions
 *   touches only that map.
 * - Shiki theme selection is a single ternary on `uiTheme`.
 * - Backend payload shape is `TextPayload` — fields can be added without
 *   breaking this component.
 */

import { useEffect, useState } from "react";
import type { TextPayload } from "@/api/objects";
import { objectGetText } from "@/api/objects";
import { extensionToLanguage, highlight } from "@/lib/shiki";
import { useUiStore } from "@/store/ui";
import { TextPreviewSettings } from "./TextPreviewSettings";

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Handles both standard `Error` instances and `AppError`-shaped IPC errors
 * (objects with a `message: string` field).
 */
function extractMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message;
  if (
    typeof err === "object" &&
    err !== null &&
    "message" in err &&
    typeof (err as Record<string, unknown>).message === "string"
  ) {
    return (err as { message: string }).message;
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TextPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the file extension from an S3 key (includes the dot). */
function extractExt(key: string): string {
  const basename = key.split("/").pop() ?? key;
  const dot = basename.lastIndexOf(".");
  if (dot === -1 || dot === basename.length - 1) return "";
  return basename.slice(dot);
}

// ---------------------------------------------------------------------------
// TextPreview
// ---------------------------------------------------------------------------

export function TextPreview({
  profileId,
  bucket,
  objectKey,
}: TextPreviewProps): React.ReactElement {
  const uiTheme = useUiStore((s) => s.theme);
  const prefs = useUiStore((s) => s.textPreviewPrefs);

  // Resolve effective theme: explicit per-preview override wins, otherwise
  // follow the global setting. The global "system" value collapses to
  // "light" by current convention — matches the rest of the app.
  const shikiTheme: "light" | "dark" =
    prefs.themeOverride === "light"
      ? "light"
      : prefs.themeOverride === "dark"
        ? "dark"
        : uiTheme === "dark"
          ? "dark"
          : "light";

  const [payload, setPayload] = useState<TextPayload | null>(null);
  const [highlightedHtml, setHighlightedHtml] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // ---------------------------------------------------------------------------
  // Fetch text body
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setHighlightedHtml(null);
    setLoadError(null);
    setIsLoading(true);

    objectGetText(profileId, bucket, objectKey)
      .then(async (p) => {
        if (cancelled) return;
        setPayload(p);

        const ext = extractExt(objectKey);
        const lang = extensionToLanguage(ext);

        if (lang) {
          try {
            const html = await highlight(p.body, lang, shikiTheme);
            if (!cancelled) {
              setHighlightedHtml(html);
            }
          } catch {
            // Shiki failed — fall back to plain text; don't surface as error.
            if (!cancelled) {
              setHighlightedHtml(null);
            }
          }
        } else {
          if (!cancelled) {
            setHighlightedHtml(null);
          }
        }

        if (!cancelled) {
          setIsLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(extractMessage(err, "Failed to load file"));
          setIsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, bucket, objectKey, shikiTheme]);

  // ---------------------------------------------------------------------------
  // Loading skeleton
  // ---------------------------------------------------------------------------

  if (isLoading) {
    return (
      <div
        className="flex h-full flex-col gap-2 p-4"
        data-testid="text-preview-loading"
      >
        <div
          role="status"
          aria-label="Loading file"
          className="h-4 w-3/4 animate-pulse rounded bg-muted"
        />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------

  if (loadError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center p-4"
        data-testid="text-preview-error"
      >
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Truncation banner
  // ---------------------------------------------------------------------------

  const truncationBanner = payload?.truncated ? (
    <div
      className="border-b bg-yellow-50 px-4 py-1 text-xs text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
      role="note"
      aria-label="File truncated"
      data-testid="text-preview-truncated"
    >
      File is large — showing first 1 MB only.
    </div>
  ) : null;

  // ---------------------------------------------------------------------------
  // Settings toolbar — shared across the highlighted and plain-text paths so
  // the user always has access to the prefs popover regardless of whether the
  // grammar loaded.
  // ---------------------------------------------------------------------------

  const toolbar = (
    <div className="flex items-center justify-end border-b border-border/60 px-2 py-1">
      <TextPreviewSettings variant="viewer" />
    </div>
  );

  // Inline style derived from the prefs. CSS variables would be tidier but
  // adding one-off variables to the global stylesheet for two declarations
  // is not worth the indirection.
  const textBodyStyle: React.CSSProperties = {
    fontSize: `${prefs.fontSize}px`,
    // Shiki produces `<pre>` with default white-space; we override on the
    // wrapping div so both the highlighted and plain paths share behaviour.
    whiteSpace: prefs.wordWrap ? "pre-wrap" : "pre",
    wordBreak: prefs.wordWrap ? "break-word" : "normal",
  };

  // ---------------------------------------------------------------------------
  // Highlighted HTML path
  // ---------------------------------------------------------------------------

  if (highlightedHtml) {
    return (
      <div
        className="flex h-full flex-col overflow-hidden"
        data-testid="text-preview"
      >
        {toolbar}
        {truncationBanner}
        <div
          className="h-full overflow-auto p-4 [&_pre]:m-0 [&_pre]:h-full [&_pre]:font-mono"
          style={textBodyStyle}
          // biome-ignore lint/security/noDangerouslySetInnerHtml: Shiki output is sanitized HTML
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          data-testid="text-preview-highlighted"
        />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Plain text fallback
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="text-preview"
    >
      {toolbar}
      {truncationBanner}
      <pre
        className="h-full overflow-auto p-4 font-mono"
        style={textBodyStyle}
        data-testid="text-preview-plain"
      >
        {payload?.body ?? ""}
      </pre>
    </div>
  );
}
