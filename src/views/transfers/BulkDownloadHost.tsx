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
 * OCP: adding another bridged dialog = one new slice + one new branch
 * in this host's JSX.
 */

import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import type { Estimate } from "./BulkDownloadConfirm";
import { BulkDownloadConfirm } from "./BulkDownloadConfirm";

// ---------------------------------------------------------------------------
// Zustand slice
// ---------------------------------------------------------------------------

interface RequestArgs {
  destination: string;
  enumerate: () => AsyncIterable<Estimate>;
  resolve: (confirmed: boolean) => void;
}

interface BulkDownloadHostState {
  current: RequestArgs | null;
  request(args: RequestArgs): void;
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
  close(confirmed) {
    const existing = get().current;
    if (existing) existing.resolve(confirmed);
    set({ current: null });
  },
}));

// ---------------------------------------------------------------------------
// Public imperative API
// ---------------------------------------------------------------------------

/**
 * Opens the BulkDownloadConfirm dialog and resolves with `true` if the
 * user confirms, `false` if they cancel.
 *
 * Safe to call from outside React — uses the Zustand store as a queue.
 */
export function requestBulkDownloadConfirm(
  args: Omit<RequestArgs, "resolve">,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useBulkDownloadHostStore.getState().request({ ...args, resolve });
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function BulkDownloadHost() {
  const current = useBulkDownloadHostStore((s) => s.current);
  const close = useBulkDownloadHostStore((s) => s.close);
  // Memoize the enumerate callback by ref so the inner dialog's effect
  // doesn't re-fire on every parent render of this host.
  const enumerateRef = useRef<RequestArgs["enumerate"] | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    enumerateRef.current = current?.enumerate ?? null;
    force((x) => x + 1);
  }, [current]);

  if (!current) return null;
  const enumerate = enumerateRef.current ?? current.enumerate;

  return (
    <BulkDownloadConfirm
      open
      destination={current.destination}
      enumerate={enumerate}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  );
}
