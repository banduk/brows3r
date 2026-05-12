/**
 * TextPreview — Monaco-based read-only viewer for text/code objects.
 *
 * Previously used Shiki + a `<pre>` block, but Shiki's inner `<pre>` overrode
 * the wrap CSS on the wrapper and word-wrap silently failed. Monaco renders
 * its own scroller and exposes a reliable `wordWrap` option.
 *
 * Lifecycle:
 *  1. Mount: fetch body via `objectGetText` (backend caps at 1 MB).
 *  2. Derive language via `keyToMonacoLanguage(objectKey)`.
 *  3. Render Monaco in `readOnly: true` mode.
 *  4. Truncation banner when the backend signals `truncated = true`.
 *
 * Theme follows `useUiStore().theme` with a per-preview override.
 *
 * OCP:
 *  - Language map lives in `lib/monaco-lang.ts`.
 *  - Prefs (wordWrap / fontSize / lineNumbers / theme override) live in
 *    `useUiStore().textPreviewPrefs` and are wired straight into Monaco.
 */

import Editor from "@monaco-editor/react";
import { lazy, Suspense, useEffect, useState } from "react";
import type { TextPayload } from "@/api/objects";
import { objectGetText } from "@/api/objects";
import { keyToMonacoLanguage } from "@/lib/monaco-lang";
import { useUiStore } from "@/store/ui";
import { TextPreviewSettings } from "./TextPreviewSettings";

// ---------------------------------------------------------------------------
// Lazy boundary so the Monaco chunk only loads when a text preview is opened.
// ---------------------------------------------------------------------------

const LazyTextPreviewInner = lazy(() =>
  import("./TextPreviewInner").then((mod) => ({
    default: mod.TextPreviewInner,
  })),
);

// ---------------------------------------------------------------------------
// Error message extraction
// ---------------------------------------------------------------------------

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
// TextPreview — public entry (Suspense boundary)
// ---------------------------------------------------------------------------

export function TextPreview(props: TextPreviewProps): React.ReactElement {
  return (
    <Suspense
      fallback={
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
      }
    >
      <LazyTextPreviewInner {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// TextPreviewCoreImpl — implementation. Exported via TextPreviewInner.tsx
// for the lazy-split chunk; tests can import directly when they don't need
// the Suspense boundary.
// ---------------------------------------------------------------------------

export function TextPreviewCoreImpl({
  profileId,
  bucket,
  objectKey,
}: TextPreviewProps): React.ReactElement {
  const uiTheme = useUiStore((s) => s.theme);
  const prefs = useUiStore((s) => s.textPreviewPrefs);

  const resolvedTheme: "light" | "dark" =
    prefs.themeOverride === "light"
      ? "light"
      : prefs.themeOverride === "dark"
        ? "dark"
        : uiTheme === "dark"
          ? "dark"
          : "light";
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  const [payload, setPayload] = useState<TextPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setPayload(null);
    setLoadError(null);
    setIsLoading(true);

    objectGetText(profileId, bucket, objectKey)
      .then((p) => {
        if (cancelled) return;
        setPayload(p);
        setIsLoading(false);
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
  }, [profileId, bucket, objectKey]);

  // ---------- loading skeleton ----------
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

  // ---------- error ----------
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

  const language = keyToMonacoLanguage(objectKey);

  return (
    <div
      className="flex h-full flex-col overflow-hidden"
      data-testid="text-preview"
    >
      <div className="flex items-center justify-end border-b border-border/60 px-2 py-1">
        <TextPreviewSettings variant="viewer" />
      </div>
      {payload?.truncated && (
        <div
          className="border-b bg-yellow-50 px-4 py-1 text-xs text-yellow-800 dark:bg-yellow-950 dark:text-yellow-200"
          role="note"
          aria-label="File truncated"
          data-testid="text-preview-truncated"
        >
          File is large — showing first 1 MB only.
        </div>
      )}
      <div className="min-h-0 flex-1" data-testid="text-preview-monaco">
        <Editor
          height="100%"
          value={payload?.body ?? ""}
          language={language}
          theme={monacoTheme}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: prefs.wordWrap ? "on" : "off",
            fontSize: prefs.fontSize,
            lineNumbers: prefs.lineNumbers ? "on" : "off",
            automaticLayout: true,
            renderWhitespace: "selection",
            contextmenu: false,
          }}
        />
      </div>
    </div>
  );
}
