/**
 * Zustand store for in-flight and historical transfers.
 *
 * Mirrors backend `transfer:progress` and `transfer:state` events so any
 * component can read transfer state without polling the Rust side.
 *
 * Design choices:
 * - `Map<string, Transfer>` (id → record) for O(1) upsert/lookup.
 * - `panelOpen` / `panelMinimized` control the TransferManager UI state.
 * - MB/s is derived via a simple elapsed-time sliding window capped at the
 *   last 5 s. The computation is pure and moved to a helper so it can be
 *   swapped for EMA later without touching the store.
 * - Transfers are user-initiated; the profile-validation gate (round-1
 *   finding #9) does not apply here (per design — always shown).
 *
 * OCP: adding a new filter (e.g. "by bucket") = one new selector here.
 */

import { create } from "zustand";
import type { Transfer, TransferState } from "@/api/transfers";

// Re-export Transfer so consumers can import from one place.
export type { Transfer, TransferState };

// ---------------------------------------------------------------------------
// MB/s + ETA helpers — pure functions, easy to swap
// ---------------------------------------------------------------------------

/**
 * Compute bytes per second for a transfer.
 *
 * Uses total elapsed time from `startedAt` to now, capped at a 5-second
 * minimum window to avoid division-by-zero on very fresh transfers.
 */
export function computeBytesPerSec(transfer: Transfer): number {
  const elapsedMs = Math.max(Date.now() - transfer.startedAt, 5_000);
  if (transfer.transferredBytes <= 0) return 0;
  return (transfer.transferredBytes / elapsedMs) * 1_000;
}

/**
 * Compute estimated seconds remaining for a transfer.
 *
 * Returns `null` when `totalBytes` is unknown or the rate is zero.
 */
export function computeEtaSec(transfer: Transfer): number | null {
  const total = transfer.totalBytes;
  if (total == null || total <= 0) return null;

  const remaining = total - transfer.transferredBytes;
  if (remaining <= 0) return 0;

  const rate = computeBytesPerSec(transfer);
  if (rate <= 0) return null;

  return remaining / rate;
}

// ---------------------------------------------------------------------------
// Store types
// ---------------------------------------------------------------------------

export interface TransfersState {
  /** All known transfers, keyed by transfer id. */
  transfers: Map<string, Transfer>;
  /** Whether the Transfer Manager panel is open. */
  panelOpen: boolean;
  /** Whether the panel is minimized to the toolbar pill. */
  panelMinimized: boolean;

  // ---- Actions ----

  /** Insert or update a transfer record. */
  upsert(transfer: Transfer): void;

  /** Remove a transfer by id (e.g. after explicit dismiss). */
  remove(id: string): void;

  /** Remove all transfers in a terminal state (done / failed / canceled). */
  clearCompleted(): void;

  /** Toggle panel open/closed. */
  togglePanel(): void;

  /** Explicitly set the minimized state. */
  setMinimized(minimized: boolean): void;

  // ---- Selectors ----

  /** Active transfers — queued or running. */
  active(): Transfer[];

  /** Completed transfers — done, failed, or canceled. */
  completed(): Transfer[];

  /** All transfers belonging to a specific profile. */
  byProfile(profileId: string): Transfer[];
}

// ---------------------------------------------------------------------------
// Store factory — isolated instances for tests
// ---------------------------------------------------------------------------

export function createTransfersStore() {
  return create<TransfersState>((set, get) => ({
    transfers: new Map(),
    panelOpen: false,
    panelMinimized: false,

    upsert(transfer: Transfer) {
      set((state) => {
        const next = new Map(state.transfers);
        next.set(transfer.id, transfer);
        return { transfers: next };
      });
    },

    remove(id: string) {
      set((state) => {
        const next = new Map(state.transfers);
        next.delete(id);
        return { transfers: next };
      });
    },

    clearCompleted() {
      set((state) => {
        const next = new Map<string, Transfer>();
        for (const [id, t] of state.transfers) {
          if (t.state === "queued" || t.state === "running") {
            next.set(id, t);
          }
        }
        return { transfers: next };
      });
    },

    togglePanel() {
      set((state) => ({ panelOpen: !state.panelOpen }));
    },

    setMinimized(minimized: boolean) {
      set({ panelMinimized: minimized });
    },

    active() {
      return [...get().transfers.values()].filter(
        (t) => t.state === "queued" || t.state === "running",
      );
    },

    completed() {
      return [...get().transfers.values()].filter(
        (t) =>
          t.state === "done" || t.state === "failed" || t.state === "canceled",
      );
    },

    byProfile(profileId: string) {
      return [...get().transfers.values()].filter(
        (t) => t.profileId === profileId,
      );
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton
// ---------------------------------------------------------------------------

export const useTransfersStore = createTransfersStore();

// ---------------------------------------------------------------------------
// Event bridge helpers — called from src/query/client.ts
// ---------------------------------------------------------------------------

/**
 * Apply a `transfer:progress` event to the store.
 *
 * Merges the progress fields into the existing transfer record. If no record
 * exists yet (race: progress arrives before the initial upsert), a minimal
 * placeholder is created so the UI can render immediately.
 */
export function applyProgressEvent(payload: {
  requestId: string;
  bytesDone: number;
  bytesTotal?: number;
  partsDone: number;
  partsTotal: number;
}): void {
  const store = useTransfersStore.getState();
  const existing = store.transfers.get(payload.requestId);

  if (existing) {
    store.upsert({
      ...existing,
      transferredBytes: payload.bytesDone,
      totalBytes: payload.bytesTotal ?? existing.totalBytes,
      partsDone: payload.partsDone,
      partsTotal: payload.partsTotal,
    });
  } else {
    // Placeholder until a full record arrives.
    const placeholder: Transfer = {
      id: payload.requestId,
      kind: "download",
      profileId: "",
      bucket: "",
      key: "",
      transferredBytes: payload.bytesDone,
      totalBytes: payload.bytesTotal,
      partsDone: payload.partsDone,
      partsTotal: payload.partsTotal,
      state: "running",
      startedAt: Date.now(),
    };
    store.upsert(placeholder);
  }
}

/**
 * Apply a `transfer:state` event to the store.
 *
 * Updates only the `state` field of the existing record.
 * If no record exists, this is a no-op (the full record is expected to be
 * upserted when the transfer is started).
 */
export function applyStateEvent(payload: {
  requestId: string;
  state: TransferState;
}): void {
  const store = useTransfersStore.getState();
  const existing = store.transfers.get(payload.requestId);
  if (!existing) return;

  const update: Transfer = {
    ...existing,
    state: payload.state,
  };

  if (
    payload.state === "done" ||
    payload.state === "failed" ||
    payload.state === "canceled"
  ) {
    update.finishedAt = Date.now();
  }

  store.upsert(update);
}
