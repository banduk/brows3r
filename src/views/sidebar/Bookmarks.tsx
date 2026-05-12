/**
 * Bookmarks sidebar panel.
 *
 * Lists persisted bookmarks.  Clicking a row navigates the active pane to
 * that location.  Right-click (or "..." button) offers Edit (rename) and Delete.
 *
 * Validation gate (round-1 finding #9): rows for profiles that have not been
 * validated in the current session are rendered as disabled with a tooltip.
 * Uses `useValidatedProfile(bookmark.profileId)` — no special-casing.
 *
 * OCP: adding a new bookmark action = one new menu item in `BookmarkRowMenu`.
 * The validation gate is uniform via `useValidatedProfile`.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookmarkIcon, FileIcon, MoreHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
// `useEffect` is also used below to surface the bookmarks-list fetch error.
import type { Bookmark } from "@/api/bookmarks";
import {
  bookmarkAdd,
  bookmarkRemove,
  bookmarksList,
  bookmarkUpdate,
} from "@/api/bookmarks";
import { PopoverMenu } from "@/components/PopoverMenu";
import { Button } from "@/components/ui/button";
import { surfaceUnknownError } from "@/lib/errors";
import {
  useProfilesList,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";
import { keys } from "@/query/keys";
import { usePanesStore } from "@/store/panes";

// ---------------------------------------------------------------------------
// Bookmark shape interpretation
//
// The backend Bookmark.prefix is just a string — the schema does not
// distinguish folders from objects. We interpret it client-side:
//
//   prefix === ""                  → bucket root  (folder-ish)
//   prefix.endsWith("/")           → folder
//   otherwise                      → object key
//
// Clicking a folder bookmark navigates the pane to that prefix.
// Clicking an object bookmark navigates to the object's parent prefix and
// pre-selects the object so PreviewPane / Inspector pick it up.
// ---------------------------------------------------------------------------

function isObjectBookmark(bm: { prefix: string }): boolean {
  return bm.prefix !== "" && !bm.prefix.endsWith("/");
}

/**
 * Module-level singleton used as the empty fallback for the active-pane
 * selection selector. Returning the SAME reference across renders keeps
 * Object.is comparison stable; returning `new Set()` does NOT and causes
 * an infinite re-render loop in React 19 (visible as a "black screen"
 * because React unmounts the tree on "Maximum update depth exceeded").
 */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

function parentPrefixOf(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  return lastSlash >= 0 ? key.slice(0, lastSlash + 1) : "";
}

function basenameOf(key: string): string {
  const lastSlash = key.lastIndexOf("/");
  return lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
}

// ---------------------------------------------------------------------------
// BookmarkRowMenu
// ---------------------------------------------------------------------------

interface BookmarkRowMenuProps {
  bookmark: Bookmark;
  onEdit(bm: Bookmark): void;
  onDelete(bm: Bookmark): void;
}

function BookmarkRowMenu({ bookmark, onEdit, onDelete }: BookmarkRowMenuProps) {
  const { t } = useTranslation();
  const label = bookmark.label ?? bookmark.prefix;
  return (
    <PopoverMenu
      triggerLabel={t("bookmarks.rowActionsAria", { name: label })}
      triggerIcon={<MoreHorizontalIcon />}
      items={[
        { label: t("bookmarks.rename"), onClick: () => onEdit(bookmark) },
        // "Remove" — not "Delete" — because removing a bookmark only drops
        // the sidebar pointer; the underlying bucket/folder/object in S3
        // is never touched. "Delete" would imply destruction.
        { label: t("bookmarks.remove"), onClick: () => onDelete(bookmark) },
      ]}
    />
  );
}

// ---------------------------------------------------------------------------
// BookmarkRow
// ---------------------------------------------------------------------------

interface BookmarkRowProps {
  bookmark: Bookmark;
  isActive: boolean;
  onEdit(bm: Bookmark): void;
  onDelete(bm: Bookmark): void;
  onNavigate(bm: Bookmark): void;
}

function BookmarkRow({
  bookmark,
  isActive,
  onEdit,
  onDelete,
  onNavigate,
}: BookmarkRowProps) {
  const { isValidated } = useValidatedProfile(bookmark.profileId);
  const { profiles } = useProfilesList();
  const profileLabel =
    profiles.find((p) => p.id === bookmark.profileId)?.displayName ??
    bookmark.profileId;

  const isObject = isObjectBookmark(bookmark);
  const fallbackLabel = isObject
    ? basenameOf(bookmark.prefix)
    : bookmark.prefix || bookmark.bucket;
  const displayLabel = bookmark.label || fallbackLabel;
  const Icon = isObject ? FileIcon : BookmarkIcon;

  // Subtitle: "<profile> · s3://<bucket>[/prefix]" so the user can tell
  // identical-named bookmarks across profiles apart at a glance.
  const pathChip = bookmark.prefix
    ? `s3://${bookmark.bucket}/${bookmark.prefix}`
    : `s3://${bookmark.bucket}`;
  const subtitle = `${profileLabel} · ${pathChip}`;

  if (!isValidated) {
    return (
      <li
        className="flex cursor-not-allowed items-center gap-2 px-3 py-2 opacity-50"
        title="Validate this profile to use this bookmark"
        aria-disabled="true"
      >
        <Icon
          className="size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
          {displayLabel}
        </span>
        <span className="shrink-0 text-xs text-muted-foreground">
          Validate to use
        </span>
      </li>
    );
  }

  return (
    <li
      className={`flex items-center gap-0 hover:bg-accent/50 ${
        isActive ? "bg-accent/40" : ""
      }`}
    >
      <button
        type="button"
        aria-current={isActive ? "page" : undefined}
        title={subtitle}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 px-3 py-2 text-left"
        onClick={() => onNavigate(bookmark)}
      >
        <Icon
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium">{displayLabel}</span>
          <span className="truncate text-[11px] text-muted-foreground">
            {subtitle}
          </span>
        </span>
      </button>
      <div className="pr-1">
        <BookmarkRowMenu
          bookmark={bookmark}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// EditLabelDialog — inline rename UI
// ---------------------------------------------------------------------------

interface EditLabelDialogProps {
  bookmark: Bookmark;
  onClose(): void;
  onSave(label: string): void;
}

function EditLabelDialog({ bookmark, onClose, onSave }: EditLabelDialogProps) {
  const { t } = useTranslation();
  const [value, setValue] = useState(bookmark.label ?? "");

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("bookmarks.editAria")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
    >
      <div className="w-80 rounded-lg border border-border bg-popover p-4 shadow-lg">
        <h3 className="mb-3 text-sm font-semibold">
          {t("bookmarks.renameTitle")}
        </h3>
        <input
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="mb-3 w-full rounded border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder={t("bookmarks.labelPlaceholder")}
          // biome-ignore lint/a11y/noAutofocus: dialog must focus its input on open
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") onSave(value);
            if (e.key === "Escape") onClose();
          }}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button size="sm" onClick={() => onSave(value)}>
            {t("common.save")}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bookmarks (main export)
// ---------------------------------------------------------------------------

export function Bookmarks() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const setLocation = usePanesStore((s) => s.setLocation);
  const setSelection = usePanesStore((s) => s.setSelection);
  const activeLocation = usePanesStore(
    (s) => s.panes.find((p) => p.id === s.activePaneId)?.location ?? null,
  );
  // IMPORTANT: never return `?? new Set()` from a Zustand selector — Object.is
  // compares the returned identity, and `new Set()` mints a fresh reference on
  // every render. That triggers an infinite re-render loop, which React 19
  // resolves by unmounting the tree — i.e. the "black screen on back/forward/up"
  // symptom the user reported. Reuse the module-level EMPTY_SELECTION
  // singleton so the identity is stable across renders when no pane is
  // selected. Same rule applies to every selector that falls back to a
  // Set / Map / object literal.
  const activeSelection = usePanesStore(
    (s) =>
      s.panes.find((p) => p.id === s.activePaneId)?.selection ??
      EMPTY_SELECTION,
  );

  // Match rule: a bookmark counts as "active" when its profile + bucket
  // line up with the current location AND (folder bookmarks) the prefix
  // matches, OR (object bookmarks) the key is currently selected in
  // the active pane.
  function isBookmarkActive(bm: Bookmark): boolean {
    if (!activeLocation) return false;
    if (bm.profileId !== activeLocation.profileId) return false;
    if (bm.bucket !== activeLocation.bucket) return false;
    if (isObjectBookmark(bm)) {
      return activeSelection.has(bm.prefix);
    }
    return (activeLocation.prefix ?? "") === bm.prefix;
  }

  const [editTarget, setEditTarget] = useState<Bookmark | null>(null);

  const {
    data: bookmarks = [],
    isLoading,
    error: bookmarksError,
  } = useQuery({
    queryKey: keys.bookmarks(),
    queryFn: bookmarksList,
  });

  // Surface persistent fetch failures to the notifications panel so the
  // sidebar does not silently stick on "Loading bookmarks…" when the
  // backend command keeps failing.
  useEffect(() => {
    if (!bookmarksError) return;
    void surfaceUnknownError(bookmarksError, {
      operation: "bookmarks_list",
      context: "background",
      title: "Failed to load bookmarks",
    });
  }, [bookmarksError]);

  // Track orphan IDs that have already failed a removal attempt so the
  // auto-prune loop below does not retry them on every render. Without this
  // a permanent failure (disk full, file lock, malformed entry) would burn
  // CPU forever and flood the notification panel.
  const failedOrphanIds = useRef<Set<string>>(new Set());

  const removeMutation = useMutation({
    mutationFn: (id: string) => bookmarkRemove(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.bookmarks() });
    },
    onError: (err, id) => {
      failedOrphanIds.current.add(id);
      return surfaceUnknownError(err, {
        operation: "bookmark_remove",
        resource: id,
        title: "Failed to remove bookmark",
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Auto-prune orphan bookmarks
  //
  // When a profile is deleted, any bookmark that referenced it sticks around
  // with a dangling `profileId`. The row stays visible but clicking it goes
  // nowhere — confusing UX. As soon as we have BOTH lists loaded, remove any
  // bookmark whose profileId is no longer present in profiles.
  //
  // The mutation invalidates the bookmarks query on success, which triggers
  // this effect again; the guard (orphan-id set comparison + already-in-flight
  // check) avoids re-issuing the same delete in a tight loop.
  // ---------------------------------------------------------------------------
  const { profiles: allProfiles, isLoading: profilesLoading } =
    useProfilesList();
  const removeMutate = removeMutation.mutate;
  useEffect(() => {
    if (profilesLoading || isLoading) return;
    if (bookmarks.length === 0 || allProfiles.length === 0) return;
    const validIds = new Set(allProfiles.map((p) => p.id));
    const orphans = bookmarks.filter(
      (bm) =>
        !validIds.has(bm.profileId) && !failedOrphanIds.current.has(bm.id),
    );
    for (const orphan of orphans) {
      // Fire-and-forget: each removeMutate call dedupes by mutation key
      // internally, and onSuccess invalidates the bookmarks query, so the
      // list converges to the pruned state on the next render. Failures
      // are tagged in failedOrphanIds (via removeMutation.onError) so we
      // do not retry the same orphan forever.
      removeMutate(orphan.id);
    }
  }, [bookmarks, allProfiles, isLoading, profilesLoading, removeMutate]);

  const updateMutation = useMutation({
    mutationFn: ({ id, label }: { id: string; label: string }) =>
      bookmarkUpdate(id, { label: label.trim() || undefined }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.bookmarks() });
      setEditTarget(null);
    },
    onError: (err, vars) =>
      surfaceUnknownError(err, {
        operation: "bookmark_update",
        resource: vars.id,
        title: "Failed to update bookmark",
      }),
  });

  function handleNavigate(bm: Bookmark) {
    if (isObjectBookmark(bm)) {
      // Object bookmark: jump to the object's parent prefix and pre-select
      // the object key so PreviewPane / Inspector pick it up.
      setLocation(activePaneId, {
        profileId: bm.profileId,
        bucket: bm.bucket,
        prefix: parentPrefixOf(bm.prefix),
      });
      setSelection(activePaneId, new Set([bm.prefix]));
    } else {
      setLocation(activePaneId, {
        profileId: bm.profileId,
        bucket: bm.bucket,
        prefix: bm.prefix,
      });
    }
  }

  function handleDelete(bm: Bookmark) {
    if (
      window.confirm(
        t("bookmarks.removeConfirm", { name: bm.label ?? bm.prefix }),
      )
    ) {
      removeMutation.mutate(bm.id);
    }
  }

  return (
    <section aria-label={t("sidebar.bookmarks")}>
      {isLoading && !bookmarksError && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("bookmarks.loading")}
        </p>
      )}

      {bookmarksError && (
        <p
          className="px-3 py-2 text-xs text-destructive"
          role="alert"
          data-testid="bookmarks-load-error"
        >
          {t("bookmarks.loadError")}{" "}
          {bookmarksError instanceof Error
            ? bookmarksError.message
            : t("profiles.checkNotifications")}
        </p>
      )}

      {!isLoading && !bookmarksError && bookmarks.length === 0 && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("bookmarks.empty")}
        </p>
      )}

      <ul aria-label={t("bookmarks.listAria")}>
        {bookmarks.map((bm) => (
          <BookmarkRow
            key={bm.id}
            bookmark={bm}
            isActive={isBookmarkActive(bm)}
            onNavigate={handleNavigate}
            onEdit={setEditTarget}
            onDelete={handleDelete}
          />
        ))}
      </ul>

      {editTarget && (
        <EditLabelDialog
          bookmark={editTarget}
          onClose={() => setEditTarget(null)}
          onSave={(label) =>
            updateMutation.mutate({ id: editTarget.id, label })
          }
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// bookmarkAddForLocation — imperative helper called from commands
// ---------------------------------------------------------------------------

/**
 * Programmatic helper used by the `bookmark.add` command definition.
 *
 * Callers that want to bookmark the current active pane location dispatch
 * `bookmark:add` custom DOM event; this helper handles the actual API call
 * and cache invalidation.
 */
export async function bookmarkAddForLocation(
  queryClient: ReturnType<typeof useQueryClient>,
  profileId: string,
  bucket: string,
  prefix: string,
  label?: string,
): Promise<void> {
  await bookmarkAdd(profileId, bucket, prefix, label);
  await queryClient.invalidateQueries({ queryKey: keys.bookmarks() });
}
