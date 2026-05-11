/**
 * PdfPreview — renders an S3 PDF via the loopback media server.
 *
 * Lifecycle:
 *  1. Mount: call `mediaRegister(profileId, bucket, key)` to mint a signed
 *     session token; the backend returns a loopback URL (same pattern as
 *     ImagePreview/MediaPreview).
 *  2. Render: react-pdf Document + Page components pointing at the loopback URL.
 *  3. Unmount: call `mediaRevoke(token)` to free the token (AC-6).
 *
 * Navigation: prev/next buttons + "Page X of Y" indicator.
 * Zoom: percentage-based scale with +/- buttons (0.5x – 3x range).
 * Keyboard: PageUp/PageDown for page navigation while the viewer is focused.
 *
 * OCP: token lifecycle (mint/revoke) mirrors ImagePreview — same pattern,
 * different renderer.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Document, Page, pdfjs } from "react-pdf";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { mediaRegister, mediaRevoke } from "@/api/media";

// ---------------------------------------------------------------------------
// Configure PDF.js worker (required by react-pdf v7+)
// ---------------------------------------------------------------------------

// We ship the PDF.js worker as a static asset under public/. Two reasons:
//
// 1. The previous `new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url)`
//    form failed in the Tauri WebView with "Setting up fake worker failed:
//    Importing a module script failed." because the resolved URL pointed
//    inside node_modules and the WebView refused to load it as a module
//    worker.
// 2. The Vite-native `?url` import alternative breaks vitest, which doesn't
//    resolve the `?url` suffix the same way the dev server does.
//
// A static asset under `public/` is served from `/` in both dev and
// production builds, works inside the Tauri WebView, and stays out of the
// test resolver entirely. `scripts/sync-pdf-worker.mjs` runs in postinstall
// to keep the file aligned with the installed pdfjs-dist version.
pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PdfPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MIN_SCALE = 0.5;
const MAX_SCALE = 3.0;
const SCALE_STEP = 0.25;
const DEFAULT_SCALE = 1.0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the token string from a loopback URL of the form
 * `http://127.0.0.1:<port>/m/<token>`.
 */
function extractToken(url: string): string | null {
  const parts = url.split("/m/");
  return parts.length >= 2 ? (parts[1]?.split("?")[0] ?? null) : null;
}

// ---------------------------------------------------------------------------
// PdfPreview
// ---------------------------------------------------------------------------

export function PdfPreview({
  profileId,
  bucket,
  objectKey,
}: PdfPreviewProps): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [numPages, setNumPages] = useState<number | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [scale, setScale] = useState(DEFAULT_SCALE);

  const tokenRef = useRef<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Register media token on mount; revoke on unmount.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let revoked = false;
    setUrl(null);
    setLoadError(null);
    setNumPages(null);
    setCurrentPage(1);
    setScale(DEFAULT_SCALE);

    mediaRegister(profileId, bucket, objectKey)
      .then(({ url: mediaUrl }) => {
        if (revoked) {
          const tok = extractToken(mediaUrl);
          if (tok) {
            mediaRevoke(tok).catch(() => {});
          }
          return;
        }
        tokenRef.current = extractToken(mediaUrl);
        setUrl(mediaUrl);
      })
      .catch((err: unknown) => {
        if (!revoked) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load PDF",
          );
        }
      });

    return () => {
      revoked = true;
      const tok = tokenRef.current;
      if (tok) {
        tokenRef.current = null;
        mediaRevoke(tok).catch(() => {});
      }
    };
  }, [profileId, bucket, objectKey]);

  // ---------------------------------------------------------------------------
  // Keyboard navigation (PageUp / PageDown) while container is focused.
  // ---------------------------------------------------------------------------

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "PageDown") {
        e.preventDefault();
        setCurrentPage((p) => Math.min(p + 1, numPages ?? p));
      } else if (e.key === "PageUp") {
        e.preventDefault();
        setCurrentPage((p) => Math.max(p - 1, 1));
      }
    },
    [numPages],
  );

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  const handleDocumentLoadSuccess = useCallback(
    ({ numPages: n }: { numPages: number }) => {
      setNumPages(n);
    },
    [],
  );

  const handleDocumentLoadError = useCallback((err: Error) => {
    setLoadError(err.message ?? "Failed to load PDF");
  }, []);

  const goToPrevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(p - 1, 1));
  }, []);

  const goToNextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(p + 1, numPages ?? p));
  }, [numPages]);

  const zoomIn = useCallback(() => {
    setScale((s) => Math.min(+(s + SCALE_STEP).toFixed(2), MAX_SCALE));
  }, []);

  const zoomOut = useCallback(() => {
    setScale((s) => Math.max(+(s - SCALE_STEP).toFixed(2), MIN_SCALE));
  }, []);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      ref={containerRef}
      role="application"
      className="flex h-full flex-col focus:outline-none"
      data-testid="pdf-preview"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: role="application" makes this an interactive widget; tabIndex enables keyboard navigation (PageUp/PageDown)
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label={`PDF preview: ${objectKey}`}
    >
      {/* Loading state */}
      {!url && !loadError && (
        <div
          role="status"
          aria-label="Loading PDF"
          className="flex flex-1 items-center justify-center"
          data-testid="pdf-loading-skeleton"
        >
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        </div>
      )}

      {/* Error slot */}
      {loadError && (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-4"
          data-testid="pdf-error"
        >
          <p className="text-sm text-destructive">{loadError}</p>
        </div>
      )}

      {/* PDF viewer */}
      {url && !loadError && (
        <>
          {/* Toolbar */}
          <div className="flex items-center justify-between border-b px-3 py-1.5 text-sm">
            {/* Page navigation */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={goToPrevPage}
                disabled={currentPage <= 1}
                className="rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Previous page"
                data-testid="pdf-prev-page"
              >
                ‹
              </button>
              <span
                className="text-xs text-muted-foreground"
                data-testid="pdf-page-indicator"
                aria-live="polite"
              >
                Page {currentPage} of {numPages ?? "?"}
              </span>
              <button
                type="button"
                onClick={goToNextPage}
                disabled={numPages !== null && currentPage >= numPages}
                className="rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Next page"
                data-testid="pdf-next-page"
              >
                ›
              </button>
            </div>

            {/* Zoom controls */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={zoomOut}
                disabled={scale <= MIN_SCALE}
                className="rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Zoom out"
                data-testid="pdf-zoom-out"
              >
                −
              </button>
              <span
                className="w-12 text-center text-xs text-muted-foreground"
                data-testid="pdf-zoom-level"
              >
                {Math.round(scale * 100)}%
              </span>
              <button
                type="button"
                onClick={zoomIn}
                disabled={scale >= MAX_SCALE}
                className="rounded px-2 py-1 text-xs hover:bg-accent disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="Zoom in"
                data-testid="pdf-zoom-in"
              >
                +
              </button>
            </div>
          </div>

          {/* Document */}
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <Document
              file={url}
              onLoadSuccess={handleDocumentLoadSuccess}
              onLoadError={handleDocumentLoadError}
              loading={
                <div
                  role="status"
                  aria-label="Loading PDF document"
                  className="h-48 w-full animate-pulse rounded bg-muted"
                />
              }
            >
              <Page
                pageNumber={currentPage}
                scale={scale}
                renderAnnotationLayer
                renderTextLayer
              />
            </Document>
          </div>
        </>
      )}
    </div>
  );
}
