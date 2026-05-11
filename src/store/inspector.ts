/**
 * Zustand slice for the properties inspector panel state.
 *
 * Minimal for task 40 — decouples the Toolbar Inspect button (this task)
 * from the inspector panel UI (task 45). Task 45 reads this store to open
 * its panel without touching the toolbar.
 *
 * OCP: adding inspector tabs, edit mode, or a history stack = additive fields
 * here; Toolbar and panel components are unaffected.
 */

import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The target the inspector should display.
 *
 * `key` is null when inspecting a bucket; non-null when inspecting an object.
 */
export interface InspectorTarget {
  profileId: string;
  bucket: string;
  key?: string;
}

export interface InspectorState {
  open: boolean;
  target: InspectorTarget | null;

  /** Open the inspector, optionally pointing at a specific target. */
  openInspector(target: InspectorTarget): void;

  /** Close the inspector. */
  closeInspector(): void;
}

// ---------------------------------------------------------------------------
// Store factory — isolated instances for tests
// ---------------------------------------------------------------------------

export function createInspectorStore() {
  return create<InspectorState>((set) => ({
    open: false,
    target: null,

    openInspector(target: InspectorTarget) {
      set({ open: true, target });
    },

    closeInspector() {
      set({ open: false, target: null });
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton
// ---------------------------------------------------------------------------

export const useInspectorStore = createInspectorStore();
