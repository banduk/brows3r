/**
 * MediaPreview — renders an S3 video or audio file via the loopback media server.
 *
 * Lifecycle:
 *  1. Mount: call `mediaRegister(profileId, bucket, key)` to mint a signed
 *     session token; the backend returns a loopback URL.
 *  2. Render: `<video controls>` or `<audio controls>` with `src={url}` — the
 *     WebView fetches bytes from the local server; S3 bytes never cross the
 *     IPC boundary.
 *  3. Error recovery: when the element fires `onError` (including 403 from an
 *     expired token), `mediaRegister` is called again and the src is swapped.
 *  4. External revocation: the backend emits `media:revoked` with `{ url }`;
 *     if the current URL matches, we refetch a new token.
 *  5. Unmount: call `mediaRevoke(token)` to free the token (AC-6).
 *
 * Loading state: shown while the media URL is being fetched.
 *
 * OCP: token lifecycle (mint/revoke) mirrors ImagePreview — same pattern,
 * different element. Video and audio share a single element-type switch.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { mediaRegister, mediaRevoke } from "@/api/media";
import { listen } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MediaKind = "video" | "audio";

export interface MediaPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
  kind: MediaKind;
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

// ---------------------------------------------------------------------------
// MediaPreview
// ---------------------------------------------------------------------------

export function MediaPreview({
  profileId,
  bucket,
  objectKey,
  kind,
}: MediaPreviewProps): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Keep a ref so cleanup closures always see the latest token even if state
  // batching delays the update.
  const tokenRef = useRef<string | null>(null);
  // Track the current URL in a ref so the media:revoked handler can compare
  // without a stale closure over `url` state.
  const urlRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Core: mint a token and set the URL. Returns the URL on success.
  // ---------------------------------------------------------------------------

  const fetchUrl = useCallback(
    async (signal: { revoked: boolean }): Promise<string | null> => {
      try {
        const { url: mediaUrl } = await mediaRegister(
          profileId,
          bucket,
          objectKey,
        );
        if (signal.revoked) {
          // Already unmounted — revoke the freshly minted token immediately.
          const tok = extractToken(mediaUrl);
          if (tok) {
            mediaRevoke(tok).catch(() => {});
          }
          return null;
        }
        const tok = extractToken(mediaUrl);
        tokenRef.current = tok;
        urlRef.current = mediaUrl;
        setUrl(mediaUrl);
        setLoadError(null);
        return mediaUrl;
      } catch (err: unknown) {
        if (!signal.revoked) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load media",
          );
        }
        return null;
      }
    },
    [profileId, bucket, objectKey],
  );

  // ---------------------------------------------------------------------------
  // Register on mount; revoke on unmount.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const signal = { revoked: false };
    setUrl(null);
    setLoadError(null);
    urlRef.current = null;

    fetchUrl(signal);

    return () => {
      signal.revoked = true;
      const tok = tokenRef.current;
      if (tok) {
        tokenRef.current = null;
        mediaRevoke(tok).catch(() => {});
      }
    };
  }, [fetchUrl]);

  // ---------------------------------------------------------------------------
  // Listen for external media:revoked events (token revoked by backend/other tab).
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let unlistenFn: (() => void) | null = null;
    let mounted = true;

    listen("media:revoked", (payload) => {
      // Only refetch if the revoked URL matches our current URL.
      if (payload.url === urlRef.current) {
        // Revoke the local ref so the unmount cleanup doesn't double-revoke.
        tokenRef.current = null;
        urlRef.current = null;
        setUrl(null);
        // Re-register a fresh token.
        fetchUrl({ revoked: false });
      }
    }).then((fn) => {
      if (mounted) {
        unlistenFn = fn;
      } else {
        fn();
      }
    });

    return () => {
      mounted = false;
      unlistenFn?.();
    };
  }, [fetchUrl]);

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  // On media element error (includes 403 from expired token): refetch.
  const handleMediaError = useCallback(() => {
    // Revoke the stale token before requesting a new one.
    const tok = tokenRef.current;
    if (tok) {
      tokenRef.current = null;
      mediaRevoke(tok).catch(() => {});
    }
    urlRef.current = null;
    setUrl(null);
    fetchUrl({ revoked: false });
  }, [fetchUrl]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-2 p-2"
      data-testid="media-preview"
    >
      {/* Loading state */}
      {!url && !loadError && (
        <div
          role="status"
          aria-label={`Loading ${kind}`}
          className="h-12 w-full animate-pulse rounded-md bg-muted"
          data-testid="media-loading-skeleton"
        />
      )}

      {/* Error slot */}
      {loadError && (
        <p
          role="alert"
          className="text-sm text-destructive"
          data-testid="media-error"
        >
          {loadError}
        </p>
      )}

      {/* Media element */}
      {url &&
        !loadError &&
        (kind === "video" ? (
          <video
            key={url}
            src={url}
            controls
            onError={handleMediaError}
            className="max-h-full max-w-full"
            aria-label={objectKey}
            data-testid="media-preview-video"
          >
            {/* Captions track required for a11y — no external track file in v1;
                the track element satisfies the rule without a real src. */}
            <track kind="captions" />
          </video>
        ) : (
          <audio
            key={url}
            src={url}
            controls
            onError={handleMediaError}
            aria-label={objectKey}
            data-testid="media-preview-audio"
          >
            <track kind="captions" />
          </audio>
        ))}
    </div>
  );
}
