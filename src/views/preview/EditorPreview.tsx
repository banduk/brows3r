/**
 * EditorPreview — Monaco-based text editor for S3 objects.
 *
 * Lifecycle:
 *  1. Mount: fetch object body + ETag via `objectGetText`.
 *  2. Render Monaco editor (lazy-loaded via React.lazy / dynamic import so the
 *     chunk is never part of the initial bundle — confirmed by vite.config.ts
 *     manualChunks).
 *  3. Save (Cmd/Ctrl+S or toolbar button):
 *     a. Call `objectPutText(profileId, bucket, key, body, ifMatchEtag)`.
 *     b. On success: clear dirty state, update stored ETag from result.
 *     c. On `AppError { kind: "Conflict" }`: surface inline conflict UI per AC-7.
 *  4. Conflict UI: "File changed externally. [Refresh] [Save anyway]"
 *     - Refresh: re-fetches the body (clears conflict state, resets dirty).
 *     - Save anyway: calls `objectPutText` without `ifMatchEtag`.
 *
 * Theme follows `useUiStore().theme`.
 *
 * Auto-save is off; manual save only.
 *
 * OCP:
 * - Conflict handling is fully self-contained in this component; any future
 *   save flows can reuse the same pattern.
 * - Monaco chunk isolation via manualChunks means no other file needs to change
 *   to keep the initial bundle lean.
 * - Backend ETag precondition logic lives in `objectPutText`; this component
 *   only passes it through.
 */

import Editor from "@monaco-editor/react";
import {
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { PutResult } from "@/api/objects";
import { objectGetText, objectPutText } from "@/api/objects";
import { useUiStore } from "@/store/ui";
import { TextPreviewSettings } from "./TextPreviewSettings";

// ---------------------------------------------------------------------------
// Lazy wrapper — Monaco is the Editor import but we still wrap the whole
// component in a lazy boundary so the entire chunk loads on demand.
// ---------------------------------------------------------------------------

// The actual Monaco Editor is already lazy inside @monaco-editor/react.
// We wrap EditorPreviewInner in React.lazy too so the chunk is split at the
// module boundary and the initial bundle never touches monaco-editor.
const LazyEditorPreviewInner = lazy(() =>
  import("./EditorPreviewInner").then((mod) => ({
    default: mod.EditorPreviewInner,
  })),
);

// ---------------------------------------------------------------------------
// AppError shape (IPC envelope)
// ---------------------------------------------------------------------------

interface AppError {
  kind: string;
  message: string;
  retryable: boolean;
  details?: {
    etagExpected?: string;
    etagActual?: string | null;
  };
}

function isConflict(err: unknown): err is AppError {
  return (
    typeof err === "object" &&
    err !== null &&
    "kind" in err &&
    (err as AppError).kind === "Conflict"
  );
}

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

export interface EditorPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// EditorPreview — public entry point (suspense boundary)
// ---------------------------------------------------------------------------

export function EditorPreview(props: EditorPreviewProps): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div
          className="flex h-full flex-col gap-2 p-4"
          data-testid="editor-preview-loading"
        >
          <div
            role="status"
            aria-label="Loading editor"
            className="h-4 w-3/4 animate-pulse rounded bg-muted"
          />
          <div className="h-4 w-full animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      }
    >
      <LazyEditorPreviewInner {...props} />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// EditorPreviewInner — implementation (in same file for simplicity)
// This is also exported from EditorPreviewInner.tsx for the lazy split.
// ---------------------------------------------------------------------------

// We export EditorPreviewCoreImpl directly so tests can import without the
// Suspense boundary when they don't need it.
export function EditorPreviewCoreImpl({
  profileId,
  bucket,
  objectKey,
}: EditorPreviewProps): React.ReactElement {
  const uiTheme = useUiStore((s) => s.theme);
  const prefs = useUiStore((s) => s.textPreviewPrefs);

  // Resolve the Monaco theme: explicit override wins, otherwise follow the
  // global UI theme.
  const resolvedTheme: "light" | "dark" =
    prefs.themeOverride === "light"
      ? "light"
      : prefs.themeOverride === "dark"
        ? "dark"
        : uiTheme === "dark"
          ? "dark"
          : "light";
  const monacoTheme = resolvedTheme === "dark" ? "vs-dark" : "light";

  // ---------- state ----------
  const [body, setBody] = useState<string | null>(null);
  const [currentEtag, setCurrentEtag] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflictState, setConflictState] = useState<{
    etagExpected: string;
    bodyToSave: string;
  } | null>(null);

  // Ref so the save handler always sees the latest body without re-registering.
  const bodyRef = useRef<string>("");

  // ---------- load ----------
  const loadContent = useCallback(
    async (cancelled?: { current: boolean }) => {
      setIsLoading(true);
      setLoadError(null);
      setIsDirty(false);
      setConflictState(null);
      setSaveError(null);

      try {
        const payload = await objectGetText(profileId, bucket, objectKey);
        if (cancelled?.current) return;
        setBody(payload.body);
        bodyRef.current = payload.body;
        setCurrentEtag(payload.etag ?? null);
      } catch (err) {
        if (!cancelled?.current) {
          setLoadError(extractMessage(err, "Failed to load file"));
        }
      } finally {
        if (!cancelled?.current) setIsLoading(false);
      }
    },
    [profileId, bucket, objectKey],
  );

  useEffect(() => {
    const cancelled = { current: false };
    loadContent(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [loadContent]);

  // ---------- save ----------
  const doSave = useCallback(
    async (saveBody: string, withEtag: string | null) => {
      setIsSaving(true);
      setSaveError(null);

      try {
        const result: PutResult = await objectPutText(
          profileId,
          bucket,
          objectKey,
          saveBody,
          withEtag ?? undefined,
        );
        setIsDirty(false);
        setConflictState(null);
        // Update our local ETag from the response so the next save is accurate.
        if (result.etag) {
          setCurrentEtag(result.etag);
        }
      } catch (err) {
        if (isConflict(err)) {
          setConflictState({
            etagExpected:
              (err as AppError).details?.etagExpected ?? withEtag ?? "",
            bodyToSave: saveBody,
          });
        } else {
          setSaveError(extractMessage(err, "Save failed"));
        }
      } finally {
        setIsSaving(false);
      }
    },
    [profileId, bucket, objectKey],
  );

  const handleSave = useCallback(() => {
    doSave(bodyRef.current, currentEtag);
  }, [doSave, currentEtag]);

  // Cmd/Ctrl+S keyboard shortcut on the wrapping div.
  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSave();
      }
    },
    [handleSave],
  );

  // ---------- conflict actions ----------
  const handleRefresh = useCallback(() => {
    loadContent();
  }, [loadContent]);

  const handleSaveAnyway = useCallback(() => {
    if (!conflictState) return;
    doSave(conflictState.bodyToSave, null);
  }, [conflictState, doSave]);

  // ---------- loading ----------
  if (isLoading) {
    return (
      <div
        className="flex h-full flex-col gap-2 p-4"
        data-testid="editor-preview-loading"
      >
        <div
          role="status"
          aria-label="Loading editor"
          className="h-4 w-3/4 animate-pulse rounded bg-muted"
        />
        <div className="h-4 w-full animate-pulse rounded bg-muted" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  // ---------- load error ----------
  if (loadError) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center p-4"
        data-testid="editor-preview-error"
      >
        <p role="alert" className="text-sm text-destructive">
          {loadError}
        </p>
      </div>
    );
  }

  // ---------- title with dirty indicator ----------
  const titleText = isDirty ? `Editing (unsaved changes)` : `Editing`;

  return (
    <section
      aria-label={titleText}
      className="flex h-full flex-col"
      data-testid="editor-preview"
      onKeyDown={handleKeyDown}
    >
      {/* Toolbar */}
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5"
        data-testid="editor-toolbar"
      >
        <span className="flex-1 text-xs text-muted-foreground">
          {titleText}
        </span>
        <TextPreviewSettings variant="editor" />
        <button
          type="button"
          disabled={!isDirty || isSaving}
          onClick={handleSave}
          className="rounded-md border px-3 py-1 text-xs hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          data-testid="editor-save-btn"
          aria-label={isSaving ? "Saving…" : "Save (Ctrl+S / Cmd+S)"}
        >
          {isSaving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* Conflict banner (AC-7) */}
      {conflictState && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b bg-yellow-50 px-3 py-2 text-xs text-yellow-900 dark:bg-yellow-950 dark:text-yellow-200"
          data-testid="editor-conflict-banner"
        >
          <span className="flex-1">File changed externally.</span>
          <button
            type="button"
            onClick={handleRefresh}
            className="rounded border px-2 py-0.5 hover:bg-yellow-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-yellow-900"
            data-testid="editor-conflict-refresh"
          >
            Refresh
          </button>
          <button
            type="button"
            onClick={handleSaveAnyway}
            className="rounded border px-2 py-0.5 hover:bg-yellow-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:hover:bg-yellow-900"
            data-testid="editor-conflict-save-anyway"
          >
            Save anyway
          </button>
        </div>
      )}

      {/* Save error */}
      {saveError && (
        <div
          role="alert"
          className="border-b bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
          data-testid="editor-save-error"
        >
          {saveError}
        </div>
      )}

      {/* Monaco editor */}
      <div className="min-h-0 flex-1" data-testid="monaco-container">
        <Editor
          height="100%"
          defaultValue={body ?? ""}
          theme={monacoTheme}
          options={{
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: prefs.wordWrap ? "on" : "off",
            fontSize: prefs.fontSize,
            lineNumbers: prefs.lineNumbers ? "on" : "off",
            automaticLayout: true,
          }}
          onChange={(value) => {
            const newVal = value ?? "";
            bodyRef.current = newVal;
            if (!isDirty && newVal !== body) {
              setIsDirty(true);
            }
          }}
        />
      </div>
    </section>
  );
}
