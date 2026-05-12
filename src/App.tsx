/**
 * App root.
 *
 * Mounts:
 * - QueryClientProvider (TanStack Query)
 * - Theme (light/dark/system)
 * - FirstRun welcome modal (gates itself on the persisted flag)
 * - AppShell (three-pane layout, sidebar, breadcrumb, a11y baseline)
 * - CommandPalette (global, Cmd/Ctrl+K)
 * - Toaster (toast notifications)
 * - KeychainFallbackPrompt (shown when OS keychain is unavailable)
 * - TransferManager (slide-up panel, mirrors backend transfer events)
 * - SettingsScreen (shown on settings:open event, Cmd/Ctrl+,)
 * - SearchBox overlay (Cmd/Ctrl+F, fed with active pane's cached entries)
 *
 * Navigation commands registered at module load time:
 * - `view.refresh` — invalidate the active pane's query cache.
 * - `nav.up` — strip the trailing prefix segment.
 * - `nav.back` / `nav.forward` — per-pane history (src/store/history.ts).
 *
 * Subscriptions installed on mount:
 * - Tauri event bridge (objects/buckets/transfers/locks/notifications/...).
 * - Native menu bridge (menu:* events → registry dispatch).
 * - Per-pane navigation history tracker.
 * - Recents auto-tracker (panes location → recents store, AC-10).
 */

import { QueryClientProvider } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useEffect, useMemo, useState } from "react";
import type { ListPage } from "@/api/objects";
import type { EntryRef } from "@/api/search";
import { registry } from "@/commands/registry";
import { keys } from "@/query/keys";
// Side-effect imports: each module registers its commands with the registry
// at load time so they are reachable from the command palette, context menus,
// keyboard shortcuts, and native menus. Without these imports the modules
// stay tree-shaken out and their commands silently disappear from the UI.
import "@/commands/definitions/bookmarks";
import "@/commands/definitions/file";
import "@/commands/definitions/profile";
import "@/commands/definitions/search";
import "@/commands/definitions/settings";
import { installMenuBridge } from "@/commands/menuBridge";
import { surfaceUnknownError } from "@/lib/errors";
import { installEventBridge, queryClient } from "@/query/client";
import { usePeriodicProfileRefresh } from "@/query/hooks/usePeriodicProfileRefresh";
import {
  back as historyBack,
  forward as historyForward,
  installHistoryTracker,
} from "@/store/history";
import { usePanesStore } from "@/store/panes";
import type { ViewMode } from "@/store/ui";
import { useUiStore } from "@/store/ui";
import { DiffPreviewModal } from "@/views/diff/DiffPreviewModal";
import { Toaster } from "@/views/notifications/Toaster";
import { SearchBox } from "@/views/search/SearchBox";
import { SettingsScreen } from "@/views/settings/SettingsScreen";
import { AppShell } from "@/views/shell/AppShell";
import { CommandPalette } from "@/views/shell/CommandPalette";
import { ErrorBoundary } from "@/views/shell/ErrorBoundary";
import { FirstRun } from "@/views/shell/FirstRun";
import {
  KeychainFallbackPrompt,
  useKeychainFallback,
} from "@/views/shell/KeychainFallbackPrompt";
import { Theme } from "@/views/shell/Theme";
import { UpdaterPrompt, useUpdaterStatus } from "@/views/shell/UpdaterPrompt";
import { useGlobalShortcuts } from "@/views/shell/useGlobalShortcuts";
import { usePaletteShortcut } from "@/views/shell/usePaletteShortcut";
import { useRecentAutoTrack } from "@/views/sidebar/Recents";
import { BulkDownloadHost } from "@/views/transfers/BulkDownloadHost";
import { TransferManager } from "@/views/transfers/TransferManager";

// ---------------------------------------------------------------------------
// Navigation command stubs
// Register now so the palette can list them; real impl lands in tasks 27-30.
// Guard with a try/catch because the registry throws on duplicate ids and
// this module may be loaded in HMR contexts.
// ---------------------------------------------------------------------------

function tryRegister(def: Parameters<typeof registry.register>[0]) {
  try {
    registry.register(def);
  } catch {
    // Already registered (HMR re-import) — ignore.
  }
}

tryRegister({
  id: "view.refresh",
  title: "Refresh",
  group: "View",
  defaultShortcut: { key: "r", mod: ["cmd"] },
  run(_ctx) {
    queryClient.invalidateQueries();
  },
});

tryRegister({
  id: "nav.up",
  title: "Navigate Up",
  group: "Navigation",
  run(_ctx) {
    const state = usePanesStore.getState();
    const pane = state.panes.find((p) => p.id === state.activePaneId);
    if (!pane?.location) return;
    const prefix = pane.location.prefix;

    // Already at the bucket root → escape to the bucket list (bucket=null)
    // so the user can keep going "up" past the bucket boundary.
    if (!prefix || prefix === "" || prefix === "/") {
      if (pane.location.bucket) {
        state.setLocation(pane.id, {
          profileId: pane.location.profileId,
          bucket: null,
          prefix: "",
        });
      }
      return;
    }

    // Strip trailing "/" then strip the last path segment to find the parent.
    const stripped = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
    const lastSlash = stripped.lastIndexOf("/");
    const parent = lastSlash >= 0 ? stripped.slice(0, lastSlash + 1) : "";
    state.setLocation(pane.id, { ...pane.location, prefix: parent });
  },
});

tryRegister({
  id: "nav.back",
  title: "Navigate Back",
  group: "Navigation",
  run(_ctx) {
    const { activePaneId } = usePanesStore.getState();
    historyBack(activePaneId);
  },
});

tryRegister({
  id: "nav.forward",
  title: "Navigate Forward",
  group: "Navigation",
  run(_ctx) {
    const { activePaneId } = usePanesStore.getState();
    historyForward(activePaneId);
  },
});

// ---------------------------------------------------------------------------
// Menu-targeted commands
//
// Each `Go` / `View` / `Edit` / `File` / `Help` menu item in `menus.rs`
// dispatches an event of the form `menu:<group>/<id>` which the menu
// bridge converts to a registry command `<group>.<id>` (slash → dot).
// The commands below cover every item the native menu surfaces so a
// menu click — *and* the matching keyboard shortcut via
// `useGlobalShortcuts` — does the same thing as the equivalent toolbar
// button.
// ---------------------------------------------------------------------------

// --- Go: delegate to existing nav.* commands -----------------------------
tryRegister({
  id: "go.back",
  title: "Go Back",
  group: "Navigation",
  defaultShortcut: {
    mac: { key: "[", mod: ["cmd"] },
    default: { key: "[", mod: ["ctrl"] },
  },
  run(ctx) {
    registry.lookupById("nav.back")?.run(ctx);
  },
});

tryRegister({
  id: "go.forward",
  title: "Go Forward",
  group: "Navigation",
  defaultShortcut: {
    mac: { key: "]", mod: ["cmd"] },
    default: { key: "]", mod: ["ctrl"] },
  },
  run(ctx) {
    registry.lookupById("nav.forward")?.run(ctx);
  },
});

tryRegister({
  id: "go.up",
  title: "Go Up",
  group: "Navigation",
  defaultShortcut: {
    mac: { key: "ArrowUp", mod: ["cmd"] },
    default: { key: "ArrowUp", mod: ["ctrl"] },
  },
  run(ctx) {
    registry.lookupById("nav.up")?.run(ctx);
  },
});

tryRegister({
  id: "go.bookmarks",
  title: "Focus Bookmarks",
  group: "Navigation",
  run(_ctx) {
    // Scroll the bookmarks section into view. Best-effort — when the
    // sidebar is collapsed the user still gets useful feedback by
    // toggling it open.
    const node = document.querySelector('[aria-label="Bookmarks"]');
    if (node instanceof HTMLElement) {
      node.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // Sidebar collapsed: open it so the bookmarks section appears.
      const ui = useUiStore.getState();
      if (ui.sidebarCollapsed) ui.toggleSidebar();
    }
  },
});

// --- View: sidebar / preview / mode --------------------------------------
tryRegister({
  id: "view.toggle-sidebar",
  title: "Toggle Sidebar",
  group: "View",
  defaultShortcut: {
    mac: { key: "b", mod: ["cmd"] },
    default: { key: "b", mod: ["ctrl"] },
  },
  run(_ctx) {
    useUiStore.getState().toggleSidebar();
  },
});

tryRegister({
  id: "view.toggle-preview",
  title: "Toggle Preview",
  group: "View",
  defaultShortcut: {
    mac: { key: "/", mod: ["cmd"] },
    default: { key: "/", mod: ["ctrl"] },
  },
  run(_ctx) {
    useUiStore.getState().togglePreview();
  },
});

// --- View: transfer manager / activity center ----------------------------
tryRegister({
  id: "view.toggle-transfers",
  title: "Toggle Transfer Manager (popup)",
  group: "View",
  description: "Show / hide the floating transfer manager popup.",
  defaultShortcut: {
    mac: { key: "j", mod: ["cmd", "shift"] },
    default: { key: "j", mod: ["ctrl", "shift"] },
  },
  async run(_ctx) {
    const { useTransfersStore } = await import("@/store/transfers");
    useTransfersStore.getState().togglePanel();
  },
});

tryRegister({
  id: "view.activity-center",
  title: "Toggle Activity Center",
  group: "View",
  description:
    "Open the full-pane Activity Center with transfer history, filters, search and session stats.",
  defaultShortcut: {
    mac: { key: "a", mod: ["cmd", "shift"] },
    default: { key: "a", mod: ["ctrl", "shift"] },
  },
  run(_ctx) {
    useUiStore.getState().toggleActivityCenter();
  },
});

const VIEW_MODE_BINDINGS: ReadonlyArray<{
  id: string;
  mode: ViewMode;
  digit: string;
  label: string;
}> = [
  {
    id: "view.mode.details",
    mode: "Details",
    digit: "1",
    label: "View · Details",
  },
  {
    id: "view.mode.icon-grid",
    mode: "IconGrid",
    digit: "2",
    label: "View · Icon Grid",
  },
  {
    id: "view.mode.gallery",
    mode: "Gallery",
    digit: "3",
    label: "View · Gallery",
  },
  {
    id: "view.mode.column",
    mode: "Column",
    digit: "4",
    label: "View · Column",
  },
  { id: "view.mode.tree", mode: "Tree", digit: "5", label: "View · Tree" },
  {
    id: "view.mode.flat-key",
    mode: "FlatKey",
    digit: "6",
    label: "View · Flat Key",
  },
  {
    id: "view.mode.dual-pane",
    mode: "DualPane",
    digit: "7",
    label: "View · Dual Pane",
  },
];

for (const { id, mode, digit, label } of VIEW_MODE_BINDINGS) {
  tryRegister({
    id,
    title: label,
    group: "View",
    defaultShortcut: {
      mac: { key: digit, mod: ["cmd"] },
      default: { key: digit, mod: ["ctrl"] },
    },
    run(_ctx) {
      const { activePaneId, setViewMode } = usePanesStore.getState();
      setViewMode(activePaneId, mode);
    },
  });
}

// --- Edit: find — delegates to the existing search.local command --------
// `search.local` already owns the Cmd+F shortcut (its definition lives in
// `commands/definitions/search.ts`). This alias only exists so the
// `menu:edit/find` menu entry routes to a registered id; the actual UX
// (opening the search overlay) flows through `search:open` which both
// commands dispatch identically.
tryRegister({
  id: "edit.find",
  title: "Find in Bucket…",
  group: "Edit",
  run(ctx) {
    registry.lookupById("search.local")?.run(ctx);
  },
});

// --- File: New Folder maps to file.create_folder via dialog --------------
// menu:file/new-folder → bridge → file.new-folder (this command). Bridges
// to the existing `file:open-create-folder` event that App.tsx listens to.
tryRegister({
  id: "file.new-folder",
  title: "New Folder",
  group: "File",
  defaultShortcut: {
    mac: { key: "n", mod: ["cmd", "shift"] },
    default: { key: "n", mod: ["ctrl", "shift"] },
  },
  run(_ctx) {
    const { activePaneId, panes } = usePanesStore.getState();
    const pane = panes.find((p) => p.id === activePaneId);
    if (!pane?.location?.bucket) return;
    window.dispatchEvent(
      new CustomEvent("file:open-create-folder", {
        detail: {
          profileId: pane.location.profileId,
          bucket: pane.location.bucket,
          prefix: pane.location.prefix ?? "",
        },
      }),
    );
  },
});

// menu:file/save → "Save" — placeholder. Triggers a `file:save`
// window event the editor can listen to in a later batch; today no
// editor is mounted that responds to it, so this is intentionally a
// no-op that at least makes the menu item dispatch *something* the
// devtools Console can see.
tryRegister({
  id: "file.save",
  title: "Save",
  group: "File",
  defaultShortcut: {
    mac: { key: "s", mod: ["cmd"] },
    default: { key: "s", mod: ["ctrl"] },
  },
  run(_ctx) {
    window.dispatchEvent(new CustomEvent("file:save"));
  },
});

// --- Help -----------------------------------------------------------------
tryRegister({
  id: "help.docs",
  title: "Open Documentation",
  group: "Help",
  run(_ctx) {
    void openUrl("https://banduk.github.io/brows3r/");
  },
});

tryRegister({
  id: "help.report-bug",
  title: "Report a Bug",
  group: "Help",
  run(_ctx) {
    void openUrl("https://github.com/banduk/brows3r/issues/new");
  },
});

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/**
 * App: only mounts the QueryClientProvider so AppContent's hooks (which
 * include `useQueryClient`, `useRecentAutoTrack`, etc.) see the client
 * via context. Putting these hooks in App() itself would run them
 * BEFORE the JSX is rendered — context isn't established at that point,
 * so useQueryClient would throw "No QueryClient set".
 */
function App() {
  return (
    <ErrorBoundary scope="root">
      <QueryClientProvider client={queryClient}>
        <AppContent />
      </QueryClientProvider>
    </ErrorBoundary>
  );
}

/**
 * Everything that needs the QueryClient (or any other context provider
 * declared above) goes here. AppContent is a descendant of every
 * provider mounted by App, so its hooks resolve context cleanly.
 */
function AppContent() {
  // Register global Cmd/Ctrl+K shortcut for the command palette.
  // (palette.open is not a registered command — handled here directly.)
  usePaletteShortcut();

  // Dispatch every other registry command's `defaultShortcut` from a
  // single window-level keydown listener. Covers Cmd+R refresh, Cmd+1..7
  // view modes, Cmd+B toggle sidebar, Cmd+/ toggle preview, Cmd+[ / ] / ↑
  // for navigation, Cmd+F find, Cmd+I inspect, etc.
  useGlobalShortcuts();

  // Auto-track pane location changes into the recents store (AC-10).
  useRecentAutoTrack();

  // Opt-in periodic profile re-validation. No-op when disabled in Settings.
  usePeriodicProfileRefresh();

  // Updater banner state. Resets `dismissed` when a new status flows in
  // so a fresh "Available" replaces a previously dismissed one.
  const updaterStatus = useUpdaterStatus();
  const [updaterDismissed, setUpdaterDismissed] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: updaterStatus is intentionally the trigger; the effect resets state on its change.
  useEffect(() => {
    setUpdaterDismissed(false);
  }, [updaterStatus]);

  // Keychain fallback prompt state.
  const { open: keychainOpen, closePrompt: closeKeychain } =
    useKeychainFallback();

  // SearchBox overlay state.
  const [searchOpen, setSearchOpen] = useState(false);

  // Active pane info for SearchBox.
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const activePane = usePanesStore((s) =>
    s.panes.find((p) => p.id === s.activePaneId),
  );
  const location = activePane?.location ?? null;

  // Pull cached object listing for the active pane to feed SearchBox's
  // local-filter mode. Reads from TanStack Query cache without triggering
  // a fetch (returns undefined if no listing has been loaded yet).
  //
  // The cache holds `InfiniteData<ListPage>` because the views use
  // `useInfiniteQuery`. We accept either shape defensively — the legacy
  // single-page shape would still appear if a non-infinite query ever
  // populated the key.
  const filterEntries = useMemo<EntryRef[]>(() => {
    if (!location) return [];
    const { profileId, bucket, prefix } = location;
    if (!profileId || !bucket) return [];
    const cached = queryClient.getQueryData<ListPage | { pages: ListPage[] }>(
      keys.objects(profileId, bucket, prefix),
    );
    if (!cached) return [];
    const pages: ListPage[] =
      "pages" in cached && Array.isArray(cached.pages)
        ? cached.pages
        : "entries" in cached
          ? [cached]
          : [];
    const out: EntryRef[] = [];
    for (const page of pages) {
      if (!page?.entries) continue;
      for (const e of page.entries) {
        out.push({
          key: e.key,
          size: e.size,
          lastModified: e.lastModified,
          isPrefix: e.isPrefix,
        });
      }
    }
    return out;
  }, [location]);

  // Open search via Cmd/Ctrl+F shortcut.
  useEffect(() => {
    function handleSearchOpen() {
      setSearchOpen(true);
    }
    window.addEventListener("search:open", handleSearchOpen);
    return () => window.removeEventListener("search:open", handleSearchOpen);
  }, []);

  // Bridge `file:open-create-folder` (dispatched by the blank-area
  // context menu) to a user prompt + the file.create_folder registry
  // command. Same UX as the Toolbar's New Folder button.
  useEffect(() => {
    async function onOpenCreateFolder(e: Event) {
      const detail = (
        e as CustomEvent<{ profileId: string; bucket: string; prefix: string }>
      ).detail;
      const name = window.prompt("New folder name:")?.trim();
      if (!name) return;
      const cmd = registry.lookupById("file.create_folder");
      // `cmd.run` itself surfaces its own errors via surfaceUnknownError, but
      // if the registry lookup fails or run throws unexpectedly (mis-wired
      // command, internal bug) the listener used to silently die. Wrap so
      // the user at least sees that the action did not work.
      try {
        await cmd?.run({
          profileId: detail.profileId,
          bucket: detail.bucket,
          prefix: detail.prefix,
          folderName: name,
          queryClient,
        });
      } catch (err) {
        await surfaceUnknownError(err, {
          operation: "file.create_folder.dispatch",
          resource: `${detail.bucket}/${detail.prefix}${name}/`,
          title: "Failed to create folder",
        });
      }
    }
    window.addEventListener("file:open-create-folder", onOpenCreateFolder);
    return () =>
      window.removeEventListener("file:open-create-folder", onOpenCreateFolder);
  }, []);

  // Install the Tauri event bridge on mount. If this fails the app keeps
  // running but never receives backend events — transfers freeze, locks
  // never release in the UI, notifications stop streaming. Surface the
  // failure once so the user sees *something* instead of a silently dead
  // app.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    installEventBridge()
      .then((fn) => {
        cleanup = fn;
      })
      .catch((err) =>
        surfaceUnknownError(err, {
          operation: "install_event_bridge",
          title: "Event bridge failed to install",
        }),
      );
    return () => {
      cleanup?.();
    };
  }, []);

  // Install the native menu event bridge on mount. Same failure mode as
  // the Tauri event bridge above — surface so the user knows menu items
  // will not respond instead of silently failing.
  useEffect(() => {
    let cleanup: (() => void) | undefined;
    installMenuBridge()
      .then((fn) => {
        cleanup = fn;
      })
      .catch((err) =>
        surfaceUnknownError(err, {
          operation: "install_menu_bridge",
          title: "Menu bridge failed to install",
        }),
      );
    return () => {
      cleanup?.();
    };
  }, []);

  // Install per-pane navigation history tracker on mount.
  // Powers nav.back / nav.forward commands.
  useEffect(() => {
    const stop = installHistoryTracker();
    return () => {
      stop();
    };
  }, []);

  return (
    <>
      <Theme />
      <FirstRun />
      <AppShell />
      <CommandPalette />
      <Toaster />
      <KeychainFallbackPrompt open={keychainOpen} onClose={closeKeychain} />
      {/* Updater banner — listens to updater:status events from the backend */}
      {!updaterDismissed && (
        <UpdaterPrompt
          status={updaterStatus}
          onDismiss={() => setUpdaterDismissed(true)}
        />
      )}
      {/* Transfer Manager rendered at app root as a portal-like overlay */}
      <TransferManager />
      <BulkDownloadHost />
      {/* Settings screen — shown on settings:open event (Cmd/Ctrl+,) */}
      <SettingsScreen />
      {/* DiffPreviewModal — listens to useDiffStore; renders nothing until a
          mutation that needs confirmation seeds currentDiff (e.g.
          storage-class change). profileId comes from the active pane's
          location so the confirm handler can fire the backend command. */}
      <DiffPreviewModal profileId={location?.profileId ?? ""} />
      {/* SearchBox overlay — shown on Cmd/Ctrl+F */}
      {searchOpen && (
        <SearchBox
          paneId={activePaneId}
          profileId={location?.profileId ?? ""}
          bucket={location?.bucket ?? ""}
          prefix={location?.prefix ?? ""}
          entries={filterEntries}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </>
  );
}

export default App;
