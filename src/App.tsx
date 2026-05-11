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
import {
  back as historyBack,
  forward as historyForward,
  installHistoryTracker,
} from "@/store/history";
import { usePanesStore } from "@/store/panes";
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
import { useNavShortcuts } from "@/views/shell/useNavShortcuts";
import { usePaletteShortcut } from "@/views/shell/usePaletteShortcut";
import { useRecentAutoTrack } from "@/views/sidebar/Recents";
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
  usePaletteShortcut();

  // Register Cmd/Ctrl + [ / ] / ArrowUp for pane navigation history.
  useNavShortcuts();

  // Auto-track pane location changes into the recents store (AC-10).
  useRecentAutoTrack();

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
      await cmd?.run({
        profileId: detail.profileId,
        bucket: detail.bucket,
        prefix: detail.prefix,
        folderName: name,
        queryClient,
      });
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
