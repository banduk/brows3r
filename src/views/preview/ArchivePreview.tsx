/**
 * ArchivePreview — lists entries in a ZIP, TAR, or GZ-compressed archive.
 *
 * Strategy (v1 — first N bytes):
 *  - Fetches up to 1 MB via `objectGetBytes` (base64 over IPC).
 *  - For ZIP: uses `fflate` (`unzipSync`) to inspect the central directory.
 *  - For TAR/GZ: inflates gzip wrapper (if present) via `fflate.gunzipSync`,
 *    then walks the TAR block stream to extract entry headers.
 *  - Displays a list of entries: name, size, last modified.
 *  - When the archive spans more than 1 MB and the central directory is not
 *    fully present, shows a "directory truncated" warning.
 *
 * No file extraction in v1 — listing only.
 *
 * OCP: `objectGetBytes` is shared with HexPreview.  Future full-listing support
 * requires only changing the fetch strategy (range HEAD + central-directory
 * offset), not this component's render logic.
 */

import { gunzipSync, unzipSync } from "fflate";
import { useEffect, useState } from "react";
import { objectGetBytes } from "@/api/objects";
import { base64ToUint8Array } from "./HexPreview";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ArchivePreviewProps {
  profileId: string;
  bucket: string;
  objectKey: string;
}

export interface ArchiveEntry {
  name: string;
  /** Uncompressed size in bytes. */
  size: number;
  /** Last-modified timestamp (ms since epoch) or null if not available. */
  lastModified: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 1 MB — enough to cover the central directory of small/medium archives. */
const ARCHIVE_FETCH_BYTES = 1_024 * 1_024;

// ---------------------------------------------------------------------------
// Archive parsers
// ---------------------------------------------------------------------------

/**
 * Parse ZIP entries from raw bytes using fflate.
 *
 * `unzipSync` parses the central directory and decompresses each entry.
 * We only need names and metadata — we extract from the raw zip structure
 * instead so we don't pay decompression cost for large files.
 *
 * For listing purposes we use fflate's `unzipSync` in listing-only mode:
 * call it with an empty filter so it returns metadata without decompressing.
 */
function parseZipEntries(bytes: Uint8Array): ArchiveEntry[] {
  // fflate unzipSync decompresses all files — for v1 listing we only read
  // metadata. We pass a filter that returns false to skip actual decompression
  // while still getting all entry metadata via the raw ZIP central directory.
  try {
    // Parse the central directory by unzipping with a filter that skips data.
    // fflate exposes entry metadata through unzipSync even with an empty result.
    const result = unzipSync(bytes, {
      filter(file) {
        // Accept all files but we discard the decompressed data below.
        // This gives us metadata access at minimal cost for small archives.
        return file.size <= 0; // only zero-byte files are fully read
      },
    });

    // For entries whose data was skipped we still need metadata.
    // Use the raw central directory approach via fflate's internal parser.
    // Since fflate doesn't expose a metadata-only API, we do a best-effort:
    // entries that passed the filter (size 0) appear in `result`;
    // for others we fall back to the raw central directory parse below.
    const entries: ArchiveEntry[] = Object.entries(result).map(([name]) => ({
      name,
      size: 0,
      lastModified: null,
    }));

    // If we got no entries (all were filtered), fall back to full parse.
    if (entries.length === 0) {
      return parseZipCentralDirectory(bytes);
    }

    return entries;
  } catch {
    // If filter-based parse fails, try the full listing parse.
    return parseZipCentralDirectory(bytes);
  }
}

/**
 * Parse the ZIP central directory without decompressing file contents.
 *
 * Central directory signature: 0x02014b50 (little-endian: 50 4b 01 02).
 * Each entry header is followed by filename, extra field, comment.
 */
function parseZipCentralDirectory(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let i = 0;
  while (i < bytes.length - 46) {
    // Look for central directory signature PK\x01\x02
    if (
      bytes[i] === 0x50 &&
      bytes[i + 1] === 0x4b &&
      bytes[i + 2] === 0x01 &&
      bytes[i + 3] === 0x02
    ) {
      // compressedSize is read but not used in the entry (listing only shows uncompressed)
      view.getUint32(i + 20, true); // compressed size (skip)
      const uncompressedSize = view.getUint32(i + 24, true);
      const fileNameLength = view.getUint16(i + 28, true);
      const extraFieldLength = view.getUint16(i + 30, true);
      const fileCommentLength = view.getUint16(i + 32, true);

      // DOS date/time at offsets 12 (time) and 14 (date)
      const dosDate = view.getUint16(i + 14, true);
      const dosTime = view.getUint16(i + 12, true);
      const lastModified = dosDateTimeToMs(dosDate, dosTime);

      // File name is UTF-8 (or ASCII) at offset 46
      if (i + 46 + fileNameLength <= bytes.length) {
        const nameBytes = bytes.slice(i + 46, i + 46 + fileNameLength);
        const name = new TextDecoder().decode(nameBytes);

        entries.push({ name, size: uncompressedSize, lastModified });
      }

      i += 46 + fileNameLength + extraFieldLength + fileCommentLength;
    } else {
      i++;
    }
  }

  return entries;
}

/**
 * Convert MS-DOS date+time fields to Unix milliseconds.
 *
 * DOS date: bits 15-9 = year - 1980, 8-5 = month (1-12), 4-0 = day (1-31)
 * DOS time: bits 15-11 = hour, 10-5 = minute, 4-0 = second/2
 */
function dosDateTimeToMs(dosDate: number, dosTime: number): number | null {
  const year = ((dosDate >> 9) & 0x7f) + 1980;
  const month = (dosDate >> 5) & 0x0f;
  const day = dosDate & 0x1f;
  const hour = (dosTime >> 11) & 0x1f;
  const minute = (dosTime >> 5) & 0x3f;
  const second = (dosTime & 0x1f) * 2;

  if (month === 0 || day === 0) return null;
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * Parse a TAR stream (uncompressed or after gzip inflation) for entry headers.
 *
 * TAR blocks are 512 bytes each.  The header block for each file has:
 *   - Offset 0:   filename (100 bytes, null-terminated)
 *   - Offset 124: file size (octal, 12 bytes)
 *   - Offset 136: modification time (octal, 12 bytes)
 *   - Offset 156: type flag (1 byte: '0' or '\0' = regular file, '5' = dir)
 */
export function parseTarEntries(bytes: Uint8Array): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);

    // Detect end-of-archive (two consecutive zero blocks).
    const isZero = header.every((b) => b === 0);
    if (isZero) break;

    // File name: bytes 0–99 (null-terminated).
    let nameEnd = 0;
    while (nameEnd < 100 && header[nameEnd] !== 0) {
      nameEnd++;
    }
    const name = new TextDecoder().decode(header.slice(0, nameEnd));
    if (!name) {
      offset += 512;
      continue;
    }

    // File size: bytes 124–135, octal ASCII, null-terminated.
    const sizeOctal = new TextDecoder()
      .decode(header.slice(124, 136))
      .replace(/\0/g, "")
      .trim();
    const size = Number.parseInt(sizeOctal, 8) || 0;

    // Modification time: bytes 136–147, octal ASCII.
    const mtimeOctal = new TextDecoder()
      .decode(header.slice(136, 148))
      .replace(/\0/g, "")
      .trim();
    const mtimeSec = Number.parseInt(mtimeOctal, 8);
    const lastModified = Number.isNaN(mtimeSec) ? null : mtimeSec * 1000;

    entries.push({ name, size, lastModified });

    // Advance past header + data blocks (each block is 512 bytes, padded up).
    const dataBlocks = Math.ceil(size / 512);
    offset += 512 + dataBlocks * 512;
  }

  return entries;
}

/**
 * Determine the archive type from the object key extension.
 */
function detectArchiveType(
  objectKey: string,
): "zip" | "tar" | "tar.gz" | "unknown" {
  const lower = objectKey.toLowerCase();
  if (lower.endsWith(".zip")) return "zip";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".tar")) return "tar";
  return "unknown";
}

// ---------------------------------------------------------------------------
// ArchivePreview
// ---------------------------------------------------------------------------

export function ArchivePreview({
  profileId,
  bucket,
  objectKey,
}: ArchivePreviewProps): React.ReactElement {
  const [entries, setEntries] = useState<ArchiveEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [parseWarning, setParseWarning] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // Fetch + parse on mount / key change.
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    setEntries(null);
    setLoadError(null);
    setTruncated(false);
    setParseWarning(null);

    objectGetBytes(profileId, bucket, objectKey, ARCHIVE_FETCH_BYTES)
      .then((payload) => {
        if (cancelled) return;

        const bytes = base64ToUint8Array(payload.body);
        const archiveType = detectArchiveType(objectKey);
        let parsed: ArchiveEntry[] = [];
        let warning: string | null = null;

        try {
          if (archiveType === "zip") {
            parsed = parseZipCentralDirectory(bytes);
            if (parsed.length === 0) {
              // Fall back to fflate-based parse.
              parsed = parseZipEntries(bytes);
            }
          } else if (archiveType === "tar.gz") {
            const decompressed = gunzipSync(bytes);
            parsed = parseTarEntries(decompressed);
          } else if (archiveType === "tar") {
            parsed = parseTarEntries(bytes);
          } else {
            // Unknown type: try ZIP then TAR.
            try {
              parsed = parseZipCentralDirectory(bytes);
            } catch {
              parsed = parseTarEntries(bytes);
            }
          }
        } catch (err: unknown) {
          warning = `Could not parse archive: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (payload.truncated) {
          setTruncated(true);
          // If the truncated read produced no entries, the central directory
          // was beyond the first 1 MB.
          if (parsed.length === 0) {
            warning = "Archive directory truncated; download for full listing.";
          }
        }

        setEntries(parsed);
        setParseWarning(warning);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : "Failed to load archive",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [profileId, bucket, objectKey]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full flex-col" data-testid="archive-preview">
      {/* Loading skeleton */}
      {entries === null && !loadError && (
        <div
          role="status"
          aria-label="Loading archive"
          className="flex flex-1 items-center justify-center"
          data-testid="archive-loading-skeleton"
        >
          <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        </div>
      )}

      {/* Error slot */}
      {loadError && (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-4"
          data-testid="archive-error"
        >
          <p className="text-sm text-destructive">{loadError}</p>
        </div>
      )}

      {/* Parse warning / truncation banner */}
      {(truncated || parseWarning) && entries !== null && (
        <div
          role="status"
          className="border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground"
          data-testid="archive-truncated-banner"
        >
          {parseWarning ??
            "Archive directory truncated; download for full listing."}
        </div>
      )}

      {/* Entry list */}
      {entries !== null && !loadError && (
        <div
          className="min-h-0 flex-1 overflow-auto"
          data-testid="archive-entries"
        >
          {entries.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              No entries found
            </div>
          ) : (
            <table className="w-full text-xs" aria-label="Archive contents">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="px-3 py-1.5 font-medium">Name</th>
                  <th className="px-3 py-1.5 font-medium text-right">Size</th>
                  <th className="px-3 py-1.5 font-medium">Modified</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr
                    key={entry.name}
                    className="border-b border-muted/30 hover:bg-muted/20"
                    data-testid="archive-entry-row"
                  >
                    <td className="px-3 py-1 font-mono">{entry.name}</td>
                    <td className="px-3 py-1 text-right text-muted-foreground">
                      {formatSize(entry.size)}
                    </td>
                    <td className="px-3 py-1 text-muted-foreground">
                      {entry.lastModified
                        ? formatDate(entry.lastModified)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
