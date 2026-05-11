/**
 * Toolbar — file browser chrome above the file list area.
 *
 * Buttons (left to right):
 *   Refresh | Up | View mode | Inspect
 *
 * The Refresh and Up buttons delegate to the registry commands
 * `view.refresh` and `nav.up` registered in App.tsx — they are the
 * single source of truth so the keyboard shortcuts (Cmd-R, Cmd-↑) and
 * the toolbar buttons stay in lockstep.
 *
 * The View-mode control is a native <select> styled to match the
 * toolbar. Picking an option calls `usePanesStore.setViewMode` on the
 * active pane. Selection adjustments documented in
 * `views/modes/switching.ts` are intentionally skipped at the toolbar
 * level — they require access to the current listing items and the
 * view components own their own post-switch state. Toolbar-initiated
 * mode changes therefore preserve the user's selection set verbatim;
 * the views adapt on re-render.
 *
 * The Sort affordance lives inside each view (e.g. clickable column
 * headers in DetailsView); the toolbar no longer carries a duplicate
 * Sort button because hoisting sort state into the store is a
 * separate refactor.
 *
 * Inspect button (round-1 finding #25 discoverability):
 * - Calls `useInspectorStore.openInspector(target)` for the current
 *   selection or active pane location.
 *
 * A11y:
 * - `toolbar` role wrapping the button group.
 * - Each button has an accessible `aria-label`.
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  ColumnsIcon,
  DownloadIcon,
  FolderPlusIcon,
  FolderTreeIcon,
  ImagesIcon,
  InfoIcon,
  LayoutGridIcon,
  ListIcon,
  RefreshCwIcon,
  SplitSquareHorizontalIcon,
  StarIcon,
  TextIcon,
  UploadIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import type { Bookmark } from "@/api/bookmarks";
import { bookmarkAdd, bookmarkRemove, bookmarksList } from "@/api/bookmarks";
import { objectCreateFolder, objectsListFlat } from "@/api/objects";
import { transferDownloadMany, transferUploadMany } from "@/api/transfers";
import { registry } from "@/commands/registry";
import { surfaceUnknownError } from "@/lib/errors";
import { keys } from "@/query/keys";
import {
  canBack as historyCanBack,
  canForward as historyCanForward,
  subscribeHistory,
} from "@/store/history";
import { useInspectorStore } from "@/store/inspector";
import { usePanesStore } from "@/store/panes";
import type { ViewMode } from "@/store/ui";

// ---------------------------------------------------------------------------
// View-mode menu items
// ---------------------------------------------------------------------------

/**
 * Per-view-mode metadata for the picker. Keeping label + icon together in
 * one array makes adding a mode = one line.
 */
const VIEW_MODES: ReadonlyArray<{
  id: ViewMode;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}> = [
  { id: "Details", label: "Details", Icon: ListIcon },
  { id: "IconGrid", label: "Icons", Icon: LayoutGridIcon },
  { id: "Gallery", label: "Gallery", Icon: ImagesIcon },
  { id: "Column", label: "Columns", Icon: ColumnsIcon },
  { id: "Tree", label: "Tree", Icon: FolderTreeIcon },
  { id: "FlatKey", label: "Flat keys", Icon: TextIcon },
  { id: "DualPane", label: "Dual pane", Icon: SplitSquareHorizontalIcon },
];

// VIEW_MODES is non-empty (it owns the seven Pane.viewMode literals), so
// the `?? VIEW_MODES[0]` fallback always resolves; the non-null assertion
// here just narrows the type for downstream consumers.
function viewModeMeta(mode: ViewMode): (typeof VIEW_MODES)[number] {
  const found = VIEW_MODES.find((m) => m.id === mode) ?? VIEW_MODES[0];
  // biome-ignore lint/style/noNonNullAssertion: VIEW_MODES is a non-empty const array
  return found!;
}

// ---------------------------------------------------------------------------
// ViewModePicker — custom dropdown that shows the current mode's icon + label
// plus a chevron, and opens a menu where each option carries its own icon.
// ---------------------------------------------------------------------------

interface ViewModePickerProps {
  current: ViewMode;
  onSelect: (mode: ViewMode) => void;
}

function ViewModePicker({ current, onSelect }: ViewModePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );
  const currentMeta = viewModeMeta(current);

  // Compute menu position from the trigger's bounding rect. position:fixed
  // escapes any overflow:hidden clipping above us in the layout tree (Panel
  // from react-resizable-panels among others).
  const recompute = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Keep menu inside the viewport — clamp left so it never overflows the
    // right edge of the window.
    const MENU_WIDTH = 176; // matches min-w-44 below (44 * 4px)
    const left = Math.min(rect.left, window.innerWidth - MENU_WIDTH - 8);
    setCoords({ top: rect.bottom + 4, left: Math.max(8, left) });
  }, []);

  useEffect(() => {
    if (!open) return;
    recompute();
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, recompute]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: PointerEvent) {
      const node = e.target as Node | null;
      if (!node) return;
      if (triggerRef.current?.contains(node)) return;
      if (menuRef.current?.contains(node)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View mode: ${currentMeta.label}`}
        title={`View mode: ${currentMeta.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <currentMeta.Icon className="size-4" />
        <span>{currentMeta.label}</span>
        <ChevronDownIcon className="size-3 opacity-70" />
      </button>

      {open &&
        coords &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="View mode"
            style={{
              position: "fixed",
              top: coords.top,
              left: coords.left,
              minWidth: 176,
              zIndex: 1000,
            }}
            className="rounded-lg border border-border bg-popover py-1 text-sm shadow-md"
          >
            {VIEW_MODES.map(({ id, label, Icon }) => {
              const isCurrent = id === current;
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  onClick={() => {
                    onSelect(id);
                    setOpen(false);
                  }}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                >
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex-1">{label}</span>
                  {isCurrent && (
                    <CheckIcon
                      className="size-3.5 shrink-0 text-primary"
                      aria-hidden="true"
                    />
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}

// ---------------------------------------------------------------------------
// View-mode register (still needed for Cmd-1..7 keyboard shortcuts).
// ---------------------------------------------------------------------------

function tryRegister(def: Parameters<typeof registry.register>[0]) {
  try {
    registry.register(def);
  } catch {
    // Already registered (HMR or duplicate module load) — ignore.
  }
}

tryRegister({
  id: "view.inspect",
  title: "Inspect Selection",
  group: "View",
  defaultShortcut: { key: "i", mod: ["cmd"] },
  run(_ctx) {
    const { panes, activePaneId } = usePanesStore.getState();
    const pane = panes.find((p) => p.id === activePaneId) ?? panes[0];
    if (!pane?.location?.bucket) return;

    useInspectorStore.getState().openInspector({
      profileId: pane.location.profileId,
      bucket: pane.location.bucket,
      key: undefined,
    });
  },
});

// ---------------------------------------------------------------------------
// ToolbarButton helper
// ---------------------------------------------------------------------------

interface ToolbarButtonProps {
  label: string;
  onClick: () => void;
  /** Short visible text or icon character. */
  children: React.ReactNode;
  /** When true the button is disabled and visually muted. */
  disabled?: boolean;
}

function ToolbarButton({
  label,
  onClick,
  children,
  disabled,
}: ToolbarButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center gap-1 rounded px-2 py-1 text-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

export function Toolbar() {
  const openInspector = useInspectorStore((s) => s.openInspector);
  const { panes, activePaneId } = usePanesStore();
  const setViewMode = usePanesStore((s) => s.setViewMode);
  const setFilter = usePanesStore((s) => s.setFilter);
  const queryClient = useQueryClient();
  const pane = panes.find((p) => p.id === activePaneId) ?? panes[0];
  const filterInputRef = useRef<HTMLInputElement | null>(null);

  // Reactive snapshots of the per-pane history stacks. Re-renders whenever
  // back() / forward() / a fresh setLocation mutates the stacks.
  const canBack = useSyncExternalStore(
    subscribeHistory,
    () => historyCanBack(activePaneId),
    () => false,
  );
  const canForward = useSyncExternalStore(
    subscribeHistory,
    () => historyCanForward(activePaneId),
    () => false,
  );

  // Listen for the "bookmark:add" event dispatched by the bookmark.add
  // registry command and the file context menu so all bookmark entry
  // points share the smart "selected item OR current prefix" resolver
  // below.
  useEffect(() => {
    const onAdd = () => void handleBookmark();
    window.addEventListener("bookmark:add", onAdd);
    return () => window.removeEventListener("bookmark:add", onAdd);
    // handleBookmark closes over `pane` / `bookmarks` / `activeBookmark`
    // which change on every render; we accept the re-attach cost since
    // bookmark adds are rare and the listener has no state to leak.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // "/" key focuses the filter input, mirroring the GitHub/Slack pattern.
  // Skipped when the user is already typing in another input/textarea or
  // when a modifier key is held (so Cmd-/ etc. still propagate).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const tag = target.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target.isContentEditable
      ) {
        return;
      }
      e.preventDefault();
      filterInputRef.current?.focus();
      filterInputRef.current?.select();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleRefresh() {
    registry.lookupById("view.refresh")?.run({});
  }

  function handleNavigateUp() {
    registry.lookupById("nav.up")?.run({});
  }

  function handleNavigateBack() {
    registry.lookupById("nav.back")?.run({});
  }

  function handleNavigateForward() {
    registry.lookupById("nav.forward")?.run({});
  }

  function handleInspect() {
    if (!pane?.location?.bucket) return;
    openInspector({
      profileId: pane.location.profileId,
      bucket: pane.location.bucket,
      key: undefined,
    });
  }

  /**
   * Open the native file picker (multi-select) and enqueue an upload for
   * each chosen path. Keys are built as `prefix + basename` so the upload
   * lands in the user's current folder.
   *
   * Returns silently if no bucket is selected; the button is hidden in
   * that case but the keyboard / palette path can still reach the handler.
   */
  async function handleUpload() {
    if (!pane?.location?.bucket) return;
    const selected = await openDialog({ multiple: true, directory: false });
    if (!selected) return;
    const paths = Array.isArray(selected) ? selected : [selected];
    const { profileId, bucket, prefix } = pane.location;
    const specs = paths.map((sourcePath) => {
      const basename = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
      return {
        profileId,
        bucket,
        key: `${prefix}${basename}`,
        sourcePath,
      };
    });
    if (specs.length === 0) return;
    try {
      await transferUploadMany(specs);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "transfer_upload_many",
        resource: bucket,
        title: "Failed to start upload",
      });
    }
  }

  // ---------- Bookmark star: active state lookup ---------------------------

  const { data: bookmarks = [] } = useQuery({
    queryKey: keys.bookmarks(),
    queryFn: bookmarksList,
  });

  /**
   * Find the bookmark that targets the same thing the Star button would
   * create RIGHT NOW. Returns it (so the star can be removed) or undefined
   * (so a new bookmark can be added).
   */
  function findActiveBookmark(): Bookmark | undefined {
    if (!pane?.location?.bucket) return undefined;
    const { profileId, bucket } = pane.location;
    const target = resolveBookmarkTarget();
    return bookmarks.find(
      (b) =>
        b.profileId === profileId && b.bucket === bucket && b.prefix === target,
    );
  }

  /**
   * Pick the bookmark target based on what is selected in the active pane.
   *
   * Precedence (most specific → fallback):
   *   1. Exactly one selection (folder or object key) → that key.
   *   2. Otherwise the current pane prefix (folder / bucket root).
   *
   * Both folders and objects are honoured; Bookmarks.tsx handles the
   * folder/object distinction at click-time via its trailing "/" heuristic.
   */
  function resolveBookmarkTarget(): string {
    if (!pane?.location) return "";
    if (pane.selection.size === 1) {
      const onlyKey = [...pane.selection][0];
      if (onlyKey) return onlyKey;
    }
    return pane.location.prefix ?? "";
  }

  const activeBookmark = findActiveBookmark();

  /**
   * Universal download.
   *
   * S3 does not support multi-object download as a single archive, so
   * bulk downloads always work by enumerating keys via `objects_list_flat`
   * and fetching each one individually. The dialog below makes that
   * limitation explicit (zip-not-native warning) and asks for explicit
   * confirmation for anything that isn't a single object.
   *
   * Decision tree:
   *   - single selected object key  → save dialog → download one file.
   *   - any folder / multiple / bucket-root → warning dialog → directory
   *     picker → enumerate prefix → enqueue one transfer per object,
   *     mirroring the S3 key structure under the chosen directory.
   *
   * Size estimation is deliberately omitted from the dialog for now —
   * computing total size requires a full HEAD/LIST pass that would
   * stall the dialog open. The dialog says ">50 MB warning" as policy
   * but the actual size check happens on each individual transfer
   * (TransferManager already shows progress + cancel).
   */
  async function handleDownload() {
    if (!pane?.location?.bucket) return;
    const { profileId, bucket, prefix } = pane.location;
    const selectedKeys = [...pane.selection];
    const onlyOneSelected = selectedKeys.length === 1;
    const onlyKey = onlyOneSelected ? selectedKeys[0] : undefined;
    const isSingleObject =
      onlyOneSelected && !!onlyKey && !onlyKey.endsWith("/");

    if (isSingleObject && onlyKey) {
      // Single-object path: native "Save As…" picker, then one transfer.
      const basename = onlyKey.split("/").pop() ?? onlyKey;
      const dest = await saveDialog({ defaultPath: basename });
      if (!dest) return;
      try {
        await transferDownloadMany([
          { profileId, bucket, key: onlyKey, destPath: dest },
        ]);
      } catch (err) {
        await surfaceUnknownError(err, {
          operation: "transfer_download_many",
          resource: onlyKey,
          title: "Failed to start download",
        });
      }
      return;
    }

    // Bulk path: explain the zip-not-native caveat first.
    const targetPrefix = (() => {
      if (onlyOneSelected && onlyKey?.endsWith("/")) return onlyKey;
      return prefix;
    })();
    const targetLabel = targetPrefix
      ? `s3://${bucket}/${targetPrefix}`
      : `s3://${bucket}/`;

    const ok = window.confirm(
      [
        "Download as multiple files",
        "",
        `S3 does not support archive (zip/tar) downloads natively. ${targetLabel} will be downloaded by fetching each object individually and placing it under a folder you pick.`,
        "",
        "Anything over 50 MB will warn again on a per-transfer basis. Continue?",
      ].join("\n"),
    );
    if (!ok) return;

    const root = await openDialog({ directory: true, multiple: false });
    if (!root || Array.isArray(root)) return;

    // Enumerate keys under the prefix. `objects_list_flat` returns up to
    // 1000 per page; loop with the continuation token to gather them all.
    const collected: string[] = [];
    let cursor: string | undefined;
    try {
      do {
        const page = await objectsListFlat(profileId, bucket, targetPrefix, {
          continuationToken: cursor,
        });
        for (const entry of page.entries) {
          if (!entry.isPrefix) collected.push(entry.key);
        }
        cursor = page.nextContinuationToken;
      } while (cursor);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "objects_list_flat",
        resource: `${bucket}/${targetPrefix}`,
        title: "Failed to enumerate objects for download",
      });
      return;
    }

    if (collected.length === 0) {
      window.alert("Nothing to download — no objects under this prefix.");
      return;
    }

    const specs = collected.map((key) => {
      // Strip the source prefix so the target layout starts at `root`
      // (i.e. preserve the relative directory structure under the prefix).
      const rel = key.startsWith(targetPrefix)
        ? key.slice(targetPrefix.length)
        : key;
      return {
        profileId,
        bucket,
        key,
        destPath: `${root}/${rel}`,
      };
    });
    try {
      await transferDownloadMany(specs);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "transfer_download_many",
        resource: `${bucket}/${targetPrefix}`,
        title: "Failed to start download",
      });
    }
  }

  /**
   * Bookmark the active pane's current target. Smart selection rules:
   *
   *   no bucket               → bookmark the bucket itself? not possible.
   *                             Quietly no-op (button disabled in chrome).
   *   exactly one object key  → bookmark that object (prefix = full key).
   *   anything else (folder, root, multi-select) → bookmark the current
   *                             prefix (folder/bucket-root).
   *
   * Object-level bookmarks click-through navigates to the parent prefix
   * and selects the object — that flow is implemented in Bookmarks.tsx.
   */
  async function handleBookmark() {
    if (!pane?.location?.bucket) return;
    const { profileId, bucket } = pane.location;

    // If the current target is already bookmarked, treat the click as
    // "remove bookmark" (toggle). Otherwise add a new one.
    if (activeBookmark) {
      try {
        await bookmarkRemove(activeBookmark.id);
        void queryClient.invalidateQueries({ queryKey: keys.bookmarks() });
      } catch (err) {
        await surfaceUnknownError(err, {
          operation: "bookmark_remove",
          resource: activeBookmark.id,
          title: "Failed to remove bookmark",
        });
      }
      return;
    }

    const target = resolveBookmarkTarget();
    try {
      await bookmarkAdd(profileId, bucket, target);
      void queryClient.invalidateQueries({ queryKey: keys.bookmarks() });
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "bookmark_add",
        resource: `${bucket}/${target}`,
        title: "Failed to add bookmark",
      });
    }
  }

  /**
   * Prompt for a folder name and create a zero-byte `<prefix><name>/`
   * marker via the existing object_create_folder backend command. Trailing
   * slashes are appended if the user omits them.
   */
  async function handleNewFolder() {
    if (!pane?.location?.bucket) return;
    const name = window.prompt("New folder name:")?.trim();
    if (!name) return;
    const normalised = name.endsWith("/") ? name : `${name}/`;
    const { profileId, bucket, prefix } = pane.location;
    try {
      await objectCreateFolder(profileId, bucket, `${prefix}${normalised}`);
    } catch (err) {
      await surfaceUnknownError(err, {
        operation: "object_create_folder",
        resource: `${bucket}/${prefix}${normalised}`,
        title: "Failed to create folder",
      });
    }
  }

  const currentMode = pane?.viewMode ?? "Details";

  return (
    <div
      role="toolbar"
      aria-label="File browser toolbar"
      className="flex items-center gap-0.5 border-b bg-background/80 px-2 py-1 backdrop-blur"
    >
      <ToolbarButton
        label="Navigate back"
        onClick={handleNavigateBack}
        disabled={!canBack}
      >
        <ArrowLeftIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton
        label="Navigate forward"
        onClick={handleNavigateForward}
        disabled={!canForward}
      >
        <ArrowRightIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton label="Navigate up" onClick={handleNavigateUp}>
        <ArrowUpIcon className="size-4" />
      </ToolbarButton>

      <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

      <ToolbarButton label="Refresh" onClick={handleRefresh}>
        <RefreshCwIcon className="size-4" />
      </ToolbarButton>

      <ViewModePicker
        current={currentMode}
        onSelect={(m) => {
          if (pane?.id) setViewMode(pane.id, m);
        }}
      />

      <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

      <ToolbarButton label="Inspect selection" onClick={handleInspect}>
        <InfoIcon className="size-4" />
      </ToolbarButton>

      <div className="mx-1 h-4 w-px bg-border" aria-hidden="true" />

      <ToolbarButton label="Upload files" onClick={handleUpload}>
        <UploadIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton
        label={
          pane?.selection.size === 1 &&
          [...pane.selection][0]?.endsWith("/") === false
            ? "Download selected file"
            : "Download (folder/bucket — explains zip caveat)"
        }
        onClick={handleDownload}
      >
        <DownloadIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton label="New folder" onClick={handleNewFolder}>
        <FolderPlusIcon className="size-4" />
      </ToolbarButton>

      <ToolbarButton
        label={
          activeBookmark
            ? "Remove bookmark"
            : pane?.selection.size === 1
              ? "Bookmark selected object"
              : "Bookmark this location"
        }
        onClick={handleBookmark}
      >
        <StarIcon
          className={
            activeBookmark ? "size-4 fill-yellow-400 text-yellow-500" : "size-4"
          }
        />
      </ToolbarButton>

      <div className="ml-auto flex items-center gap-1">
        <input
          ref={filterInputRef}
          type="text"
          aria-label="Filter (fuzzy)"
          title='Fuzzy filter the current view — press "/" to focus, Esc to clear'
          placeholder='Filter…  press "/"'
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={pane?.filter ?? ""}
          onChange={(e) => {
            if (pane?.id) setFilter(pane.id, e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && pane?.id) {
              setFilter(pane.id, "");
              (e.target as HTMLInputElement).blur();
            }
          }}
          className="h-7 w-44 rounded border border-border bg-background px-2 text-sm placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </div>
    </div>
  );
}
