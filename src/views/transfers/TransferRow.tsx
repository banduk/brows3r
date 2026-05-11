/**
 * TransferRow — single transfer entry in the Transfer Manager panel.
 *
 * Renders:
 * - Kind icon (upload / download arrow)
 * - Filename and profile/bucket badge
 * - ARIA progressbar with % complete label
 * - MB/s and ETA (derived from the store helpers)
 * - Cancel button (active transfers)
 * - Retry button (failed or canceled transfers)
 *
 * OCP: adding a new field (e.g. priority badge) = one new element here.
 * This component is intentionally pure — it never reads the store directly.
 */

import type { Transfer } from "@/api/transfers";
import { transferCancel, transferRetry } from "@/api/transfers";
import { computeBytesPerSec, computeEtaSec } from "@/store/transfers";

// ---------------------------------------------------------------------------
// Format helpers — pure, exported for tests
// ---------------------------------------------------------------------------

/** Format bytes per second to a human-readable rate string (e.g. "1.5 MB/s"). */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "—";
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024)
    return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Format seconds remaining to a human-readable ETA string (e.g. "1m 23s"). */
export function formatEta(secs: number | null): string {
  if (secs === null) return "—";
  if (secs <= 0) return "Done";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/** Extract the filename component from an S3 key. */
function keyToFilename(key: string): string {
  const parts = key.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? key;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TransferRowProps {
  transfer: Transfer;
  /** Called after a successful cancel to allow the parent to update state. */
  onCanceled?: (id: string) => void;
  /** Called after a successful retry to allow the parent to update state. */
  onRetried?: (id: string, newId: string) => void;
}

export function TransferRow({
  transfer,
  onCanceled,
  onRetried,
}: TransferRowProps) {
  const isActive = transfer.state === "queued" || transfer.state === "running";
  const isFailed = transfer.state === "failed" || transfer.state === "canceled";

  const pct =
    transfer.totalBytes && transfer.totalBytes > 0
      ? Math.min(
          100,
          Math.round((transfer.transferredBytes / transfer.totalBytes) * 100),
        )
      : 0;

  const rate = computeBytesPerSec(transfer);
  const eta = computeEtaSec(transfer);

  const filename = keyToFilename(transfer.key);
  const kindLabel = transfer.kind === "upload" ? "Upload" : "Download";
  const kindIcon = transfer.kind === "upload" ? "↑" : "↓";

  async function handleCancel() {
    await transferCancel(transfer.id);
    onCanceled?.(transfer.id);
  }

  async function handleRetry() {
    const newId = await transferRetry(transfer.id);
    onRetried?.(transfer.id, newId);
  }

  return (
    <li className="flex flex-col gap-1 rounded-md border bg-card px-3 py-2 text-sm">
      {/* Header row */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          title={kindLabel}
          className="shrink-0 text-base font-bold text-muted-foreground"
        >
          {kindIcon}
        </span>

        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          title={transfer.key}
        >
          {filename}
        </span>

        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
          {transfer.profileId}/{transfer.bucket}
        </span>
      </div>

      {/* Progress bar */}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${filename} ${pct}% complete`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>

      {/* Stats + actions row */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>{pct}%</span>
        {isActive && (
          <>
            <span>{formatRate(rate)}</span>
            <span>ETA: {formatEta(eta)}</span>
          </>
        )}

        {/* State badge for terminal states */}
        {!isActive && !isFailed && (
          <span className="ml-auto rounded bg-green-100 px-1.5 py-0.5 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            Done
          </span>
        )}
        {transfer.state === "failed" && (
          <span className="ml-auto rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/30 dark:text-red-400">
            Failed
          </span>
        )}
        {transfer.state === "canceled" && (
          <span className="ml-auto rounded bg-yellow-100 px-1.5 py-0.5 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
            Canceled
          </span>
        )}

        {/* Action buttons */}
        <div className="ml-auto flex items-center gap-1">
          {isActive && (
            <button
              type="button"
              onClick={handleCancel}
              aria-label={`Cancel ${filename}`}
              className="rounded px-1.5 py-0.5 text-xs hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel
            </button>
          )}
          {isFailed && (
            <button
              type="button"
              onClick={handleRetry}
              aria-label={`Retry ${filename}`}
              className="rounded px-1.5 py-0.5 text-xs hover:bg-primary/10 hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </li>
  );
}
