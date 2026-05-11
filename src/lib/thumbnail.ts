/**
 * Thumbnail URL helpers.
 *
 * Before task 47 (media server), `thumbnailUrlFor` returned null.
 * Now we expose `useThumbnailUrl`, a React hook that mints a signed
 * loopback URL via `mediaRegister` for image entries, and revokes the
 * token on unmount.
 *
 * Usage in a tile/cell component:
 *
 *   const thumbUrl = useThumbnailUrl(profileId, bucket, entry);
 *
 * The hook returns `null` while the URL is being fetched or when the entry
 * is a folder / non-image. Callers should show a placeholder when `null`.
 *
 * OCP: swapping the thumbnail strategy (e.g. using a dedicated backend
 * thumbnail cache) is one edit here — all consumers update automatically.
 */

import { useEffect, useState } from "react";
import { mediaRegister, mediaRevoke } from "@/api/media";
import type { ObjectEntry } from "@/api/objects";

// ---------------------------------------------------------------------------
// MIME / extension helpers
// ---------------------------------------------------------------------------

/** Extensions that render as image thumbnails in v1. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
]);

function entryExtension(entry: ObjectEntry): string | null {
  if (entry.isPrefix) return null;
  const parts = entry.key.split("/");
  const name = parts[parts.length - 1] ?? "";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

function isImageEntry(entry: ObjectEntry): boolean {
  const ext = entryExtension(entry);
  return ext !== null && IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// useThumbnailUrl hook
// ---------------------------------------------------------------------------

/**
 * Returns a loopback thumbnail URL for image entries, or `null` for non-image
 * entries and while the URL is being fetched.
 *
 * Mounts: calls `mediaRegister` to mint a signed session token.
 * Unmounts: calls `mediaRevoke` to free the token.
 *
 * Returns `null` immediately for non-image entries (no media call).
 *
 * @param profileId - Profile whose credentials service the S3 request.
 * @param bucket    - S3 bucket containing the entry.
 * @param entry     - The listing entry to thumbnail.
 */
export function useThumbnailUrl(
  profileId: string | null | undefined,
  bucket: string | null | undefined,
  entry: ObjectEntry,
): string | null {
  const [url, setUrl] = useState<string | null>(null);

  const shouldFetch =
    isImageEntry(entry) && Boolean(profileId) && Boolean(bucket);

  useEffect(() => {
    if (!shouldFetch || !profileId || !bucket) {
      setUrl(null);
      return;
    }

    let revoked = false;
    let mintedToken: string | null = null;

    mediaRegister(profileId, bucket, entry.key)
      .then(({ url: mediaUrl }) => {
        if (revoked) {
          // Component already unmounted — extract token and revoke immediately.
          const tok = extractToken(mediaUrl);
          if (tok) {
            mediaRevoke(tok).catch(() => {});
          }
          return;
        }
        mintedToken = extractToken(mediaUrl);
        setUrl(mediaUrl);
      })
      .catch(() => {
        // Silently fall back to null placeholder on any error.
        if (!revoked) setUrl(null);
      });

    return () => {
      revoked = true;
      if (mintedToken) {
        mediaRevoke(mintedToken).catch(() => {});
        mintedToken = null;
      }
    };
  }, [shouldFetch, profileId, bucket, entry.key]);

  return url;
}

// ---------------------------------------------------------------------------
// extractToken — shared helper
// ---------------------------------------------------------------------------

/**
 * Extract the token from a loopback URL `http://127.0.0.1:<port>/m/<token>`.
 */
function extractToken(url: string): string | null {
  const parts = url.split("/m/");
  return parts.length >= 2 ? (parts[1]?.split("?")[0] ?? null) : null;
}
