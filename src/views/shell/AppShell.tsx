/**
 * AppShell — root three-pane layout.
 *
 * Layout (left → right):
 *   [Sidebar 260px default] | [File list area] | [Preview pane 320px default]
 *
 * Resizable gutters via react-resizable-panels. Panel sizes are persisted
 * in `useUiStore` (localStorage) so they survive across sessions.
 *
 * Slot placeholders:
 * - `<Sidebar />` (real component).
 * - `<FileListPlaceholder />` — stub until tasks 27-29 land.
 * - `<PreviewPlaceholder />` — stub until tasks 31+ land.
 *
 * A11y baseline (Decision D5):
 * - Skip-to-main-content link: first focusable element, visible on focus.
 * - `nav` landmark: sidebar.
 * - `main` landmark: file list area.
 * - Status bar at bottom: `contentinfo` role.
 * - Documented tab order: skip-link → sidebar → main → preview → status bar.
 *
 * OCP:
 * - Panel widths are driven by `useUiStore`; switching to per-pane widths is
 *   one field rename.
 * - Collapsing the sidebar hides the panel; restoring it picks up the stored
 *   width.
 */

import type { PanelSize } from "react-resizable-panels";
import { Group, Panel, Separator } from "react-resizable-panels";
import { useInspectorStore } from "@/store/inspector";
import { usePanesStore } from "@/store/panes";
import { useUiStore } from "@/store/ui";
import { Breadcrumb } from "@/views/browser/Breadcrumb";
import { BucketListView } from "@/views/browser/BucketListView";
import { DropZone } from "@/views/browser/DropZone";
import { Toolbar } from "@/views/browser/Toolbar";
import { ViewModeDispatcher } from "@/views/browser/ViewModeDispatcher";
import { InspectorPanel } from "@/views/inspector/InspectorPanel";
import { PreviewPane } from "@/views/preview/PreviewPane";
import { Sidebar } from "@/views/sidebar/Sidebar";
import { ActivityCenter } from "@/views/transfers/ActivityCenter";
import { ErrorBoundary } from "./ErrorBoundary";
import { StatusBar } from "./StatusBar";

// `useInspectorShortcut` is intentionally NOT mounted here anymore —
// `view.inspect` carries `defaultShortcut: { key: "i", mod: ["cmd"] }`
// (registered by Toolbar.tsx) and is now dispatched by `useGlobalShortcuts`
// which is mounted once at the App root. Mounting both would double-fire
// Cmd+I and open the inspector twice per keystroke.

// ---------------------------------------------------------------------------
// Main-pane content
//
// Three-state machine driven by the active pane's location:
//   1. No profile selected     → "select a profile" placeholder.
//   2. Profile, no bucket      → BucketListView for that profile.
//   3. Profile + bucket        → ViewModeDispatcher (Details / IconGrid / …).
//
// Only state (3) wraps in DropZone — uploads need a target bucket.
// ---------------------------------------------------------------------------

interface MainPaneContentProps {
  pane: import("@/store/panes").Pane;
}

function MainPaneContent({ pane }: MainPaneContentProps) {
  const activityCenterOpen = useUiStore((s) => s.activityCenterOpen);

  // The Activity Center is a top-level destination: when it's open, it
  // owns the main pane entirely (preview/inspector still visible if the
  // user has them up, but the file browser is hidden so the user has a
  // calm surface to review transfer history).
  if (activityCenterOpen) {
    return <ActivityCenter />;
  }

  const location = pane.location;

  if (!location?.profileId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
        <p className="text-sm">No profile selected</p>
        <p className="text-xs">Pick a profile from the sidebar to start.</p>
      </div>
    );
  }

  if (!location.bucket) {
    return (
      <BucketListView
        profileId={location.profileId}
        activeBucket={location.bucket}
      />
    );
  }

  return (
    <DropZone
      profileId={location.profileId}
      bucket={location.bucket}
      prefix={location.prefix ?? ""}
      className="h-full"
    >
      <ViewModeDispatcher pane={pane} />
    </DropZone>
  );
}

// ---------------------------------------------------------------------------
// AppShell
// ---------------------------------------------------------------------------

export function AppShell() {
  // Cmd+I (inspect) is handled by useGlobalShortcuts mounted at the App
  // root — see the import-site comment for why.

  const {
    sidebarCollapsed,
    sidebarPct,
    previewPct,
    previewCollapsed,
    setSidebarPct,
    setPreviewPct,
  } = useUiStore();

  const inspectorOpen = useInspectorStore((s) => s.open);

  const { panes, activePaneId } = usePanesStore();
  // Always safe: we guarantee at least one pane in the initial store state.
  const activePaneOrUndefined =
    panes.find((p) => p.id === activePaneId) ?? panes[0];
  // Provide a safe fallback (empty pane) in the unlikely case panes is empty.
  const activePane: import("@/store/panes").Pane = activePaneOrUndefined ?? {
    id: "main",
    location: null,
    viewMode: "Details",
    selection: new Set<string>(),
    treeExpanded: new Set<string>(),
    columnPath: [],
    filter: "",
  };

  // We store sizes as percentages (10-50) — react-resizable-panels v4
  // expects percentages on `defaultSize` and reports them on resize.
  function handleSidebarResize(panelSize: PanelSize) {
    setSidebarPct(panelSize.asPercentage);
  }

  function handlePreviewResize(panelSize: PanelSize) {
    setPreviewPct(panelSize.asPercentage);
  }

  return (
    <div className="flex h-screen flex-col bg-background text-foreground">
      {/* Skip-to-main link — off-screen when not focused, visible on focus.
          Uses the sr-only / focus-not-sr-only pattern so keyboard-only
          users see it while it is completely invisible to pointer users. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-background focus:px-3 focus:py-1 focus:text-sm focus:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Skip to main content
      </a>

      {/* Three-pane body */}
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" className="h-full">
          {/* Sidebar */}
          {!sidebarCollapsed && (
            <>
              <Panel
                defaultSize={`${sidebarPct}%`}
                minSize="10%"
                maxSize="60%"
                onResize={handleSidebarResize}
                className="border-r"
              >
                <Sidebar />
              </Panel>
              <Separator
                className="group relative flex w-1.5 cursor-col-resize items-center justify-center bg-border transition-colors hover:bg-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[resize-handle-state=drag]:bg-ring"
                aria-label="Resize sidebar"
              />
            </>
          )}

          {/* File list (main pane). NOTE: react-resizable-panels v4 treats a
              bare number as PIXELS — sizes must be passed as "%"-suffixed
              strings to mean percentage of the group. */}
          <Panel
            defaultSize={`${Math.max(20, 100 - sidebarPct - previewPct)}%`}
            minSize="20%"
            className="flex flex-col"
          >
            {/* Breadcrumb chrome */}
            <div className="flex items-center gap-2 border-b px-3 py-1.5">
              <Breadcrumb
                paneId={activePane.id}
                location={activePane.location}
              />
            </div>

            {/* Toolbar — Refresh, Up, View mode, Inspect, Search, Sort */}
            <Toolbar />

            {/* Main content area — three-state dispatcher (no profile /
                profile-only / profile + bucket). DropZone wrapping is owned
                by the inner component so it only activates when a bucket
                is selected. */}
            <main
              id="main-content"
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-auto outline-none"
              aria-label="File list"
            >
              <ErrorBoundary
                resetKey={`${activePane.id}|${activePane.location?.profileId ?? ""}|${activePane.location?.bucket ?? ""}|${activePane.location?.prefix ?? ""}`}
              >
                <MainPaneContent pane={activePane} />
              </ErrorBoundary>
            </main>
          </Panel>

          {/* Preview pane — hidden when collapsed */}
          {!previewCollapsed && (
            <>
              <Separator
                className="group relative flex w-1.5 cursor-col-resize items-center justify-center bg-border transition-colors hover:bg-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[resize-handle-state=drag]:bg-ring"
                aria-label="Resize preview pane"
              />
              <Panel
                defaultSize={`${previewPct}%`}
                minSize="15%"
                maxSize="80%"
                onResize={handlePreviewResize}
              >
                <aside aria-label="Preview" className="flex h-full border-l">
                  <div className="min-w-0 flex-1 overflow-auto">
                    <PreviewPane />
                  </div>
                  {inspectorOpen && <InspectorPanel />}
                </aside>
              </Panel>
            </>
          )}
        </Group>
      </div>

      {/* Status bar — the footer carries its implicit contentinfo role.
          An inner div with role="status" announces content changes politely
          to screen readers without overriding the footer's landmark role. */}
      <StatusBar pane={activePane} />
    </div>
  );
}
