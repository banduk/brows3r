/**
 * BulkDownloadHost — singleton mount point for the BulkDownloadConfirm
 * dialog, plus an imperative `requestBulkDownloadConfirm()` helper that
 * commands (running outside React) can call to open the dialog and await
 * the user's decision.
 *
 * Why a separate host:
 * - The command-registry callbacks (e.g. file.download) run outside the
 *   React tree, so they cannot render a dialog directly. We back them
 *   with a Zustand slice that the host subscribes to.
 * - One mounted instance handles every consumer; there is no per-call
 *   portal teardown to manage.
 *
 * The caller passes a final `estimate` (files + bytes) — enumeration
 * happens BEFORE the dialog opens so there is no race between counting
 * and the user clicking Start. While the caller is still counting, pass
 * `estimate=null` (the dialog shows "Counting…"). Errors surface inline
 * via the optional `error` field.
 *
 * OCP: adding another bridged dialog = one new slice + one new branch.
 */

import { create } from "zustand";
import type { Estimate } from "./BulkDownloadConfirm";
import { BulkDownloadConfirm } from "./BulkDownloadConfirm";

// ---------------------------------------------------------------------------
// Zustand slice
// ---------------------------------------------------------------------------

interface RequestArgs {
  destination: string;
  estimate: Estimate | null;
  error: string | null;
  resolve: (confirmed: boolean) => void;
}

interface BulkDownloadHostState {
  current: RequestArgs | null;
  request(
    args: Omit<RequestArgs, "resolve"> & { resolve: RequestArgs["resolve"] },
  ): void;
  update(patch: Partial<Pick<RequestArgs, "estimate" | "error">>): void;
  close(confirmed: boolean): void;
}

const useBulkDownloadHostStore = create<BulkDownloadHostState>((set, get) => ({
  current: null,
  request(args) {
    // If a request is already in flight, resolve it as canceled so the
    // earlier caller doesn't dangle.
    const existing = get().current;
    if (existing) existing.resolve(false);
    set({ current: args });
  },
  update(patch) {
    const existing = get().current;
    if (!existing) return;
    set({ current: { ...existing, ...patch } });
  },
  close(confirmed) {
    const existing = get().current;
    if (existing) existing.resolve(confirmed);
    set({ current: null });
  },
}));

// ---------------------------------------------------------------------------
// Public imperative API
// ---------------------------------------------------------------------------

export interface OpenBulkDownloadDialog {
  /** Promise that resolves with the user's decision (true = confirm). */
  decision: Promise<boolean>;
  /** Push a partial-or-final count to the dialog while it is open. */
  update(patch: { estimate?: Estimate | null; error?: string | null }): void;
  /** Close the dialog programmatically (e.g. on caller-side error). */
  close(confirmed: boolean): void;
}

/**
 * Open the BulkDownloadConfirm dialog and return handles to update its
 * displayed totals as enumeration progresses. The dialog stays in
 * "Counting…" mode until the caller passes a non-null `estimate`.
 *
 * Safe to call from outside React — uses the Zustand store as a queue.
 */
export function openBulkDownloadDialog(args: {
  destination: string;
  initialEstimate?: Estimate | null;
}): OpenBulkDownloadDialog {
  let resolveDecision!: (confirmed: boolean) => void;
  const decision = new Promise<boolean>((resolve) => {
    resolveDecision = resolve;
  });

  useBulkDownloadHostStore.getState().request({
    destination: args.destination,
    estimate: args.initialEstimate ?? null,
    error: null,
    resolve: resolveDecision,
  });

  return {
    decision,
    update(patch) {
      useBulkDownloadHostStore.getState().update(patch);
    },
    close(confirmed) {
      useBulkDownloadHostStore.getState().close(confirmed);
    },
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkDownloadHost() {
  const current = useBulkDownloadHostStore((s) => s.current);
  const close = useBulkDownloadHostStore((s) => s.close);

  if (!current) return null;

  return (
    <BulkDownloadConfirm
      open
      destination={current.destination}
      estimate={current.estimate}
      error={current.error}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
