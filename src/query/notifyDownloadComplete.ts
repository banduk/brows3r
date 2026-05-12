/**
 * Surfaces a "Download complete" toast with a clickable "Open folder"
 * action when a download transfer finishes.
 *
 * Split out from `query/client.ts` to keep the event-bridge wiring narrow
 * and to defer the i18n + Tauri-opener imports until they are actually
 * needed.
 *
 * Lookups:
 *  - Reads the completed transfer from the transfers store (already
 *    upserted by `applyStateEvent`) to get `kind` and `destPath`.
 *  - Only download transfers with a known `destPath` trigger the toast.
 *
 * The "Open folder" action calls `revealItemInDir(destPath)` which selects
 * the saved file in the OS file manager (Finder / Explorer / Nautilus).
 */

import i18n from "@/i18n";
import { notify } from "@/lib/errors";
import { useTransfersStore } from "@/store/transfers";

/**
 * Tracks recent "download complete" toasts within a short window so a bulk
 * download (e.g. 50 files at once) does not produce 50 stacked toasts.
 * Each batch coalesces by destination directory.
 */
const recentBatches = new Map<
  string,
  { count: number; lastDest: string; timerId: number }
>();

/** Coalesce delay — ms after the last completion before the toast fires. */
const COALESCE_MS = 400;

export function notifyDownloadComplete(requestId: string): void {
  const transfer = useTransfersStore.getState().transfers.get(requestId);
  if (!transfer) return;
  if (transfer.kind !== "download") return;
  if (transfer.state !== "done") return;
  const destPath = transfer.destPath;
  if (!destPath) return;

  const dir = parentDir(destPath);

  const existing = recentBatches.get(dir);
  if (existing) {
    window.clearTimeout(existing.timerId);
    existing.count += 1;
    existing.lastDest = destPath;
    existing.timerId = window.setTimeout(() => flush(dir), COALESCE_MS);
  } else {
    const timerId = window.setTimeout(() => flush(dir), COALESCE_MS);
    recentBatches.set(dir, { count: 1, lastDest: destPath, timerId });
  }
}

function flush(dir: string): void {
  const batch = recentBatches.get(dir);
  if (!batch) return;
  recentBatches.delete(dir);

  const t = i18n.t.bind(i18n);
  const isSingle = batch.count === 1;
  const baseName = basename(batch.lastDest);
  const message = isSingle
    ? t("transfers.downloadComplete.messageOne", { name: baseName })
    : t("transfers.downloadComplete.messageMany", { count: batch.count });

  notify({
    id: `download-complete-${dir}-${Date.now().toString()}`,
    title: t("transfers.downloadComplete.title"),
    message,
    severity: "success",
    action: {
      label: t("transfers.downloadComplete.openFolder"),
      onClick: () => {
        void revealOrSurface(batch.lastDest);
      },
    },
  });
}

async function revealOrSurface(path: string): Promise<void> {
  try {
    const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
    await revealItemInDir(path);
  } catch (err) {
    const { surfaceUnknownError } = await import("@/lib/errors");
    await surfaceUnknownError(err, {
      operation: "transfer.reveal-in-folder",
      resource: path,
      title: i18n.t("transfers.downloadComplete.revealFailed"),
    });
  }
}

function lastSeparator(p: string): number {
  return Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
}

function parentDir(p: string): string {
  const sep = lastSeparator(p);
  if (sep <= 0) return p;
  return p.slice(0, sep);
}

function basename(p: string): string {
  const sep = lastSeparator(p);
  return sep >= 0 ? p.slice(sep + 1) : p;
}
