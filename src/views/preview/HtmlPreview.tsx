/**
 * HtmlPreview — renders an S3 HTML/XHTML file inside a sandboxed iframe.
 *
 * Lifecycle:
 *  1. Mount: fetch the body via `objectGetText` (first 1 MB).
 *  2. Render: `<iframe sandbox="" srcDoc={body}>` — no scripts, no same-origin,
 *     no top navigation. CSS and inline content render normally; relative
 *     resource references (img/link to other S3 keys) do not resolve, because
 *     srcdoc iframes have no base URL inside this app.
 *  3. Toggle: "View source" switches to the syntax-highlighted code view,
 *     mounted inline as `TextPreview` for the same key.
 *
 * Security:
 *  `sandbox=""` (empty attribute list) is the safest possible iframe sandbox:
 *  blocks scripts, blocks same-origin access, blocks form submission, blocks
 *  popups, blocks top navigation. The rendered HTML cannot read app state,
 *  cookies, or local storage; nor can it talk to S3 or anything else.
 *
 * OCP: this component is a simple shell over a sandboxed iframe + a toggle.
 * Adding richer HTML features (e.g. resolving relative S3 links) is a future
 * task that involves a different fetch strategy (loopback server with
 * base-URL rewriting) and stays scoped to this file.
 */

import { useEffect, useState } from "react";
import { objectGetText } from "@/api/objects";
import { TextPreview } from "./TextPreview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HtmlPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// HtmlPreview
// ---------------------------------------------------------------------------

export function HtmlPreview({
  profileId,
  bucket,
  objectKey,
}: HtmlPreviewProps): React.ReactElement {
  const [body, setBody] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [viewSource, setViewSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setBody(null);
    setLoadError(null);
    setTruncated(false);

    objectGetText(profileId, bucket, objectKey)
      .then((payload) => {
        if (cancelled) return;
        setBody(payload.body);
        setTruncated(payload.truncated);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load HTML",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, bucket, objectKey]);

  // ---------------------------------------------------------------------------
  // Render — single tree with a segmented toggle. Both modes share the same
  // toolbar so the user can flip between them without losing context.
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col" data-testid="html-preview">
      <div className="flex items-center justify-between gap-2 border-b px-2 py-1">
        <ViewModeToggle viewSource={viewSource} onChange={setViewSource} />
        {truncated && (
          <span
            className="text-[10px] uppercase tracking-wide text-yellow-700 dark:text-yellow-300"
            title="File is large — only the first 1 MB is rendered."
            data-testid="html-truncated-banner"
          >
            Truncated
          </span>
        )}
      </div>

      {/* View-source path delegates to TextPreview so the user gets Shiki
          highlighting with the same data semantics as any other text file. */}
      {viewSource ? (
        <div className="min-h-0 flex-1" data-testid="html-source-view">
          <TextPreview
            profileId={profileId}
            bucket={bucket}
            objectKey={objectKey}
          />
        </div>
      ) : (
        <>
          {body === null && !loadError && (
            <div
              role="status"
              aria-label="Loading HTML"
              className="flex flex-1 flex-col gap-2 p-4"
              data-testid="html-loading-skeleton"
            >
              <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
              <div className="h-4 w-5/6 animate-pulse rounded bg-muted" />
            </div>
          )}

          {loadError && (
            <div
              role="alert"
              className="flex flex-1 items-center justify-center p-4"
              data-testid="html-error"
            >
              <p className="text-sm text-destructive">{loadError}</p>
            </div>
          )}

          {body !== null && !loadError && (
            <iframe
              title={`HTML preview: ${objectKey}`}
              srcDoc={body}
              sandbox=""
              className="min-h-0 flex-1 border-0 bg-white"
              data-testid="html-iframe"
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Segmented two-state toggle: "Rendered" | "Source". Both options always
 * visible — the active one is highlighted. Clearer than a single button
 * that swaps label, because the user can see both destinations at once.
 */
function ViewModeToggle({
  viewSource,
  onChange,
}: {
  viewSource: boolean;
  onChange: (next: boolean) => void;
}): React.ReactElement {
  return (
    <div
      role="tablist"
      aria-label="HTML view mode"
      className="inline-flex overflow-hidden rounded-md border border-border text-xs"
    >
      <button
        type="button"
        role="tab"
        aria-selected={!viewSource}
        onClick={() => onChange(false)}
        className={`px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          !viewSource
            ? "bg-accent text-accent-foreground"
            : "hover:bg-accent/50"
        }`}
        data-testid="html-render-btn"
      >
        Rendered
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={viewSource}
        onClick={() => onChange(true)}
        className={`border-l border-border px-2 py-0.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          viewSource ? "bg-accent text-accent-foreground" : "hover:bg-accent/50"
        }`}
        data-testid="html-source-btn"
      >
        Source
      </button>
    </div>
  );
}
