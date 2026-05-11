/**
 * Zustand slice for the diff preview / confirmation framework.
 *
 * Coordinates the two-phase flow:
 *
 *   1. `openDiff(payload)` — calls `diffPreviewCreate` on the backend, stores
 *      the returned `DiffId`, and opens the confirmation modal.
 *   2. `closeDiff(reason)` — clears state.  When `reason === 'cancelled'` the
 *      backend cancel call is the caller's responsibility (the modal does this
 *      before calling `closeDiff`).
 *
 * # OCP
 *
 * `DiffPayload` is a discriminated union — adding a new kind is one new member
 * on the frontend type + one new rendering branch in `DiffPreviewModal`.
 */

import { create } from "zustand";
import type { DiffId, DiffPayload } from "@/api/diff";
import { diffPreviewCreate } from "@/api/diff";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The minimal shape kept in store for a live diff. */
export interface ActiveDiff {
  id: DiffId;
  payload: DiffPayload;
}

export interface DiffState {
  /** The currently pending diff, or `null` when no diff is open. */
  currentDiff: ActiveDiff | null;

  /**
   * Open a diff preview for the given payload.
   *
   * Calls `diffPreviewCreate` on the backend, sets `currentDiff` with the
   * returned `DiffId`, and returns the id for the caller to thread into the
   * confirm command.
   *
   * Throws if the backend returns an error (e.g. unsupported kind).
   */
  openDiff(payload: DiffPayload): Promise<DiffId>;

  /**
   * Clear the current diff from state.
   *
   * `reason` documents why the diff is being closed:
   * - `'confirmed'`  — the mutating command succeeded.
   * - `'cancelled'`  — user clicked Cancel in the modal (modal already called
   *                    `diffPreviewCancel` before calling this).
   * - `'closed'`     — modal dismissed without user action (e.g. Esc or
   *                    outside-click); the diff id is no longer usable.
   */
  closeDiff(reason: "confirmed" | "cancelled" | "closed"): void;
}

// ---------------------------------------------------------------------------
// Store factory — isolated instances for tests
// ---------------------------------------------------------------------------

export function createDiffStore() {
  return create<DiffState>((set) => ({
    currentDiff: null,

    async openDiff(payload: DiffPayload): Promise<DiffId> {
      // Map DiffPayload to the backend's snake_case new_class field.
      const backendPayload: Record<string, unknown> =
        payload.kind === "storage_class"
          ? {
              targets: payload.targets,
              current: payload.current,
              new_class: payload.newClass,
            }
          : (payload as unknown as Record<string, unknown>);

      const id = await diffPreviewCreate(payload.kind, backendPayload);
      set({ currentDiff: { id, payload } });
      return id;
    },

    closeDiff(_reason: "confirmed" | "cancelled" | "closed") {
      set({ currentDiff: null });
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton
// ---------------------------------------------------------------------------

export const useDiffStore = createDiffStore();
