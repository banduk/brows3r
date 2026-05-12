/**
 * TransferGroup — collapsible parent row for a batch of transfers that
 * share a `batchId` (e.g. a single Download click on a folder).
 *
 * Header shows:
 *   - aggregate progress bar across every child transfer
 *   - count of files + bytes done/total
 *   - rate + ETA (sum of running children)
 *   - state badge (Done / Failed / Canceled / Active)
 *   - "Open folder" action for download batches (uses
 *     `revealItemInDir(commonDestRoot)`)
 *   - "Cancel all" action for active batches
 *
 * Body (expanded) renders individual TransferRow children.
 *
 * OCP:
 *   - The aggregate stats live in pure helpers (`aggregate`,
 *     `commonRoot`) so any caller can ask for them without rendering.
 *   - Adding a group-level action = one new button next to the
 *     existing ones, no structural rework.
 */

import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { Transfer } from "@/api/transfers";
import { transferCancel } from "@/api/transfers";
import { surfaceUnknownError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { computeBytesPerSec } from "@/store/transfers";
import { formatEta, formatRate, TransferRow } from "./TransferRow";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Aggregate {
  files: number;
  done: number;
  failed: number;
  canceled: number;
  running: number;
  totalBytes: number;
  transferredBytes: number;
  bytesPerSec: number;
  etaSec: number | null;
  pct: number;
}

export function aggregate(transfers: Transfer[]): Aggregate {
  let totalBytes = 0;
  let transferredBytes = 0;
  let bytesPerSec = 0;
  let done = 0;
  let failed = 0;
  let canceled = 0;
  let running = 0;
  let knownTotalBytes = 0;
  for (const t of transfers) {
    transferredBytes += t.transferredBytes;
    if (t.totalBytes != null) {
      totalBytes += t.totalBytes;
      knownTotalBytes += t.totalBytes;
    } else {
      // Fall back to transferred so the bar still inches forward.
      totalBytes += t.transferredBytes;
    }
    if (t.state === "running" || t.state === "queued") {
      bytesPerSec += computeBytesPerSec(t);
      running += 1;
    }
    if (t.state === "done") done += 1;
    if (t.state === "failed") failed += 1;
    if (t.state === "canceled") canceled += 1;
  }
  const remaining = Math.max(0, knownTotalBytes - transferredBytes);
  const etaSec = bytesPerSec > 0 ? remaining / bytesPerSec : null;
  const pct =
    totalBytes > 0
      ? Math.min(100, Math.round((transferredBytes / totalBytes) * 100))
      : done === transfers.length
        ? 100
        : 0;
  return {
    files: transfers.length,
    done,
    failed,
    canceled,
    running,
    totalBytes,
    transferredBytes,
    bytesPerSec,
    etaSec,
    pct,
  };
}

/**
 * Find the common ancestor directory of every destPath in the batch.
 * Used by the "Open folder" button so a single click takes the user
 * to the parent that all the downloaded files live under.
 *
 * Returns null when the batch is uploads (no destPath) or paths
 * disagree completely.
 */
export function commonDestRoot(transfers: Transfer[]): string | null {
  const paths = transfers
    .map((t) => t.destPath)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  if (paths.length === 0) return null;
  if (paths.length === 1) {
    const p = paths[0] as string;
    return parentDir(p);
  }

  const first = paths[0] as string;
  const segments = first.split(/[/\\]/);
  let prefix = first;
  for (let i = 1; i < paths.length; i++) {
    const next = paths[i] as string;
    const nextSegments = next.split(/[/\\]/);
    // Find common segment count.
    let common = 0;
    const max = Math.min(segments.length, nextSegments.length);
    while (common < max && segments[common] === nextSegments[common]) {
      common += 1;
    }
    segments.length = common;
    prefix = segments.join("/");
  }
  if (!prefix) return null;
  return prefix;
}

function parentDir(p: string): string {
  const idx = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return idx > 0 ? p.slice(0, idx) : p;
}

function batchTitle(transfers: Transfer[]): string {
  // Prefer the common destination root's last segment; falls back to
  // the first transfer's filename. Either way it's something the user
  // can recognise as "the thing I just downloaded".
  const root = commonDestRoot(transfers);
  if (root) {
    const idx = Math.max(root.lastIndexOf("/"), root.lastIndexOf("\\"));
    const tail = idx >= 0 ? root.slice(idx + 1) : root;
    if (tail) return tail;
  }
  const first = transfers[0];
  if (first) {
    const parts = first.key.split("/").filter(Boolean);
    return parts[parts.length - 1] ?? first.key;
  }
  return "";
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface TransferGroupProps {
  transfers: Transfer[];
  /** Forces initial expanded state. Defaults to false (collapsed). */
  defaultExpanded?: boolean;
}

export function TransferGroup({
  transfers,
  defaultExpanded = false,
}: TransferGroupProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const agg = aggregate(transfers);
  const title = batchTitle(transfers);
  const destRoot = commonDestRoot(transfers);
  const isActive = agg.running > 0;
  const allDone = agg.done === agg.files && agg.files > 0;
  const someFailed = agg.failed > 0 || agg.canceled > 0;
  const kindLabel =
    transfers[0]?.kind === "upload"
      ? t("transferRow.upload")
      : t("transferRow.download");

  async function handleOpenFolder() {
    if (!destRoot) return;
    try {
      await revealItemInDir(destRoot);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "transfer_group.reveal",
        resource: destRoot,
        title: t("transfers.downloadComplete.revealFailed"),
      });
    }
  }

  async function handleCancelAll() {
    const active = transfers.filter(
      (tx) => tx.state === "running" || tx.state === "queued",
    );
    await Promise.allSettled(
      active.map(async (tx) => {
        try {
          await transferCancel(tx.id);
        } catch (err) {
          await surfaceUnknownError(err, {
            operation: "transfer_cancel",
            resource: tx.id,
            title: "Failed to cancel transfer",
          });
        }
      }),
    );
  }

  return (
    <li
      className="flex flex-col gap-1 rounded-md border bg-card px-3 py-2 text-sm"
      data-testid={`transfer-group-${transfers[0]?.batchId ?? "anon"}`}
    >
      {/* Header */}
      <button
        type="button"
        className="flex items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span aria-hidden="true" className="shrink-0">
          {expanded ? (
            <ChevronDownIcon className="size-3.5 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span
          aria-hidden="true"
          title={kindLabel}
          className="shrink-0 text-base font-bold text-muted-foreground"
        >
          {transfers[0]?.kind === "upload" ? "↑" : "↓"}
        </span>
        <span
          className="min-w-0 flex-1 truncate font-medium text-foreground"
          title={destRoot ?? title}
        >
          {t("transferGroup.title", { name: title, count: agg.files })}
        </span>
        {allDone && (
          <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700 dark:bg-green-900/30 dark:text-green-400">
            {t("transferRow.stateDone")}
          </span>
        )}
        {someFailed && !isActive && (
          <span className="shrink-0 rounded bg-yellow-100 px-1.5 py-0.5 text-xs text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
            {t("transferGroup.partial", {
              done: agg.done,
              total: agg.files,
            })}
          </span>
        )}
      </button>

      {/* Aggregate progress */}
      <div
        role="progressbar"
        aria-valuenow={agg.pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t("transferGroup.progressAria", {
          name: title,
          pct: agg.pct,
        })}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${agg.pct}%` }}
        />
      </div>

      {/* Aggregate stats + actions */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">{agg.pct}%</span>
        <span>
          {agg.done}/{agg.files} {t("transferGroup.files")}
        </span>
        <span title={t("transferRow.partsTitle")}>
          {formatBytes(agg.transferredBytes)} / {formatBytes(agg.totalBytes)}
        </span>
        {isActive && (
          <>
            <span>{formatRate(agg.bytesPerSec)}</span>
            <span>
              {t("transferRow.eta", { value: formatEta(agg.etaSec) })}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-1">
          {destRoot && (allDone || (!isActive && agg.done > 0)) && (
            <button
              type="button"
              onClick={handleOpenFolder}
              className="rounded px-1.5 py-0.5 text-xs text-primary hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="transfer-group-open-folder"
            >
              {t("transfers.downloadComplete.openFolder")}
            </button>
          )}
          {isActive && (
            <button
              type="button"
              onClick={handleCancelAll}
              className="rounded px-1.5 py-0.5 text-xs hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              data-testid="transfer-group-cancel-all"
            >
              {t("transferGroup.cancelAll")}
            </button>
          )}
        </div>
      </div>

      {/* Children */}
      {expanded && (
        <ul className="mt-1 flex flex-col gap-1.5 border-l-2 border-border/40 pl-3">
          {transfers.map((tx) => (
            <TransferRow key={tx.id} transfer={tx} />
          ))}
        </ul>
      )}
    </li>
  );
}
