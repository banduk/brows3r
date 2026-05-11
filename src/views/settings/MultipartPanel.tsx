/**
 * MultipartPanel — Settings tab that exposes the multipart-cleanup scanner.
 *
 * Lists in-progress multipart uploads for the active profile/bucket and lets
 * the user abort them individually. Helpful for cleaning up the orphaned
 * uploads that incur S3 storage cost when a transfer never completes.
 *
 * Backend distinguishes:
 *   - "brows3r" uploads (created by this app, safely abortable)
 *   - "unknown" uploads (created elsewhere — abort requires explicit confirm)
 *
 * OCP: adding a new column / filter = one new <th>/<td> here. The backend
 * commands already accept an `olderThanSecs` filter we surface as a select.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type MultipartUpload,
  multipartAbort,
  multipartScan,
} from "@/api/transfers";
import { Button } from "@/components/ui/button";
import { surfaceUnknownError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { usePanesStore } from "@/store/panes";

const OLDER_THAN_OPTIONS = [
  { label: "Any age", value: undefined },
  { label: "Older than 1 hour", value: 60 * 60 },
  { label: "Older than 1 day", value: 24 * 60 * 60 },
  { label: "Older than 1 week", value: 7 * 24 * 60 * 60 },
] as const;

export function MultipartPanel() {
  const location = usePanesStore(
    (s) => s.panes.find((p) => p.id === s.activePaneId)?.location ?? null,
  );
  const profileId = location?.profileId ?? null;
  const bucket = location?.bucket ?? null;
  const [olderThan, setOlderThan] = useState<number | undefined>(undefined);
  const queryClient = useQueryClient();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ["multipart", profileId, bucket, olderThan ?? "any"] as const,
    queryFn: () =>
      multipartScan(profileId as string, bucket as string, olderThan),
    enabled: Boolean(profileId && bucket),
  });

  async function handleAbort(upload: MultipartUpload) {
    if (!profileId || !bucket) return;
    const isUnknown = upload.source === "unknown";
    if (isUnknown) {
      const ok = window.confirm(
        `This upload (${upload.uploadId.slice(0, 8)}…) was not created by brows3r. Aborting it might cancel work from another tool. Continue?`,
      );
      if (!ok) return;
    }
    try {
      await multipartAbort(
        profileId,
        bucket,
        upload.uploadId,
        upload.key,
        upload.source,
        isUnknown,
      );
      await queryClient.invalidateQueries({ queryKey: ["multipart"] });
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "multipart_abort",
        resource: `${bucket}/${upload.key}#${upload.uploadId}`,
        title: "Failed to abort multipart upload",
      });
    }
  }

  if (!profileId || !bucket) {
    return (
      <section
        aria-label="Multipart cleanup"
        className="flex flex-col items-center justify-center gap-2 py-8 text-sm text-muted-foreground"
      >
        <p>Select a bucket to scan for in-progress multipart uploads.</p>
      </section>
    );
  }

  return (
    <section
      aria-label="Multipart cleanup"
      className="flex flex-col gap-3 text-sm"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Filter</span>
        <select
          aria-label="Older than"
          value={olderThan ?? ""}
          onChange={(e) => {
            const raw = e.target.value;
            setOlderThan(raw === "" ? undefined : Number(raw));
          }}
          className="h-7 rounded border border-border bg-background px-2 text-xs"
        >
          {OLDER_THAN_OPTIONS.map((opt) => (
            <option key={opt.label} value={opt.value ?? ""}>
              {opt.label}
            </option>
          ))}
        </select>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => void refetch()}
          disabled={isLoading}
        >
          {isLoading ? "Scanning…" : "Scan"}
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive">
          {error instanceof Error ? error.message : String(error)}
        </p>
      )}

      {data && data.length === 0 && (
        <p className="text-muted-foreground">
          No in-progress multipart uploads found.
        </p>
      )}

      {data && data.length > 0 && (
        <ul className="flex flex-col gap-1">
          {data.map((upload) => {
            const isUnknown = upload.source === "unknown";
            return (
              <li
                key={`${upload.uploadId}-${upload.key}`}
                className="flex items-center gap-2 rounded border border-border px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-xs">{upload.key}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {upload.initiated !== undefined
                      ? formatRelative(upload.initiated * 1000)
                      : "unknown age"}
                    {" · "}
                    <span
                      className={
                        isUnknown
                          ? "text-amber-600 dark:text-amber-400"
                          : undefined
                      }
                    >
                      {isUnknown ? "unknown source" : "brows3r"}
                    </span>
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleAbort(upload)}
                  className="text-destructive"
                >
                  Abort
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
