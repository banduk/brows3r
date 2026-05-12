/**
 * BulkDownloadConfirm — risk dialog shown before kicking off a bulk
 * (folder or multi-selection) download.
 *
 * Why it exists:
 * - The previous flow used `window.confirm` which is jarring on macOS
 *   and provides no information about the cost of the operation.
 * - For folder downloads we cannot fail-safely: each object is its own
 *   HTTP request and there's no archive shortcut on S3. Users deserve a
 *   clear "234 files, 1.2 GB, ~3 min on a 50 Mbps link" estimate before
 *   committing.
 *
 * The caller is responsible for enumerating the selection BEFORE showing
 * the dialog and passing the final summary via `estimate`. While the
 * caller is still counting, pass `estimate=null` and the dialog shows a
 * "Counting files…" placeholder with a disabled confirm button. An
 * enumeration error is communicated via `error`; the dialog surfaces it
 * inline and the confirm stays disabled.
 *
 * OCP: adding a new risk dimension (e.g. cross-region egress fee) is
 * one new <p> below the file/byte summary.
 */

import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatBytes } from "@/lib/format";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Estimate {
  files: number;
  bytes: number;
}

export interface BulkDownloadConfirmProps {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Final summary; `null` while the caller is still enumerating. */
  estimate: Estimate | null;
  /** Inline enumeration error message; suppresses confirm when set. */
  error?: string | null;
  /**
   * Human-readable destination path used in the dialog body. e.g.
   * `/Users/me/Downloads/photos`.
   */
  destination: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Estimate download wall-clock time at a conservative 25 Mbps (3.1 MB/s).
 * Returns a humanised string like "~3m 20s" or "~12s".
 *
 * Why a hard-coded rate: S3 throughput varies wildly with region and
 * connection. A pessimistic-but-realistic 25 Mbps gives the user a
 * usable upper bound. The rate is annotated in the tooltip so the
 * estimate's basis is auditable.
 */
function estimateWallClock(bytes: number): string {
  const bytesPerSec = (25 * 1024 * 1024) / 8;
  const secs = bytes / bytesPerSec;
  if (secs < 1) return "<1s";
  if (secs < 60) return `~${Math.round(secs).toString()}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  if (m < 60) return `~${m.toString()}m ${s.toString()}s`;
  const h = Math.floor(m / 60);
  return `~${h.toString()}h ${(m % 60).toString()}m`;
}

const RISK_BYTE_THRESHOLD = 1024 * 1024 * 1024; // 1 GiB
const RISK_FILE_THRESHOLD = 100;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkDownloadConfirm({
  open,
  onConfirm,
  onCancel,
  estimate,
  error = null,
  destination,
}: BulkDownloadConfirmProps) {
  const { t } = useTranslation();

  const counting = estimate === null;
  const files = estimate?.files ?? 0;
  const bytes = estimate?.bytes ?? 0;
  const isRisky = bytes >= RISK_BYTE_THRESHOLD || files >= RISK_FILE_THRESHOLD;
  const wallClock = estimateWallClock(bytes);

  // Confirm enabled only when we have a final count > 0 and no error.
  const confirmDisabled = counting || error !== null || files === 0;
  const confirmLabel = counting
    ? t("bulkDownload.counting")
    : files === 0
      ? t("bulkDownload.emptyTitle")
      : t("bulkDownload.startDownloadWithSummary", {
          files: files.toLocaleString(),
          size: formatBytes(bytes),
        });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onCancel()}>
      <DialogContent aria-describedby="bulk-download-desc">
        <DialogHeader>
          <DialogTitle>{t("bulkDownload.title")}</DialogTitle>
          <DialogDescription id="bulk-download-desc">
            {t("bulkDownload.description")}
          </DialogDescription>
        </DialogHeader>

        <div
          className="flex flex-col gap-3 py-2 text-sm"
          data-testid="bulk-download-summary"
        >
          {/* File count + size */}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
            <dt className="text-muted-foreground">{t("bulkDownload.files")}</dt>
            <dd className="font-medium">
              {files.toLocaleString()}
              {counting && (
                <span className="ml-1.5 text-xs text-muted-foreground">
                  {t("bulkDownload.counting")}
                </span>
              )}
            </dd>

            <dt className="text-muted-foreground">{t("bulkDownload.size")}</dt>
            <dd className="font-medium">{formatBytes(bytes)}</dd>

            <dt className="text-muted-foreground">{t("bulkDownload.eta")}</dt>
            <dd className="font-medium" title={t("bulkDownload.etaTooltip")}>
              {wallClock}
            </dd>

            <dt className="text-muted-foreground">
              {t("bulkDownload.destination")}
            </dt>
            <dd className="truncate font-mono text-xs" title={destination}>
              {destination}
            </dd>
          </dl>

          {/* Risk callout — only shown when the operation is heavy enough
              to be worth warning about. The threshold is generous (1 GiB
              or 100 files) so the dialog stays out of the way for small
              folders. */}
          {isRisky && (
            <p
              role="note"
              className="rounded-md border-l-4 border-yellow-500 bg-yellow-50 px-3 py-2 text-xs text-yellow-900 dark:bg-yellow-950/40 dark:text-yellow-200"
              data-testid="bulk-download-risk"
            >
              {t("bulkDownload.riskWarning")}
            </p>
          )}

          {/* Enumeration error — surfaces e.g. "Access denied" so the user
              isn't left staring at a stale 0-file count without a clue. */}
          {error !== null && (
            <p
              role="alert"
              className="rounded-md border-l-4 border-red-500 bg-red-50 px-3 py-2 text-xs text-red-900 dark:bg-red-950/40 dark:text-red-200"
              data-testid="bulk-download-error"
            >
              {error}
            </p>
          )}

          <p className="text-xs text-muted-foreground">
            {t("bulkDownload.cancelHint")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={confirmDisabled}
            data-testid="bulk-download-confirm"
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
