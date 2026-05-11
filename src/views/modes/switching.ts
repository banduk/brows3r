/**
 * switching.ts — view-mode switch contract.
 *
 * `applySwitch` is the single source of truth for mode transitions.
 * It returns a new ViewState with selection and location adjusted per
 * the design rules (design.md §View Modes And Selection lines 587-596).
 *
 * OCP: This module is extended in tasks 29 and 30 by adding branches to the
 * match without modifying existing ones. The module signature is stable.
 *
 * Task 28 (split a): handles Details / IconGrid / Gallery transitions.
 * Task 29 (split b): adds Tree and Column branches.
 * Task 30 (split c): adds FlatKey and DualPane branches.
 */

import type { ObjectEntry } from "@/api/objects";
import type { S3Location, ViewMode } from "@/store/ui";

// ---------------------------------------------------------------------------
// ViewState
// ---------------------------------------------------------------------------

/**
 * Minimal snapshot of a pane that `applySwitch` reads and writes.
 *
 * Using a plain object (not the full Pane) keeps this module decoupled from
 * the Zustand store and easier to test.
 */
export interface ViewState {
  location: S3Location | null;
  viewMode: ViewMode;
  /** Keys of selected items in the current listing. */
  selection: Set<string>;
  /**
   * Tree view: set of expanded prefix keys.
   * Only meaningful when `viewMode === "Tree"`, but carried through all
   * transitions so Tree→X→Tree restores the expanded set.
   */
  treeExpanded?: Set<string>;
  /**
   * Column view: the current column path (entries navigated into).
   * Only meaningful when `viewMode === "Column"`, but carried through all
   * transitions so Column→X→Column can restore position.
   */
  columnPath?: ObjectEntry[];
  /**
   * DualPane: when entering DualPane mode the caller may need to know the
   * resolved pair of pane states. This optional field carries extra pane
   * data for cases where the store must be updated with a new pane array.
   *
   * Returning `panes` here is the switching contract extension for DualPane
   * (design §View Modes And Selection: "The DualPane case … returns the new
   * pane array as part of ViewState extension").
   */
  panes?: Array<{
    id: string;
    location: S3Location | null;
    viewMode: ViewMode;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute the chain of prefixes that must be expanded in Tree view to make
 * `location.prefix` visible. Seeded into `treeExpanded` on *→Tree switches.
 *
 * For example, prefix "a/b/c/" → ["a/", "a/b/", "a/b/c/"].
 */
function expandPathPrefixes(prefix: string): Set<string> {
  const expanded = new Set<string>();
  if (!prefix) return expanded;

  const parts = prefix.replace(/\/$/, "").split("/");
  let accumulated = "";
  for (const part of parts) {
    accumulated += `${part}/`;
    expanded.add(accumulated);
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// applySwitch
// ---------------------------------------------------------------------------

/**
 * Compute the next ViewState when the user switches view modes.
 *
 * @param prev  - Current view state before the switch.
 * @param next  - The target view mode.
 * @param items - The current listing used to validate/adjust selection.
 *                (Unused for simple 1:1 preservation modes; consumed by
 *                Column reset and FlatKey collapse in tasks 29/30.)
 * @returns     A new ViewState. `prev` is never mutated.
 *
 * Rules:
 *   - Details / IconGrid / Gallery / Tree: preserve location and selection
 *     (1:1, no adjustment).
 *   - Tree: additionally seeds `treeExpanded` with the chain of prefixes
 *     needed to show the current `location.prefix` (if not already set).
 *   - Column (entry from any other mode AND parent-column change in
 *     Column→Column): preserve location; deeper-column selection resets.
 *     This is the `*-to-Column` rule from design §View Modes And Selection.
 *   - FlatKey: preserve location; collapse virtual-folder selections.
 *     Entries with `isPrefix === true` are removed from the selection because
 *     flat view has no folders (the underlying objects may still be present
 *     under a different key). Object (non-prefix) keys are preserved.
 *   - DualPane: entry copies the current pane's location to both panes;
 *     exit returns the active pane's state. The `panes` field carries the
 *     resolved pair for the store to consume.
 */
export function applySwitch(
  prev: ViewState,
  next: ViewMode,
  items: ObjectEntry[],
): ViewState {
  switch (next) {
    // ---- 1:1 preservation modes (task 28) ------------------------------------
    case "Details":
    case "IconGrid":
    case "Gallery":
      return {
        location: prev.location,
        viewMode: next,
        selection: new Set(prev.selection),
        treeExpanded: prev.treeExpanded,
        columnPath: prev.columnPath,
      };

    // ---- Tree (task 29) -------------------------------------------------------
    // Preserve location and selection (same as Details group).
    // Seed `treeExpanded` with the prefix chain so the current location is
    // visible when first entering Tree view.
    case "Tree": {
      const existingExpanded = prev.treeExpanded ?? new Set<string>();
      const seedExpanded = prev.location?.prefix
        ? expandPathPrefixes(prev.location.prefix)
        : new Set<string>();
      // Merge: keep any folders the user manually expanded before, plus
      // add the seed chain so the current location is visible.
      const merged = new Set([...existingExpanded, ...seedExpanded]);
      return {
        location: prev.location,
        viewMode: "Tree",
        selection: new Set(prev.selection),
        treeExpanded: merged,
        columnPath: prev.columnPath,
      };
    }

    // ---- Column (task 29) — *-to-Column rule ---------------------------------
    // Preserve location; deeper-column selection resets.
    //
    // "Deeper" means: the column corresponding to `location.prefix` is
    // considered the active column, and any selection to its right is dropped.
    // In practice this means `columnPath` is truncated to only the path
    // implied by `location.prefix`, and the single-column selection becomes
    // the entry matching `location.prefix`'s immediate parent (if any).
    //
    // Test name (verbatim per design.md residual #2):
    //   xToColumnPreservesLocationButResetsDeeperSelection
    case "Column": {
      // Preserve only the prefix-matched column path — entries in deeper
      // columns (beyond the current prefix) are discarded.
      // We reconstruct a minimal columnPath from location.prefix so the user
      // lands in the right column without stale deeper selections.
      const loc = prev.location;
      let restoredPath: ObjectEntry[] = [];

      if (loc?.prefix && prev.columnPath) {
        // Keep only entries in columnPath whose key is a proper prefix of
        // location.prefix (i.e. they are ancestors of the current location).
        restoredPath = prev.columnPath.filter(
          (entry) =>
            entry.isPrefix &&
            loc.prefix.startsWith(entry.key) &&
            entry.key !== loc.prefix,
        );
      }

      return {
        location: prev.location,
        viewMode: "Column",
        // Selection resets: deeper-column selections are dropped.
        selection: new Set<string>(),
        treeExpanded: prev.treeExpanded,
        columnPath: restoredPath,
      };
    }

    // ---- FlatKey (task 30) ---------------------------------------------------
    // Preserve location.
    // Collapse virtual-folder selections: any key in `prev.selection` that
    // corresponds to a prefix entry (isPrefix === true in `items`) is dropped
    // because flat view has no folder nodes — only real objects are selectable.
    //
    // The `items` parameter must be the current listing (from objectsList with
    // delimiter) so we can identify which selected keys are folders vs objects.
    case "FlatKey": {
      // Build a set of prefix keys visible in the current listing.
      const prefixKeys = new Set(
        items.filter((e) => e.isPrefix).map((e) => e.key),
      );

      // Retain only object keys (those NOT in the prefix set).
      const collapsed = new Set(
        Array.from(prev.selection).filter((k) => !prefixKeys.has(k)),
      );

      return {
        location: prev.location,
        viewMode: "FlatKey",
        selection: collapsed,
        treeExpanded: prev.treeExpanded,
        columnPath: prev.columnPath,
      };
    }

    // ---- DualPane (task 30) --------------------------------------------------
    // Entry: copies the current pane's location to both panes.
    // The `panes` field in the returned ViewState signals to the store that
    // a second pane should be created with the same location.
    //
    // The selection and location of the returning ViewState represent the
    // *active* pane's state (this is used by exit to restore single-pane).
    case "DualPane": {
      const panesSnapshot = [
        {
          id: "main",
          location: prev.location,
          viewMode: prev.viewMode as ViewMode,
        },
        {
          id: "secondary",
          location: prev.location,
          viewMode: prev.viewMode as ViewMode,
        },
      ];

      return {
        location: prev.location,
        viewMode: "DualPane",
        selection: new Set(prev.selection),
        treeExpanded: prev.treeExpanded,
        columnPath: prev.columnPath,
        panes: panesSnapshot,
      };
    }
  }
}
