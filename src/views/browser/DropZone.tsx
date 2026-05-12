/**
 * DropZone — wraps the file-list area to accept OS→S3 file drops.
 *
 * Drop handling:
 * 1. The browser `drop` event fires with a `FileList` in `dataTransfer.files`.
 * 2. Each `File` object has a `.path` property injected by Tauri's WebView
 *    when `fileDropEnabled` is active.  We cast to the Tauri-augmented type.
 * 3. We build a `TransferUploadSpec` per file and call `transferUploadMany`.
 *
 * A11y:
 * - An `aria-live="polite"` region announces the drop result to screen readers
 *   (Decision D5).
 * - The overlay visible during dragover carries `role="status"` so the
 *   "Drop to upload" label is announced.
 *
 * OCP: adding a trash-bin drop target is one new `DropZone` call site with a
 * different `onDrop` callback — this component's internal logic is unchanged.
 */

import { useCallback, useState } from "react";
import { transferUploadMany } from "@/api/transfers";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Tauri-augmented File type
// ---------------------------------------------------------------------------

/**
 * In a Tauri WebView `dataTransfer.files` entries carry a `path` property
 * that holds the native filesystem path resolved by the Tauri file-drop
 * handler.  The standard DOM `File` type does not include this field.
 */
interface TauriFile extends File {
  /** Native OS path injected by Tauri's file-drop handler. */
  path: string;
}

// ---------------------------------------------------------------------------
// DropZone
// ---------------------------------------------------------------------------

export interface DropZoneProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  /** S3 prefix for the current folder (e.g. `"photos/"` or `""`). */
  prefix: string;
  children: React.ReactNode;
  className?: string;
  /** Custom accessible label for the drop region. Defaults to "File drop target". */
  ariaLabel?: string;
}

type DropState = "idle" | "over" | "success";

export function DropZone({
  profileId,
  bucket,
  prefix,
  children,
  className,
  ariaLabel = "File drop target",
}: DropZoneProps) {
  const [state, setState] = useState<DropState>("idle");
  const [announcement, setAnnouncement] = useState<string>("");

  const handleDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    setState("over");
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setState("idle");
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setState("idle");

      if (!profileId || !bucket) return;

      const files = Array.from(e.dataTransfer.files) as TauriFile[];
      if (files.length === 0) return;

      const specs = files
        .filter((f) => f.path)
        .map((f) => {
          const filename = f.name;
          const key = prefix ? `${prefix}${filename}` : filename;
          return { profileId, bucket, key, sourcePath: f.path };
        });

      if (specs.length === 0) return;

      const ids = await transferUploadMany(specs);
      const { seedTransfers } = await import("@/store/transfers");
      seedTransfers(ids, specs, "upload");
      setState("success");
      setAnnouncement(
        `Uploading ${specs.length.toString()} file${specs.length === 1 ? "" : "s"} to ${bucket}/${prefix}`,
      );

      // Reset success indicator after 2 s.
      setTimeout(() => setState("idle"), 2_000);
    },
    [profileId, bucket, prefix],
  );

  return (
    <div
      role="region"
      aria-label={ariaLabel}
      className={cn("relative h-full", className)}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      data-testid="drop-zone"
      data-drop-state={state}
    >
      {children}

      {/* Drag-over overlay */}
      {state === "over" && (
        <div
          role="status"
          aria-label="Drop files to upload"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2",
            "rounded border-2 border-dashed border-primary bg-primary/10",
          )}
          data-testid="drop-zone-overlay"
        >
          <span className="text-sm font-medium text-primary">
            Drop to upload
          </span>
        </div>
      )}

      {/* Success flash overlay */}
      {state === "success" && (
        <div
          role="status"
          aria-label="Upload queued"
          className={cn(
            "pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-2",
            "rounded border-2 border-dashed border-green-500 bg-green-500/10",
          )}
          data-testid="drop-zone-success"
        >
          <span className="text-sm font-medium text-green-600">
            Upload queued
          </span>
        </div>
      )}

      {/* A11y live region */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="drop-zone-announcement"
      >
        {announcement}
      </div>
    </div>
  );
}
