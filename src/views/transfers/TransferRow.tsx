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

import { useEffect, useState } from "react";
import type { Transfer } from "@/api/transfers";
import { transferCancel, transferRetry } from "@/api/transfers";
import { surfaceUnknownError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
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

/** Humanise an elapsed-since timestamp (e.g. "2s ago" / "3m ago"). */
function formatRelativeAge(timestampMs: number, nowMs: number): string {
  const delta = Math.max(0, nowMs - timestampMs);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

/** Humanise a duration in ms (e.g. "1m 23s"). */
function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * Tick once per second to refresh "X ago" labels. Cheap because we read
 * a single Date.now() per tick and the row count is bounded.
 */
function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
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
  const now = useNowTick();

  const filename = keyToFilename(transfer.key);
  const kindLabel = transfer.kind === "upload" ? "Upload" : "Download";
  const kindIcon = transfer.kind === "upload" ? "↑" : "↓";

  const totalKnown = transfer.totalBytes != null && transfer.totalBytes > 0;
  const bytesLabel = totalKnown
    ? `${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes ?? 0)}`
    : formatBytes(transfer.transferredBytes);
  const startedLabel = formatRelativeAge(transfer.startedAt, now);
  const durationLabel =
    transfer.finishedAt !== undefined
      ? formatDuration(transfer.finishedAt - transfer.startedAt)
      : null;
  const partsLabel =
    transfer.partsTotal > 1
      ? `${transfer.partsDone}/${transfer.partsTotal} parts`
      : null;

  async function handleCancel() {
    try {
      await transferCancel(transfer.id);
      onCanceled?.(transfer.id);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "transfer_cancel",
        resource: transfer.id,
        title: "Failed to cancel transfer",
      });
    }
  }

  async function handleRetry() {
    try {
      const newId = await transferRetry(transfer.id);
      onRetried?.(transfer.id, newId);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "transfer_retry",
        resource: transfer.id,
        title: "Failed to retry transfer",
      });
    }
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
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{pct}%</span>
        <span title="bytes transferred / total">{bytesLabel}</span>
        {isActive && (
          <>
            <span>{formatRate(rate)}</span>
            <span>ETA: {formatEta(eta)}</span>
          </>
        )}
        {partsLabel && <span title="multipart parts">{partsLabel}</span>}
        <span
          title={`Started ${new Date(transfer.startedAt).toLocaleString()}`}
        >
          {isActive ? `started ${startedLabel}` : durationLabel}
        </span>

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

      {/* Failure reason — hydrated from the transfer:state event payload
          (or transfer_list snapshot). Without this the user only saw a
          red "Failed" badge with no clue about *why* the transfer broke. */}
      {transfer.state === "failed" && transfer.error && (
        <p
          className="text-xs text-destructive/80"
          role="alert"
          data-testid="transfer-row-error"
        >
          {transfer.error.kind}: {transfer.error.message}
        </p>
      )}
    </li>
  );
}
