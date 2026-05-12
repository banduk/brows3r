/**
 * FlatKeyView — flat list of all S3 object keys under the current prefix.
 *
 * Uses `objects_list_flat` (delimiter=None) so all keys are returned with
 * their full path — no virtual folder grouping. Useful for finding a file
 * across deeply-nested prefixes.
 *
 * Selection: same model as DetailsView — useSelection hook with Shift+click
 * range and Cmd/Ctrl+click individual toggle. Range select works across all
 * rows (no folder boundaries).
 *
 * Keyboard nav: ArrowUp/Down, Enter to open, Backspace to navigate up.
 *
 * OCP:
 * - Reuses Virtualized (same as DetailsView / TreeView).
 * - `objectsFlat` is a separate query key so it does not collide with
 *   hierarchical `objectsList`.
 * - Column additions: add one field to ObjectEntry + one gridcell here.
 *
 * NOTE: Biome useSemanticElements, useKeyWithClickEvents,
 * useFocusableInteractive suppressed via biome.json override.
 */

import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectEntry } from "@/api/objects";
import { objectsListFlat } from "@/api/objects";
import { FileIcon } from "@/components/FileIcon";
import { Virtualized } from "@/components/Virtualized";
import { formatBytes, formatDate, formatRelative } from "@/lib/format";
import { useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import { useValidatedProfile } from "@/query/hooks/useValidatedProfile";
import { keys } from "@/query/keys";
import { usePanesStore } from "@/store/panes";
import { ListingFooter } from "@/views/browser/ListingFooter";
import { useFilteredEntries } from "./useFilteredEntries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 32;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryExtension(key: string): string | null {
  const parts = key.split("/");
  const name = parts[parts.length - 1] ?? key;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Skeleton
// ---------------------------------------------------------------------------

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 px-3"
      style={{ height: ROW_HEIGHT }}
    >
      <div
        className="h-4 rounded bg-muted animate-pulse"
        style={{ width: `${((index % 5) + 3) * 10}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

function ValidationGate({ onValidate }: { onValidate?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">Validate this profile to see contents</p>
      {onValidate && (
        <button
          type="button"
          onClick={onValidate}
          className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          Validate profile
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">No objects found under this prefix</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface FlatRowProps {
  entry: ObjectEntry;
  index: number;
  isSelected: boolean;
  isCursor: boolean;
  onClick: (item: ObjectEntry, index: number, e: React.MouseEvent) => void;
  onOpen?: (item: ObjectEntry) => void;
}

function FlatRow({
  entry,
  index,
  isSelected,
  isCursor,
  onClick,
  onOpen,
}: FlatRowProps) {
  const ext = entryExtension(entry.key);

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={cn(
        "flex items-center gap-3 px-3 cursor-default select-none text-sm",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        isCursor && !isSelected && "ring-1 ring-inset ring-ring",
      )}
      style={{ height: ROW_HEIGHT }}
      onClick={(e) => onClick(entry, index, e)}
      onDoubleClick={() => onOpen?.(entry)}
      data-testid={`flat-row-${index.toString()}`}
    >
      {/* Icon + full key path */}
      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
        <FileIcon
          extension={ext ?? undefined}
          isFolder={false}
          className="shrink-0 text-muted-foreground"
          size={14}
        />
        <span className="truncate font-mono text-xs" title={entry.key}>
          {entry.key}
        </span>
      </div>
      {/* Size */}
      <span
        role="gridcell"
        className="w-20 shrink-0 text-right text-xs text-muted-foreground"
      >
        {formatBytes(entry.size ?? 0)}
      </span>
      {/* Last modified */}
      <span
        role="gridcell"
        className="w-28 shrink-0 text-right text-xs text-muted-foreground"
        title={
          entry.lastModified != null
            ? formatDate(entry.lastModified)
            : undefined
        }
      >
        {entry.lastModified != null ? formatRelative(entry.lastModified) : "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// useFlatObjects — gated by useValidatedProfile
// ---------------------------------------------------------------------------

function useFlatObjects(
  profileId: string | null | undefined,
  bucket: string | null | undefined,
  prefix: string,
): {
  data: ObjectEntry[] | undefined;
  isLoading: boolean;
  isGated: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetching: boolean;
  fetchNextPage: () => void;
  dataUpdatedAt: number;
} {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const enabled = Boolean(profileId) && Boolean(bucket) && isValidated;

  const query = useInfiniteQuery({
    queryKey:
      profileId && bucket
        ? keys.objectsFlat(profileId, bucket, prefix)
        : (["objects", null, null, null, "flat"] as const),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      objectsListFlat(profileId as string, bucket as string, prefix, {
        continuationToken: pageParam,
      }),
    getNextPageParam: (last) => last.nextContinuationToken,
    enabled,
  });

  // Defensive: accept both InfiniteData<ListPage> (.pages) and the legacy
  // ListPage shape (.entries) — same rationale as useObjects.
  const data = useMemo(() => {
    const raw = query.data as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const maybeInfinite = raw as {
      pages?: Array<{ entries?: ObjectEntry[] }>;
    };
    if (Array.isArray(maybeInfinite.pages)) {
      return maybeInfinite.pages.flatMap((p) => p.entries ?? []);
    }
    const maybeLegacy = raw as { entries?: ObjectEntry[] };
    if (Array.isArray(maybeLegacy.entries)) {
      return maybeLegacy.entries;
    }
    return undefined;
  }, [query.data]);

  if (!isValidated) {
    return {
      data: undefined,
      isLoading: profileLoading,
      isGated: true,
      hasNextPage: false,
      isFetchingNextPage: false,
      isFetching: false,
      fetchNextPage: () => undefined,
      dataUpdatedAt: 0,
    };
  }

  return {
    data,
    isLoading: query.isLoading,
    isGated: false,
    hasNextPage: query.hasNextPage ?? false,
    isFetchingNextPage: query.isFetchingNextPage,
    isFetching: query.isFetching,
    fetchNextPage: () => {
      void query.fetchNextPage();
    },
    dataUpdatedAt: query.dataUpdatedAt,
  };
}

// ---------------------------------------------------------------------------
// FlatKeyView
// ---------------------------------------------------------------------------

export interface FlatKeyViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  onOpen?: (entry: ObjectEntry) => void;
  onNavigateUp?: () => void;
  onValidateProfile?: () => void;
}

export function FlatKeyView({
  profileId,
  bucket,
  prefix,
  onOpen,
  onNavigateUp,
  onValidateProfile,
}: FlatKeyViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const {
    data: entries,
    isLoading: entriesLoading,
    isGated,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useFlatObjects(profileId, bucket, prefix);

  const items = useFilteredEntries(entries ?? [], prefix);

  const [_sort, _setSort] = useState<null>(null);

  const { selection, isSelected, onClick, onKeyDown, cursor, setCursor } =
    useSelection<ObjectEntry>(items, (e) => e.key);

  const activePaneIdForSync = usePanesStore((s) => s.activePaneId);
  const setStoreSelection = usePanesStore((s) => s.setSelection);
  useEffect(() => {
    setStoreSelection(activePaneIdForSync, new Set(selection.toArray()));
  }, [selection, activePaneIdForSync, setStoreSelection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown(e);

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(cursor + 1, items.length - 1);
          setCursor(next);
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prev = Math.max(cursor - 1, 0);
          setCursor(prev);
          break;
        }
        case " ":

        case "Enter": {
          e.preventDefault();
          const entry = items[cursor];
          if (entry) onOpen?.(entry);
          break;
        }
        case "Backspace": {
          e.preventDefault();
          onNavigateUp?.();
          break;
        }
      }
    },
    [onKeyDown, cursor, items, setCursor, onOpen, onNavigateUp],
  );

  // -- Gate -------------------------------------------------------------------
  if (!profileLoading && !isValidated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Loading ----------------------------------------------------------------
  if (profileLoading || (entriesLoading && !entries)) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        <span className="sr-only">Loading flat object list</span>
        {Array.from({ length: 12 }, (_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      </div>
    );
  }

  // -- Gated ------------------------------------------------------------------
  if (isGated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Empty ------------------------------------------------------------------
  if (items.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState />
      </div>
    );
  }

  // -- Table ------------------------------------------------------------------
  return (
    <div
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="grid"
      aria-label="Flat key list"
      aria-rowcount={items.length}
    >
      {/* Header row */}
      <div
        role="row"
        className="flex items-center gap-3 border-b px-3 py-1.5 bg-muted/30"
      >
        <div
          role="columnheader"
          className="flex-1 text-xs font-medium text-muted-foreground"
        >
          Key
        </div>
        <div
          role="columnheader"
          className="w-20 text-right text-xs font-medium text-muted-foreground"
        >
          Size
        </div>
        <div
          role="columnheader"
          className="w-28 text-right text-xs font-medium text-muted-foreground"
        >
          Modified
        </div>
      </div>

      {/* Virtualized rows */}
      <Virtualized
        items={items}
        rowHeight={ROW_HEIGHT}
        overscan={8}
        className="flex-1"
        renderRow={(entry, index) => (
          <FlatRow
            key={entry.key}
            entry={entry}
            index={index}
            isSelected={isSelected(entry.key)}
            isCursor={cursor === index}
            onClick={onClick}
            onOpen={onOpen}
          />
        )}
        onEndReached={hasNextPage ? fetchNextPage : undefined}
        footer={
          <ListingFooter
            loadedCount={items.length}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
          />
        }
      />
    </div>
  );
}
