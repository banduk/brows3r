/**
 * DiffPreviewModal — confirmation dialog for high-impact property edits.
 *
 * Shows a human-readable summary of the proposed change and offers two
 * actions:
 *
 * - **Confirm** — calls the mutating command (`objectSetStorageClass`) with
 *   the diff id, then calls `closeDiff('confirmed')`.
 * - **Cancel**  — calls `diffPreviewCancel(diffId)` to void the diff on the
 *   backend, then calls `closeDiff('cancelled')`.
 *
 * # OCP
 *
 * The modal is generic over `DiffPayload`.  Adding a new kind is one new
 * `renderSummary` branch below — the dialog chrome, button wiring, and store
 * interaction are unchanged.
 *
 * # Round-3 residual #1
 *
 * The derived test for "cancelling the diff preview makes subsequent confirm
 * attempts fail" lives in `__tests__/cancel.test.tsx`.
 */

import { useState } from "react";
import type { DiffPayload } from "@/api/diff";
import { diffPreviewCancel } from "@/api/diff";
import { objectSetStorageClass } from "@/api/objects";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useDiffStore } from "@/store/diff";

// ---------------------------------------------------------------------------
// renderSummary — OCP extension point
// ---------------------------------------------------------------------------

function renderSummary(payload: DiffPayload): React.ReactNode {
  if (payload.kind === "storage_class") {
    const count = payload.targets.length;
    const current =
      [...new Set(Object.values(payload.current))].join(", ") || "Unknown";
    return (
      <p>
        Move{" "}
        <strong>
          {count} {count === 1 ? "object" : "objects"}
        </strong>{" "}
        from <strong>{current}</strong> to <strong>{payload.newClass}</strong>.
      </p>
    );
  }
  // Future kinds: add branches here.
  return <p>Review the proposed change and confirm or cancel.</p>;
}

// ---------------------------------------------------------------------------
// DiffPreviewModal
// ---------------------------------------------------------------------------

export interface DiffPreviewModalProps {
  /** Profile id passed through to the confirm command. */
  profileId: string;
}

export function DiffPreviewModal({
  profileId,
}: DiffPreviewModalProps): React.ReactElement | null {
  const currentDiff = useDiffStore((s) => s.currentDiff);
  const closeDiff = useDiffStore((s) => s.closeDiff);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!currentDiff) return null;

  const { id, payload } = currentDiff;

  // --------------------------------------------------------------------------
  // Confirm handler
  // --------------------------------------------------------------------------

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (payload.kind === "storage_class") {
        await objectSetStorageClass(
          profileId,
          payload.targets,
          payload.newClass,
          id,
        );
      }
      closeDiff("confirmed");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "An unexpected error occurred.",
      );
    } finally {
      setBusy(false);
    }
  }

  // --------------------------------------------------------------------------
  // Cancel handler
  // --------------------------------------------------------------------------

  async function handleCancel() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await diffPreviewCancel(id);
    } catch {
      // Ignore cancel errors — the diff may have already expired.
    } finally {
      setBusy(false);
      closeDiff("cancelled");
    }
  }

  // --------------------------------------------------------------------------
  // Render
  // --------------------------------------------------------------------------

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) {
          // User closed via Esc or outside-click without choosing an action.
          // We do NOT call diffPreviewCancel here — the id will expire on its
          // own TTL.  This is a deliberate trade-off to avoid unnecessary
          // cancel API calls on incidental closes.
          closeDiff("closed");
        }
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Confirm change</DialogTitle>
          <DialogDescription asChild>
            <div>{renderSummary(payload)}</div>
          </DialogDescription>
        </DialogHeader>

        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={busy}
            aria-label="Cancel change"
          >
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={handleConfirm}
            disabled={busy}
            aria-label="Confirm change"
          >
            {busy ? "Applying…" : "Confirm"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
