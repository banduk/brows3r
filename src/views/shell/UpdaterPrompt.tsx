/**
 * UpdaterPrompt — floating banner for in-app auto-update flow.
 *
 * Listens to `updater:status` Tauri events and renders:
 * - Available: banner with "Install update" button and version/notes.
 * - Downloading: progress bar (or indeterminate when size is unknown).
 * - Ready: "Restart now" button.
 * - Error: inline error message.
 *
 * Dismissible at every state. Idle / Checking / UpToDate render nothing.
 *
 * OCP: new `UpdateStatus` variants are handled by adding a branch to the
 * `renderContent` function — existing branches are unaffected.
 *
 * A11y: uses `role="status"` (live region) so screen readers announce state
 * transitions without requiring focus.
 */

import { useCallback, useEffect, useState } from "react";
import { type UpdateStatus, updaterInstall } from "@/api/updater";
import { Button } from "@/components/ui/button";
import { listen } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// useUpdaterStatus — hook
// ---------------------------------------------------------------------------

/**
 * Subscribes to `updater:status` events and returns the latest status.
 *
 * Returns `null` when no event has been received yet (equivalent to `Idle`).
 * Mount in the shell so it is always active.
 */
export function useUpdaterStatus(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen("updater:status", (s) => {
      setStatus(s);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {
        // Listen registration failed (e.g. in non-Tauri env). Silently ignore.
      });

    return () => {
      unlisten?.();
    };
  }, []);

  return status;
}

// ---------------------------------------------------------------------------
// UpdaterPrompt — component
// ---------------------------------------------------------------------------

interface UpdaterPromptProps {
  /** Current updater status, or `null` for idle. */
  status: UpdateStatus | null;
  /** Called when the user dismisses the banner. */
  onDismiss(): void;
}

export function UpdaterPrompt({ status, onDismiss }: UpdaterPromptProps) {
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      await updaterInstall();
    } catch (err: unknown) {
      const msg =
        err !== null &&
        typeof err === "object" &&
        "message" in err &&
        typeof (err as { message: unknown }).message === "string"
          ? (err as { message: string }).message
          : "Install failed. Please try again.";
      setInstallError(msg);
    } finally {
      setInstalling(false);
    }
  }, []);

  // Nothing to show for idle/checking/upToDate states.
  if (
    status === null ||
    status.status === "idle" ||
    status.status === "checking" ||
    status.status === "upToDate"
  ) {
    return null;
  }

  function renderContent() {
    if (status === null) return null;

    switch (status.status) {
      case "available":
        return (
          <>
            <p className="text-sm font-medium">
              Update available: v{status.version}
            </p>
            {status.notes !== null && status.notes !== undefined && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">
                {status.notes}
              </p>
            )}
            <div className="mt-2 flex gap-2">
              <Button
                size="sm"
                onClick={handleInstall}
                disabled={installing}
                aria-busy={installing}
              >
                {installing ? "Installing…" : "Install update"}
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            </div>
            {installError !== null && (
              <p role="alert" className="mt-1 text-xs text-destructive">
                {installError}
              </p>
            )}
          </>
        );

      case "downloading": {
        const pct =
          status.progress !== null && status.progress !== undefined
            ? Math.round(status.progress * 100)
            : null;
        return (
          <>
            <p className="text-sm font-medium">
              Downloading update{pct !== null ? ` (${pct}%)` : "…"}
            </p>
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              aria-label="Download progress"
              className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: pct !== null ? `${pct}%` : "40%" }}
              />
            </div>
          </>
        );
      }

      case "ready":
        return (
          <>
            <p className="text-sm font-medium">
              Update ready — restart to apply.
            </p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" onClick={() => window.location.reload()}>
                Restart now
              </Button>
              <Button size="sm" variant="ghost" onClick={onDismiss}>
                Later
              </Button>
            </div>
          </>
        );

      case "error":
        return (
          <>
            <p role="alert" className="text-sm font-medium text-destructive">
              Update error: {status.message}
            </p>
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          </>
        );

      default:
        return null;
    }
  }

  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border border-border bg-card p-4 shadow-lg"
    >
      {renderContent()}
    </div>
  );
}
