/**
 * ImagePreview — renders an S3 image via the loopback media server.
 *
 * Lifecycle:
 *  1. Mount: call `mediaRegister(profileId, bucket, key)` to mint a signed
 *     session token; the backend returns a loopback URL.
 *  2. Render: `<img src={url} />` — the WebView fetches the bytes directly
 *     from the local server; S3 bytes never cross the IPC boundary.
 *  3. Unmount: call `mediaRevoke(token)` to free the token (AC-6).
 *
 * Loading skeleton: shown while the media URL is being fetched or the image
 * is loading.
 *
 * Error slot: when `<img>` fires `onError`, or when `mediaRegister` rejects,
 * an inline error message is rendered.
 *
 * Image transforms:
 *  - Default: `object-contain` (fit-to-window) with `max-h` constraint.
 *  - 1:1 toggle: removes the size constraint so the image renders at native
 *    pixel dimensions, with scroll overflow.
 *
 * OCP: media token lifecycle (mint/revoke) is abstracted here — future renderers
 * (video, audio) follow the same pattern in their own components.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaRegister, mediaRevoke } from "@/api/media";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImagePreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

// ---------------------------------------------------------------------------
// ImagePreview
// ---------------------------------------------------------------------------

export function ImagePreview({
  profileId,
  bucket,
  objectKey,
}: ImagePreviewProps): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [nativeSize, setNativeSize] = useState(false);

  // Keep a ref so the cleanup closure always sees the latest token, even if
  // state batching delays the update.
  const tokenRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Register on mount; revoke on unmount.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let revoked = false;
    setUrl(null);
    setLoadError(null);
    setImageLoaded(false);

    mediaRegister(profileId, bucket, objectKey)
      .then(({ url: mediaUrl }) => {
        if (revoked) {
          // Component already unmounted — extract token and revoke immediately.
          const tok = extractToken(mediaUrl);
          if (tok) {
            mediaRevoke(tok).catch(() => {});
          }
          return;
        }
        const tok = extractToken(mediaUrl);
        tokenRef.current = tok;
        setUrl(mediaUrl);
      })
      .catch((err: unknown) => {
        if (!revoked) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load image",
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
  // Handlers
  // ---------------------------------------------------------------------------

  const handleImgError = useCallback(() => {
    setLoadError("Image failed to load");
  }, []);

  const handleImgLoad = useCallback(() => {
    setImageLoaded(true);
  }, []);

  const toggleNativeSize = useCallback(() => {
    setNativeSize((prev) => !prev);
  }, []);

  // ---------------------------------------------------------------------------
  // Loading state (waiting for media URL or while browser fetches image bytes)
  // ---------------------------------------------------------------------------

  const isLoading = !url || (!imageLoaded && !loadError);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-2"
      data-testid="image-preview"
    >
      {/* Toolbar */}
      {url && (
        <div className="flex w-full items-center justify-end gap-2 px-2">
          <button
            type="button"
            onClick={toggleNativeSize}
            aria-pressed={nativeSize}
            className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {nativeSize ? "Fit" : "1:1"}
          </button>
        </div>
      )}

      {/* Loading skeleton */}
      {isLoading && !loadError && (
        <div
          role="status"
          aria-label="Loading image"
          className="h-48 w-full animate-pulse rounded-md bg-muted"
          data-testid="image-loading-skeleton"
        />
      )}

      {/* Error slot */}
      {loadError && (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="image-error"
        >
          {loadError}
        </p>
      )}

      {/* Image */}
      {url && !loadError && (
        <img
          src={url}
          alt={objectKey}
          onLoad={handleImgLoad}
          onError={handleImgError}
          className={
            nativeSize ? "max-w-none" : "max-h-full max-w-full object-contain"
          }
          style={isLoading ? { display: "none" } : undefined}
          data-testid="image-preview-img"
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the token string from a loopback URL of the form
 * `http://127.0.0.1:<port>/m/<token>`.
 *
 * Returns `null` if the URL does not match the expected format.
 */
function extractToken(url: string): string | null {
  const parts = url.split("/m/");
  return parts.length >= 2 ? (parts[1]?.split("?")[0] ?? null) : null;
}
