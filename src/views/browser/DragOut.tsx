/**
 * DragOut — drag S3 objects from brows3r to the OS file manager.
 *
 * Uses Tauri 2's `drag` function from `@tauri-apps/api/webviewWindow` to
 * expose downloaded temp files to the OS drop target on macOS/Windows.
 *
 * Linux fallback (round-2 finding #3):
 * - `isDragOutSupported()` returns `false` on Linux.
 * - On Linux, `startDragOut` opens a `tauri-plugin-dialog` Save dialog so the
 *   user can choose a destination, then triggers `transferDownloadMany`.
 *
 * OCP: switching the Linux fallback mechanism (when Tauri 2 adds Linux drag
 * support) is a one-branch change inside `startDragOut`.
 *
 * Usage:
 *   const { startDragOut, isDragOutReady } = useDragOut({ entries, ... });
 *   <div draggable onDragStart={startDragOut} ... />
 */

import { save } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";
import { transferDownloadMany } from "@/api/transfers";
import { isDragOutSupported } from "@/lib/platform";

// ---------------------------------------------------------------------------
// Tauri drag API shim
// ---------------------------------------------------------------------------

/**
 * Call Tauri 2's `drag` API.
 *
 * `@tauri-apps/api/webviewWindow` exports `getCurrentWebviewWindow()` which
 * has a `startDragging(paths)` method on macOS/Windows.  We import lazily so
 * the module resolves at runtime (not mocked away in tests by default).
 */
async function tauriDragFiles(paths: string[]): Promise<void> {
  const { getCurrentWebviewWindow } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  const win = getCurrentWebviewWindow();
  // `startDragging` is available in Tauri 2 on mac/win.
  // The type cast handles the fact that the TS types may not expose it yet.
  await (
    win as unknown as { startDragging(paths: string[]): Promise<void> }
  ).startDragging(paths);
}

// ---------------------------------------------------------------------------
// useDragOut hook
// ---------------------------------------------------------------------------

export interface DragOutEntry {
  profileId: string;
  bucket: string;
  key: string;
  /** Suggested filename for the Save dialog on Linux. */
  filename: string;
}

interface UseDragOutOptions {
  entries: DragOutEntry[];
  /** Temporary directory where files are downloaded before being handed to the OS. */
  tempDir?: string;
}

interface UseDragOutResult {
  /** Whether drag-out is natively supported on the current platform. */
  isDragOutReady: boolean;
  /**
   * Call this from `onMouseDown` / `onDragStart` on the row.
   * On macOS/Windows: downloads to temp → hands paths to Tauri drag API.
   * On Linux: opens a Save dialog for the first selected file then downloads.
   */
  startDragOut: (e: React.MouseEvent | React.DragEvent) => void;
}

/**
 * Hook that wires Tauri 2's drag-out API (mac/win) or a Save dialog fallback
 * (Linux) for dragging S3 objects to the OS file manager.
 */
export function useDragOut({
  entries,
  tempDir = "/tmp/brows3r-dragout",
}: UseDragOutOptions): UseDragOutResult {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    isDragOutSupported()
      .then(setSupported)
      .catch(() => setSupported(false));
  }, []);

  const startDragOut = useCallback(
    (e: React.MouseEvent | React.DragEvent) => {
      e.preventDefault();

      if (entries.length === 0) return;

      if (supported) {
        // macOS / Windows: download to temp dir then hand to Tauri drag API.
        void (async () => {
          const specs = entries.map((en) => ({
            profileId: en.profileId,
            bucket: en.bucket,
            key: en.key,
            destPath: `${tempDir}/${en.filename}`,
          }));

          // Kick off the downloads.
          await transferDownloadMany(specs);
          const tempPaths = specs.map((s) => s.destPath);

          await tauriDragFiles(tempPaths);
        })();
      } else {
        // Linux fallback: Save dialog for the first file, then download.
        void (async () => {
          const first = entries[0];
          if (!first) return;

          const destPath = await save({
            defaultPath: first.filename,
          });

          if (!destPath) return; // user cancelled

          const specs = entries.map((en, i) => ({
            profileId: en.profileId,
            bucket: en.bucket,
            key: en.key,
            destPath: i === 0 ? destPath : `${destPath}_${en.filename}`,
          }));

          await transferDownloadMany(specs);
        })();
      }
    },
    [supported, entries, tempDir],
  );

  return { isDragOutReady: supported, startDragOut };
}
