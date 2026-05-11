/**
 * ViewModeDispatcher — mounts the correct view-mode component for the
 * active pane and wires it to the panes store.
 *
 * Contract:
 *   - Caller passes a pane whose `location.bucket` is non-null. The
 *     "select a bucket" path is handled one layer above (BucketListView).
 *   - This component is responsible only for switching between view modes
 *     and wiring navigation callbacks. Selection, preview, and inspector
 *     state are managed inside the view components via their own stores.
 *
 * OCP: adding a new view mode = one new `case` here referencing the
 * already-typed component. The view components stay unchanged.
 */

import type { ObjectEntry } from "@/api/objects";
import { profileValidate } from "@/api/profiles";
import type { Pane } from "@/store/panes";
import { usePanesStore } from "@/store/panes";
import { ColumnView } from "@/views/modes/ColumnView";
import { DetailsView } from "@/views/modes/DetailsView";
import { DualPaneView } from "@/views/modes/DualPaneView";
import { FlatKeyView } from "@/views/modes/FlatKeyView";
import { GalleryView } from "@/views/modes/GalleryView";
import { IconGridView } from "@/views/modes/IconGridView";
import { TreeView } from "@/views/modes/TreeView";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Strip the trailing path segment from an S3 prefix.
 *   "a/b/c/" → "a/b/"
 *   "a/"    → ""
 *   ""      → ""
 */
function parentPrefix(prefix: string): string {
  if (!prefix || prefix === "/") return "";
  const stripped = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  const lastSlash = stripped.lastIndexOf("/");
  return lastSlash >= 0 ? stripped.slice(0, lastSlash + 1) : "";
}

// ---------------------------------------------------------------------------
// ViewModeDispatcher
// ---------------------------------------------------------------------------

interface ViewModeDispatcherProps {
  pane: Pane;
}

export function ViewModeDispatcher({ pane }: ViewModeDispatcherProps) {
  const setLocation = usePanesStore((s) => s.setLocation);
  const setSelection = usePanesStore((s) => s.setSelection);
  const treeExpand = usePanesStore((s) => s.treeExpand);
  const treeCollapse = usePanesStore((s) => s.treeCollapse);
  const setColumnPath = usePanesStore((s) => s.setColumnPath);

  // The caller guarantees a valid bucketed location, but TypeScript wants
  // explicit narrowing. Fall through to "no bucket" state defensively.
  const location = pane.location;
  if (!location?.bucket) {
    return null;
  }
  const { profileId, bucket, prefix } = location;

  // ---------- Navigation handlers shared by all view modes -----------------

  /**
   * Open an entry:
   *   - folder/prefix → drill into it via setLocation
   *   - object        → seed the pane's selection so PreviewPane / Inspector
   *                     pick it up (matches the behaviour of click + Enter
   *                     in DetailsView and friends).
   *
   * Wiring this here means ColumnView and TreeView — which don't carry their
   * own useSelection state — still produce previews on click.
   */
  function handleOpen(entry: ObjectEntry) {
    if (entry.isPrefix) {
      setLocation(pane.id, { profileId, bucket, prefix: entry.key });
    } else {
      setSelection(pane.id, new Set([entry.key]));
    }
  }

  function handleNavigateUp() {
    setLocation(pane.id, {
      profileId,
      bucket,
      prefix: parentPrefix(prefix),
    });
  }

  /** Invoked from a view's empty/gated state when the user clicks "validate". */
  function handleValidateProfile() {
    void profileValidate(profileId);
  }

  // ---------- View-mode switch --------------------------------------------

  switch (pane.viewMode) {
    case "Details":
      return (
        <DetailsView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          onOpen={handleOpen}
          onNavigateUp={handleNavigateUp}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "IconGrid":
      return (
        <IconGridView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          onOpen={handleOpen}
          onNavigateUp={handleNavigateUp}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "Gallery":
      return (
        <GalleryView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          onOpen={handleOpen}
          onNavigateUp={handleNavigateUp}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "Tree":
      return (
        <TreeView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          expanded={pane.treeExpanded}
          onExpand={(key) => treeExpand(pane.id, key)}
          onCollapse={(key) => treeCollapse(pane.id, key)}
          onOpen={handleOpen}
          onNavigateUp={handleNavigateUp}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "Column":
      return (
        <ColumnView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          columnPath={pane.columnPath}
          onColumnPathChange={(newPath) => setColumnPath(pane.id, newPath)}
          onOpen={handleOpen}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "FlatKey":
      return (
        <FlatKeyView
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          onOpen={handleOpen}
          onNavigateUp={handleNavigateUp}
          onValidateProfile={handleValidateProfile}
        />
      );

    case "DualPane":
      // DualPaneView manages its own panes via the store; the active pane's
      // mode is the prop driving the *content* of each sub-pane, but exit
      // handling is reserved for a later task.
      return <DualPaneView />;
  }
}
