/**
 * Pane state slice — in-memory only (not persisted).
 *
 * A "pane" is an independent browser view with its own location, view mode,
 * and selection. v1 ships with a single pane; dual-pane is task 30 and only
 * requires `panes.length > 1`.
 *
 * OCP: `splitPane` / `closePane` can be added here without touching any
 * existing action. The `Pane` shape carries everything a view mode needs;
 * new pane metadata = one field.
 *
 * Task 29 additions:
 * - `treeExpanded: Set<string>` — expanded prefix keys for Tree view.
 * - `columnPath: ObjectEntry[]` — navigated-into folders for Column view.
 * Both fields survive mode switches via `applySwitch` (switching.ts Task 29).
 */

import { create } from "zustand";
import type { ObjectEntry } from "@/api/objects";
import { applySwitch } from "@/views/modes/switching";
import { type S3Location, useUiStore, type ViewMode } from "./ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** All state owned by one independent browser pane. */
export interface Pane {
  id: string;
  location: S3Location | null;
  viewMode: ViewMode;
  /** Keys of selected items in the current listing. */
  selection: Set<string>;
  /**
   * Tree view: set of expanded prefix keys (per-pane).
   * Initialised to empty; populated lazily as the user expands folders or
   * when switching to Tree view (seeded from location.prefix chain).
   */
  treeExpanded: Set<string>;
  /**
   * Column view: the column path (per-pane).
   * Each element is the folder entry whose children fill the next column.
   */
  columnPath: ObjectEntry[];
  /**
   * Inline fuzzy filter applied to the current listing (or to the bucket list
   * when no bucket is selected). Empty string = no filter. Owned per-pane so
   * splitting into DualPane keeps each side's filter independent.
   */
  filter: string;
}

// ---------------------------------------------------------------------------
// State + actions
// ---------------------------------------------------------------------------

interface PanesState {
  panes: Pane[];
  activePaneId: string;

  setLocation(paneId: string, location: S3Location | null): void;
  setViewMode(paneId: string, mode: ViewMode): void;
  /**
   * Atomically switch the view mode using the switch contract from
   * `switching.ts`. Selection, treeExpanded, and columnPath are adjusted
   * per the rules for the target mode.
   *
   * @param paneId  - The pane to update.
   * @param newMode - The target view mode.
   * @param items   - The current listing; consumed by modes that adjust selection.
   */
  setViewModeWithSwitch(
    paneId: string,
    newMode: ViewMode,
    items: ObjectEntry[],
  ): void;
  setSelection(paneId: string, keys: Set<string>): void;
  /** Set the inline fuzzy filter on a pane. */
  setFilter(paneId: string, filter: string): void;
  clearSelection(paneId: string): void;
  setActivePane(paneId: string): void;
  /** Expand a prefix in Tree view for the given pane. */
  treeExpand(paneId: string, key: string): void;
  /** Collapse a prefix in Tree view for the given pane. */
  treeCollapse(paneId: string, key: string): void;
  /** Set the entire column path for Column view on the given pane. */
  setColumnPath(paneId: string, path: ObjectEntry[]): void;
  /**
   * Split the active pane into two panes for Dual-pane view.
   *
   * Idempotent: if there are already 2+ panes, this is a no-op.
   * The second pane inherits the active pane's location so both sides
   * start at the same location (design §View Modes And Selection: "entry
   * copies the current pane's state to both panes").
   */
  splitPane(): void;
  /**
   * Close a pane by id.
   *
   * The last remaining pane cannot be closed. If the closed pane was the
   * active pane, the first remaining pane becomes active.
   */
  closePane(paneId: string): void;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

// Seed the initial pane's viewMode AND location from the persisted user
// state in `useUiStore` so a page reload / app restart drops the user
// back where they were instead of resetting to "no profile selected".
function initialViewMode(): ViewMode {
  return useUiStore.getState().defaultViewMode ?? "Details";
}

function initialLocation(): S3Location | null {
  return useUiStore.getState().lastLocation ?? null;
}

const INITIAL_PANE: Pane = {
  id: "main",
  location: initialLocation(),
  viewMode: initialViewMode(),
  selection: new Set(),
  treeExpanded: new Set(),
  columnPath: [],
  filter: "",
};

export const usePanesStore = create<PanesState>()((set) => ({
  panes: [INITIAL_PANE],
  activePaneId: INITIAL_PANE.id,

  setLocation: (paneId, location) => {
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId
          ? // Navigating into a new prefix also clears the fuzzy filter so
            // the user doesn't see a falsely-empty target folder caused by
            // a leftover query from the previous location. Selection is
            // cleared for the same reason.
            { ...p, location, selection: new Set(), filter: "" }
          : p,
      ),
    }));
    // Persist the active pane's location so a reload / app restart can
    // restore it. Only the active pane is mirrored — secondary panes
    // (DualPane) can stay in-memory until that mode lands persistence
    // of its own.
    useUiStore.getState().setLastLocation(location);
  },

  setViewMode: (paneId, viewMode) => {
    // Persist the user's choice as the new app-wide default so reloads /
    // app restarts honour it. New panes opened later inherit this default.
    useUiStore.getState().setDefaultViewMode(viewMode);
    set((s) => ({
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, viewMode } : p)),
    }));
  },

  setViewModeWithSwitch: (paneId, newMode, items) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== paneId) return p;
        const next = applySwitch(
          {
            location: p.location,
            viewMode: p.viewMode,
            selection: p.selection,
            treeExpanded: p.treeExpanded,
            columnPath: p.columnPath,
          },
          newMode,
          items,
        );
        return {
          ...p,
          location: next.location,
          viewMode: next.viewMode,
          selection: next.selection,
          treeExpanded: next.treeExpanded ?? p.treeExpanded,
          columnPath: next.columnPath ?? p.columnPath,
        };
      }),
    })),

  setSelection: (paneId, keys) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, selection: new Set(keys) } : p,
      ),
    })),

  setFilter: (paneId, filter) =>
    set((s) => ({
      panes: s.panes.map((p) => (p.id === paneId ? { ...p, filter } : p)),
    })),

  clearSelection: (paneId) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, selection: new Set() } : p,
      ),
    })),

  setActivePane: (activePaneId) => set({ activePaneId }),

  treeExpand: (paneId, key) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== paneId) return p;
        const next = new Set(p.treeExpanded);
        next.add(key);
        return { ...p, treeExpanded: next };
      }),
    })),

  treeCollapse: (paneId, key) =>
    set((s) => ({
      panes: s.panes.map((p) => {
        if (p.id !== paneId) return p;
        const next = new Set(p.treeExpanded);
        next.delete(key);
        return { ...p, treeExpanded: next };
      }),
    })),

  setColumnPath: (paneId, path) =>
    set((s) => ({
      panes: s.panes.map((p) =>
        p.id === paneId ? { ...p, columnPath: path } : p,
      ),
    })),

  splitPane: () =>
    set((s) => {
      // Idempotent: already have 2+ panes.
      if (s.panes.length >= 2) return s;

      const sourcePane =
        s.panes.find((p) => p.id === s.activePaneId) ?? s.panes[0];
      if (!sourcePane) return s;

      const newPane: Pane = {
        id: `pane-${Date.now().toString()}`,
        location: sourcePane.location,
        viewMode: sourcePane.viewMode,
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      };

      return {
        panes: [...s.panes, newPane],
      };
    }),

  closePane: (paneId) =>
    set((s) => {
      // Never close the last pane.
      if (s.panes.length <= 1) return s;

      const remaining = s.panes.filter((p) => p.id !== paneId);
      const nextActiveId =
        s.activePaneId === paneId
          ? (remaining[0]?.id ?? s.activePaneId)
          : s.activePaneId;

      return {
        panes: remaining,
        activePaneId: nextActiveId,
      };
    }),
}));
