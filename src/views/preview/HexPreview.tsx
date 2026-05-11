/**
 * HexPreview — renders the first N bytes of an S3 object as a hex dump.
 *
 * Lifecycle:
 *  1. Mount: fetch raw bytes via `objectGetBytes` (base64-encoded over IPC).
 *  2. Decode: `atob` → `Uint8Array`.
 *  3. Render: 16 bytes per row — offset (hex) | hex bytes | ASCII representation.
 *
 * Layout per row:
 *   00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 21 0a 00 00 00  Hello wo rld!...
 *
 * OCP: `objectGetBytes` is shared with ArchivePreview — the IPC backend is a
 * single command reused by any future binary renderer.
 */

import { useEffect, useState } from "react";
import { objectGetBytes } from "@/api/objects";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HexPreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
  /** Maximum bytes to fetch. Defaults to 4096. */
  maxBytes?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 4096;
const BYTES_PER_ROW = 16;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to a `Uint8Array`.
 */
export function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Format a single hex dump row.
 *
 * @param offset   - Byte offset of the first byte in the row.
 * @param rowBytes - Slice of at most 16 bytes.
 * @returns        - Formatted row string: `offset  hex-block-1  hex-block-2  ascii`
 */
export function formatHexRow(offset: number, rowBytes: Uint8Array): string {
  const offsetHex = offset.toString(16).padStart(8, "0");

  // Two groups of 8, separated by an extra space.
  const hexCols: string[] = [];
  for (let i = 0; i < BYTES_PER_ROW; i++) {
    if (i < rowBytes.length) {
      hexCols.push((rowBytes[i] as number).toString(16).padStart(2, "0"));
    } else {
      hexCols.push("  "); // padding for incomplete last row
    }
  }
  const hexGroup1 = hexCols.slice(0, 8).join(" ");
  const hexGroup2 = hexCols.slice(8, 16).join(" ");

  // ASCII representation: printable chars only.
  const ascii = Array.from(rowBytes)
    .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : "."))
    .join("");

  return `${offsetHex}  ${hexGroup1}  ${hexGroup2}  ${ascii}`;
}

// ---------------------------------------------------------------------------
// HexPreview
// ---------------------------------------------------------------------------

export function HexPreview({
  profileId,
  bucket,
  objectKey,
  maxBytes = DEFAULT_MAX_BYTES,
}: HexPreviewProps): React.ReactElement {
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);

  // ---------------------------------------------------------------------------
  // Fetch on mount / key change.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setBytes(null);
    setLoadError(null);
    setTruncated(false);

    objectGetBytes(profileId, bucket, objectKey, maxBytes)
      .then((payload) => {
        if (cancelled) return;
        setBytes(base64ToUint8Array(payload.body));
        setTruncated(payload.truncated);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load file bytes",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, bucket, objectKey, maxBytes]);

  // ---------------------------------------------------------------------------
  // Build rows
  // ---------------------------------------------------------------------------

  const rows: string[] = [];
  if (bytes !== null) {
    for (let offset = 0; offset < bytes.length; offset += BYTES_PER_ROW) {
      rows.push(
        formatHexRow(offset, bytes.slice(offset, offset + BYTES_PER_ROW)),
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col" data-testid="hex-preview">
      {/* Loading skeleton */}
      {bytes === null && !loadError && (
        <div
          role="status"
          aria-label="Loading hex dump"
          className="flex flex-1 items-center justify-center"
          data-testid="hex-loading-skeleton"
        >
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        </div>
      )}

      {/* Error slot */}
      {loadError && (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-4"
          data-testid="hex-error"
        >
          <p className="text-sm text-destructive">{loadError}</p>
        </div>
      )}

      {/* Truncation banner */}
      {truncated && (
        <div
          role="status"
          className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="hex-truncated-banner"
        >
          Showing first {maxBytes} bytes — download for full content.
        </div>
      )}

      {/* Hex dump */}
      {bytes !== null && !loadError && (
        <section
          aria-label="Hex dump"
          className="min-h-0 flex-1 overflow-auto"
          data-testid="hex-content"
        >
          <pre className="p-4 font-mono text-xs leading-5 text-foreground">
            {rows.join("\n")}
          </pre>
        </section>
      )}
    </div>
  );
}
