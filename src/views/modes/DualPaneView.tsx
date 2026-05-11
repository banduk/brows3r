/**
 * DualPaneView — two side-by-side independent panes.
 *
 * Each pane has its own `Pane` state (location, view mode, selection). The
 * active pane is indicated by a border highlight. Tab key switches the active
 * pane.
 *
 * Architecture:
 * - `usePanesStore` is the single source of truth. When DualPane is active, the
 *   store has `panes.length === 2` (ensured by the store's `splitPane` action).
 * - Each pane renders a sub-DetailsView wired to its own location/selection.
 * - `data-pane-id` attribute is added to each pane's outer container for
 *   drag-and-drop targeting (task 41).
 *
 * Toolbar above each pane: profile display, breadcrumb summary, view-mode label.
 * Full profile-picker / breadcrumb / view-mode selector are wired as stubs here
 * so task 41 and later tasks have the correct hook locations.
 *
 * OCP:
 * - 3-pane / N-pane: allow `panes.length > 2` by changing the split count.
 * - Sub-mode per pane: `pane.viewMode` already drives which view renders.
 *   Plugging in TreeView / ColumnView per-pane is one switch-case change.
 * - Drag-and-drop (task 41): target `.pane-container[data-pane-id]`.
 *
 * NOTE: Biome useSemanticElements, useKeyWithClickEvents,
 * noStaticElementInteractions suppressed via biome.json override.
 */

import { useCallback, useEffect } from "react";
import type { Pane } from "@/store/panes";
import { usePanesStore } from "@/store/panes";
import { DropZone } from "@/views/browser/DropZone";
import { DetailsView } from "./DetailsView";
import { handleCrossPaneDrop } from "./dnd/crossPaneOps";
import type { DndPayload } from "./dnd/useDragSource";
import { useDropTarget } from "./dnd/useDropTarget";

// ---------------------------------------------------------------------------
// PaneToolbar
// ---------------------------------------------------------------------------

interface PaneToolbarProps {
  pane: Pane;
  isActive: boolean;
}

function PaneToolbar({ pane, isActive }: PaneToolbarProps) {
  const profileLabel = pane.location?.profileId ?? "No profile";
  const locationLabel = pane.location
    ? `${pane.location.bucket ?? "—"} / ${pane.location.prefix || "root"}`
    : "No location";

  return (
    <div
      role="toolbar"
      aria-label={`Pane toolbar — ${isActive ? "active" : "inactive"}`}
      className={`flex items-center gap-2 px-3 py-1.5 border-b text-xs ${
        isActive
          ? "bg-primary/5 text-foreground"
          : "bg-muted/20 text-muted-foreground"
      }`}
    >
      {/* Profile indicator */}
      <span
        className="font-medium truncate"
        data-testid={`pane-profile-${pane.id}`}
      >
        {profileLabel}
      </span>
      <span className="text-muted-foreground/60">|</span>
      {/* Location breadcrumb summary */}
      <span
        className="truncate flex-1"
        data-testid={`pane-location-${pane.id}`}
      >
        {locationLabel}
      </span>
      {/* View mode label */}
      <span
        className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-mono"
        data-testid={`pane-viewmode-${pane.id}`}
      >
        {pane.viewMode}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SinglePane
// ---------------------------------------------------------------------------

interface SinglePaneProps {
  pane: Pane;
  isActive: boolean;
  onActivate: () => void;
  onCrossPaneDrop: (
    payload: DndPayload,
    targetPaneId: string,
    targetBucket: string,
    targetPrefix: string,
    modifierKeys: { shift: boolean },
  ) => void;
}

function SinglePane({
  pane,
  isActive,
  onActivate,
  onCrossPaneDrop,
}: SinglePaneProps) {
  const bucket = pane.location?.bucket ?? null;
  const prefix = pane.location?.prefix ?? "";
  const profileId = pane.location?.profileId ?? null;

  const { isOver, onDragOver, onDragLeave, onDrop } = useDropTarget({
    paneId: pane.id,
    profileId,
    bucket,
    prefix,
    onCrossPaneDrop,
  });

  return (
    <div
      role="region"
      aria-label={`Pane ${pane.id}`}
      className={`flex flex-col flex-1 min-w-0 border-2 transition-colors pane-container ${
        isActive ? "border-primary/60" : "border-transparent"
      } ${isOver ? "ring-2 ring-inset ring-primary" : ""}`}
      data-pane-id={pane.id}
      data-testid={`dual-pane-${pane.id}`}
      onClick={onActivate}
      onFocus={onActivate}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <PaneToolbar pane={pane} isActive={isActive} />

      {/* Pane content wrapped in DropZone for OS→S3 file uploads */}
      <div className="flex-1 min-h-0">
        <DropZone
          profileId={profileId}
          bucket={bucket}
          prefix={prefix}
          className="h-full"
          ariaLabel={`Drop files into pane ${pane.id}`}
        >
          {renderPaneContent(pane)}
        </DropZone>
      </div>
    </div>
  );
}

/**
 * Render the correct view component for the pane's viewMode.
 *
 * v1 defaults to DetailsView for all modes since this is the first pass.
 * Tree/Column/FlatKey sub-modes are wired by adding cases here (OCP).
 */
function renderPaneContent(pane: Pane) {
  const profileId = pane.location?.profileId ?? null;
  const bucket = pane.location?.bucket ?? null;
  const prefix = pane.location?.prefix ?? "";

  // For DualPane v1, all sub-panes render as DetailsView by default.
  // Task 41 and future tasks add per-pane mode switching here.
  return <DetailsView profileId={profileId} bucket={bucket} prefix={prefix} />;
}

// ---------------------------------------------------------------------------
// DualPaneView
// ---------------------------------------------------------------------------

export interface DualPaneViewProps {
  /**
   * Called when the DualPane view wants to exit (e.g. via keyboard shortcut).
   * The active pane's state should be restored to the single-pane store.
   * Reserved for task 41 — not wired in v1.
   */
  onExitDualPane?: () => void;
}

/**
 * Dual-pane view: two side-by-side independent browsing panes.
 *
 * `onExitDualPane` is a reserved hook for task 41 (keyboard exit from
 * dual-pane mode). It is accepted in props so callers can wire it without
 * touching this component; it is intentionally unused until task 41.
 */
export function DualPaneView(_props: DualPaneViewProps) {
  const { panes, activePaneId, setActivePane, splitPane } = usePanesStore();

  // Ensure we have exactly 2 panes when entering DualPane mode.
  // splitPane() is idempotent when panes.length === 2.
  useEffect(() => {
    if (panes.length < 2) {
      splitPane();
    }
  }, [panes.length, splitPane]);

  const visiblePanes = panes.slice(0, 2);

  const handleTabKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === "Tab") {
        e.preventDefault();
        // Cycle between the two panes.
        const currentIndex = visiblePanes.findIndex(
          (p) => p.id === activePaneId,
        );
        const nextIndex = (currentIndex + 1) % visiblePanes.length;
        const nextPane = visiblePanes[nextIndex];
        if (nextPane) {
          setActivePane(nextPane.id);
        }
      }
    },
    [visiblePanes, activePaneId, setActivePane],
  );

  // Cross-pane drop handler: decides move vs copy and fires the right S3 op.
  const onCrossPaneDrop = useCallback(
    (
      payload: DndPayload,
      targetPaneId: string,
      targetBucket: string,
      targetPrefix: string,
      modifierKeys: { shift: boolean },
    ) => {
      void handleCrossPaneDrop({
        payload,
        targetPaneId,
        targetBucket,
        targetPrefix,
        modifierKeys,
      });
    },
    [],
  );

  if (visiblePanes.length < 2) {
    // Still initialising — show a placeholder.
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Initialising dual pane…
      </div>
    );
  }

  return (
    <div
      className="flex h-full flex-row gap-0 overflow-hidden"
      role="group"
      aria-label="Dual pane view"
      onKeyDown={handleTabKey}
      data-testid="dual-pane-view"
    >
      {visiblePanes.map((pane) => (
        <SinglePane
          key={pane.id}
          pane={pane}
          isActive={pane.id === activePaneId}
          onActivate={() => setActivePane(pane.id)}
          onCrossPaneDrop={onCrossPaneDrop}
        />
      ))}
    </div>
  );
}
