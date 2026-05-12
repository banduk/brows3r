/**
 * DetailsView — virtualized file-list table with sortable columns,
 * multi-select (Shift+click, Cmd/Ctrl+click), keyboard navigation,
 * per-extension file icons, and a validation gate.
 *
 * AC-3: shift-click range, cmd/ctrl-click individual, Cmd/Ctrl+A select all,
 *       ArrowUp/Down cursor, Enter open, Backspace navigate up.
 *
 * Round-1 finding #18: file icons by extension via FileIcon + icons.ts.
 *
 * OCP:
 * - Sort is data-side: switching to backend sort is one prop change.
 * - Validation gate display is a single component shared across view modes.
 * - Column list is an array; adding a column is one entry.
 *
 * NOTE: We use div + role="grid/row" instead of <table>/<tr> because the
 * virtualizer positions rows absolutely, which is incompatible with table
 * layout. Biome's useSemanticElements is suppressed via config override.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ObjectEntry } from "@/api/objects";
import { FileIcon } from "@/components/FileIcon";
import { Virtualized } from "@/components/Virtualized";
import { formatBytes, formatDate, formatRelative } from "@/lib/format";
import { useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  useObjects,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";
import { useInspectorStore } from "@/store/inspector";
import { usePanesStore } from "@/store/panes";
import { useUiStore } from "@/store/ui";
import { FileContextMenu } from "@/views/browser/ContextMenu";
import { ListingFooter } from "@/views/browser/ListingFooter";
import { useFilteredEntries } from "./useFilteredEntries";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type SortColumn = "name" | "size" | "modified" | "storageClass";
type SortDir = "asc" | "desc";

interface SortState {
  column: SortColumn | null;
  dir: SortDir;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract the display name from an ObjectEntry key. */
function entryName(entry: ObjectEntry): string {
  if (entry.isPrefix) {
    const parts = entry.key.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] ?? entry.key;
  }
  const parts = entry.key.split("/");
  return parts[parts.length - 1] ?? entry.key;
}

/** Extract the file extension from an ObjectEntry. */
function entryExtension(entry: ObjectEntry): string | null {
  if (entry.isPrefix) return null;
  const name = entryName(entry);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

function sortEntries(entries: ObjectEntry[], sort: SortState): ObjectEntry[] {
  if (!sort.column) return entries;

  const sorted = [...entries].sort((a, b) => {
    let cmp = 0;
    switch (sort.column) {
      case "name":
        cmp = entryName(a).localeCompare(entryName(b));
        break;
      case "size":
        cmp = (a.size ?? 0) - (b.size ?? 0);
        break;
      case "modified":
        cmp = (a.lastModified ?? 0) - (b.lastModified ?? 0);
        break;
      case "storageClass":
        cmp = (a.storageClass ?? "").localeCompare(b.storageClass ?? "");
        break;
    }
    return sort.dir === "asc" ? cmp : -cmp;
  });

  return sorted;
}

function nextSort(current: SortState, column: SortColumn): SortState {
  if (current.column !== column) {
    return { column, dir: "asc" };
  }
  if (current.dir === "asc") {
    return { column, dir: "desc" };
  }
  // Third click clears sort.
  return { column: null, dir: "asc" };
}

// ---------------------------------------------------------------------------
// Skeleton rows (loading state)
// ---------------------------------------------------------------------------

function SkeletonRow({ index }: { index: number }) {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 px-3"
      style={{ height: 32 }}
    >
      <div
        className="h-4 rounded bg-muted animate-pulse"
        style={{ width: `${((index % 5) + 3) * 10}%` }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Column header
// ---------------------------------------------------------------------------

interface ColHeaderProps {
  label: string;
  column: SortColumn;
  sort: SortState;
  onSort: (col: SortColumn) => void;
  className?: string;
  style?: React.CSSProperties;
  /**
   * Optional resize handle rendered absolutely on the left edge of this
   * header cell. Lives inside the columnheader (not as a sibling of the
   * row) so the WAI-ARIA grid hierarchy is honoured.
   */
  leftResizer?: React.ReactNode;
}

function ColHeader({
  label,
  column,
  sort,
  onSort,
  className,
  style,
  leftResizer,
}: ColHeaderProps) {
  const active = sort.column === column;
  const indicator = active ? (sort.dir === "asc" ? " ▲" : " ▼") : "";

  return (
    <div role="columnheader" className={className} style={style}>
      {leftResizer && (
        <span className="absolute inset-y-0 left-0 flex items-center">
          {leftResizer}
        </span>
      )}
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "flex w-full items-center gap-1 text-left text-xs font-medium text-muted-foreground hover:text-foreground select-none",
          active && "text-foreground",
        )}
      >
        {label}
        {indicator && (
          <span aria-hidden="true" className="text-[10px]">
            {indicator}
          </span>
        )}
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ColumnResizer — thin draggable handle between header columns.
// ---------------------------------------------------------------------------

interface ColumnResizerProps {
  /** Currently committed width of the column being resized. */
  currentWidth: number;
  /** Called as the user drags; `next` is the in-progress proposed width. */
  onResize: (next: number) => void;
  /** Accessible label naming the column this handle controls. */
  ariaLabel: string;
}

function ColumnResizer({
  currentWidth,
  onResize,
  ariaLabel,
}: ColumnResizerProps) {
  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      e.preventDefault();
      // Capture pointer movement on `window` so the drag continues even if
      // the cursor leaves the tiny handle element.
      const startX = e.clientX;
      const startWidth = currentWidth;

      function onMove(ev: PointerEvent) {
        const delta = ev.clientX - startX;
        onResize(startWidth + delta);
      }
      function onUp() {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
      }
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      document.body.style.cursor = "col-resize";
    },
    [currentWidth, onResize],
  );

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onPointerDown={handlePointerDown}
      className="relative h-5 w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-ring focus-visible:outline-none focus-visible:bg-ring"
      // Use tabIndex=-1: the handle is pointer-only by design. Keyboard
      // users get the same effect via the "Reset columns" entry in the
      // settings popover (future) or by editing the persisted state.
      tabIndex={-1}
    />
  );
}

// ---------------------------------------------------------------------------
// Validation gate
// ---------------------------------------------------------------------------

interface ValidationGateProps {
  onValidate?: () => void;
}

function ValidationGate({ onValidate }: ValidationGateProps) {
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

function EmptyState({ onCreateFolder }: { onCreateFolder?: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
      <p className="text-sm">This prefix is empty</p>
      {onCreateFolder && (
        <button
          type="button"
          onClick={onCreateFolder}
          className="rounded-md border px-3 py-1.5 text-xs hover:bg-accent"
        >
          Create folder
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

const ROW_HEIGHT = 32;

interface RowProps {
  entry: ObjectEntry;
  index: number;
  isSelected: boolean;
  isCursor: boolean;
  onClick: (item: ObjectEntry, index: number, e: React.MouseEvent) => void;
  onContextMenu: (
    item: ObjectEntry,
    index: number,
    e: React.MouseEvent,
  ) => void;
  onOpen?: (item: ObjectEntry) => void;
  /**
   * Pixel widths for the size/modified/storageClass cells. Mirrors the
   * widths used by the header so row cells stay aligned during column
   * resize. Passed in (rather than read from the store directly) so the
   * row stays trivially testable and so DetailsView controls the prop's
   * stability for virtualization.
   */
  columnWidths: {
    size: number;
    modified: number;
    storageClass: number;
  };
}

function EntryRow({
  entry,
  index,
  isSelected,
  isCursor,
  onClick,
  onContextMenu,
  onOpen,
  columnWidths,
}: RowProps) {
  const name = entryName(entry);
  const ext = entryExtension(entry);

  return (
    <div
      role="row"
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={cn(
        "flex items-center px-3 cursor-default select-none text-sm",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        isCursor && "ring-2 ring-inset ring-primary",
      )}
      style={{ height: ROW_HEIGHT }}
      onClick={(e) => onClick(entry, index, e)}
      onContextMenu={(e) => onContextMenu(entry, index, e)}
      onDoubleClick={() => onOpen?.(entry)}
      data-testid={`entry-row-${index.toString()}`}
    >
      {/* Icon + name column */}
      <div
        role="gridcell"
        className="flex min-w-0 flex-1 items-center gap-2 pr-2"
      >
        <FileIcon
          extension={ext ?? undefined}
          isFolder={entry.isPrefix}
          className="shrink-0 text-muted-foreground"
          size={14}
        />
        {/* `title` reveals the full filename when the cell truncates — the
            most common reason the user can't tell two long object keys
            apart at a glance. */}
        <span className="truncate" title={name}>
          {name}
        </span>
      </div>
      {/* Size */}
      <span
        role="gridcell"
        className="shrink-0 pl-2 text-right text-xs text-muted-foreground"
        style={{ width: columnWidths.size }}
      >
        {entry.isPrefix ? "—" : formatBytes(entry.size ?? 0)}
      </span>
      {/* Last modified */}
      <span
        role="gridcell"
        className="shrink-0 pl-2 text-right text-xs text-muted-foreground"
        style={{ width: columnWidths.modified }}
        title={
          entry.lastModified != null
            ? formatDate(entry.lastModified)
            : undefined
        }
      >
        {entry.lastModified != null ? formatRelative(entry.lastModified) : "—"}
      </span>
      {/* Storage class */}
      <span
        role="gridcell"
        className="shrink-0 pl-2 text-right text-xs text-muted-foreground"
        style={{ width: columnWidths.storageClass }}
      >
        {entry.storageClass ?? "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SelectionSummary — selection count + Inspect affordance
// ---------------------------------------------------------------------------

interface SelectionSummaryProps {
  count: number;
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  /** The first selected key (used to open object inspector; null → bucket). */
  firstKey?: string;
}

function SelectionSummary({
  count,
  profileId,
  bucket,
  firstKey,
}: SelectionSummaryProps) {
  const openInspector = useInspectorStore((s) => s.openInspector);

  if (count === 0 || !profileId || !bucket) return null;

  function handleInspect() {
    if (!profileId || !bucket) return;
    openInspector({ profileId, bucket, key: firstKey });
  }

  return (
    <div
      className="flex items-center gap-2 border-t bg-muted/30 px-3 py-1 text-xs text-muted-foreground"
      data-testid="selection-summary"
    >
      <span>
        {count} item{count !== 1 ? "s" : ""} selected
      </span>
      <button
        type="button"
        onClick={handleInspect}
        className="ml-auto rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="Inspect selection"
        data-testid="selection-inspect-link"
      >
        Inspect (⌘I)
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DetailsView
// ---------------------------------------------------------------------------

export interface DetailsViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  /** Called when the user opens a folder or file. */
  onOpen?: (entry: ObjectEntry) => void;
  /** Called when user presses Backspace to navigate up. */
  onNavigateUp?: () => void;
  /** Called when the user wants to validate the profile. */
  onValidateProfile?: () => void;
  /** Called when the user wants to create a folder. */
  onCreateFolder?: () => void;
}

export function DetailsView({
  profileId,
  bucket,
  prefix,
  onOpen,
  onNavigateUp,
  onValidateProfile,
  onCreateFolder,
}: DetailsViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  // Resizable column widths persisted in the UI store. The Name column flexes
  // to fill remaining space; only the three right-side columns are user-sized.
  const columnWidths = useUiStore((s) => s.detailsColumnWidths);
  const setColumnWidth = useUiStore((s) => s.setDetailsColumnWidth);

  const {
    data: rawEntries,
    isLoading: entriesLoading,
    isGated,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    fetchNextPage,
    dataUpdatedAt,
  } = useObjects(profileId, bucket, prefix);

  const [sort, setSort] = useState<SortState>({ column: null, dir: "asc" });

  const sortedEntries = useMemo(
    () => sortEntries(rawEntries ?? [], sort),
    [rawEntries, sort],
  );
  const entries = useFilteredEntries(sortedEntries, prefix);

  const {
    selection,
    isSelected,
    onClick,
    onContextMenu,
    onKeyDown,
    cursor,
    setCursor,
  } = useSelection<ObjectEntry>(entries, (e) => e.key);

  // Sync the local selection set into the panes store so cross-cutting
  // features (Toolbar star button, context menus, transfer/upload helpers)
  // can read it without each having to reach into this component.
  const activePaneIdForSync = usePanesStore((s) => s.activePaneId);
  const setStoreSelection = usePanesStore((s) => s.setSelection);
  useEffect(() => {
    const keys = selection.toArray();
    setStoreSelection(activePaneIdForSync, new Set(keys));
  }, [selection, activePaneIdForSync, setStoreSelection]);

  const handleSort = useCallback((col: SortColumn) => {
    setSort((s) => nextSort(s, col));
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown(e);

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(cursor + 1, entries.length - 1);
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
          const entry = entries[cursor];
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
    [onKeyDown, cursor, entries, setCursor, onOpen, onNavigateUp],
  );

  // -- Gate: profile not validated -------------------------------------------
  if (!profileLoading && !isValidated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Loading ---------------------------------------------------------------
  if (profileLoading || (entriesLoading && !rawEntries)) {
    return (
      <div className="flex h-full flex-col" aria-busy="true">
        <span className="sr-only">Loading file list</span>
        {Array.from({ length: 12 }, (_, i) => (
          <SkeletonRow key={i} index={i} />
        ))}
      </div>
    );
  }

  // -- Gated (should not reach if !isValidated handled above) ----------------
  if (isGated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  // -- Empty -----------------------------------------------------------------
  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <EmptyState onCreateFolder={onCreateFolder} />
      </div>
    );
  }

  // -- Table -----------------------------------------------------------------
  const selectedKeys = selection.toArray();
  // Heuristic: when no rows are selected, treat the right-click as on the
  // blank area (Create Folder / Paste become available; per-item actions
  // collapse). When at least one row is selected, the context menu acts on
  // the selection. True per-row vs blank-area detection would require
  // wiring separate menus per virtualised row.
  const fileMenuCtx =
    profileId && bucket
      ? {
          profileId,
          bucket,
          prefix,
          keys: selectedKeys,
          isBlankArea: selectedKeys.length === 0,
        }
      : null;

  const firstSelectedKey = selectedKeys[0];

  const tableContent = (
    <div className="flex h-full flex-col">
      <div
        className="flex min-h-0 flex-1 flex-col"
        onKeyDown={handleKeyDown}
        tabIndex={0}
        role="grid"
        aria-label="File list"
        aria-rowcount={entries.length}
      >
        {/* Header row. Resize handles live inside the columnheader they
            resize, so they don't appear as bare children of `role="row"`
            (which only allows row/columnheader/gridcell children — see
            WAI-ARIA grid pattern). Dragging a handle changes that
            column's width; Name flex-1's the remaining space. */}
        <div
          role="row"
          className="flex items-center border-b bg-muted/30 px-3 py-1.5"
        >
          <ColHeader
            label="Name"
            column="name"
            sort={sort}
            onSort={handleSort}
            className="flex-1 min-w-0 pr-2"
          />
          <ColHeader
            label="Size"
            column="size"
            sort={sort}
            onSort={handleSort}
            className="relative shrink-0 justify-end pl-2"
            style={{ width: columnWidths.size }}
            leftResizer={
              <ColumnResizer
                currentWidth={columnWidths.size}
                onResize={(next) => setColumnWidth("size", next)}
                ariaLabel="Resize Size column"
              />
            }
          />
          <ColHeader
            label="Modified"
            column="modified"
            sort={sort}
            onSort={handleSort}
            className="relative shrink-0 justify-end pl-2"
            style={{ width: columnWidths.modified }}
            leftResizer={
              <ColumnResizer
                currentWidth={columnWidths.modified}
                onResize={(next) => setColumnWidth("modified", next)}
                ariaLabel="Resize Modified column"
              />
            }
          />
          <ColHeader
            label="Class"
            column="storageClass"
            sort={sort}
            onSort={handleSort}
            className="relative shrink-0 justify-end pl-2"
            style={{ width: columnWidths.storageClass }}
            leftResizer={
              <ColumnResizer
                currentWidth={columnWidths.storageClass}
                onResize={(next) => setColumnWidth("storageClass", next)}
                ariaLabel="Resize Class column"
              />
            }
          />
        </div>

        {/* Virtualized rows */}
        <Virtualized
          items={entries}
          rowHeight={ROW_HEIGHT}
          overscan={8}
          className="flex-1"
          renderRow={(entry, index) => (
            <EntryRow
              key={entry.key}
              entry={entry}
              index={index}
              isSelected={isSelected(entry.key)}
              isCursor={cursor === index}
              onClick={onClick}
              onContextMenu={onContextMenu}
              onOpen={onOpen}
              columnWidths={columnWidths}
            />
          )}
          onEndReached={hasNextPage ? fetchNextPage : undefined}
          footer={
            <ListingFooter
              loadedCount={entries.length}
              hasNextPage={hasNextPage}
              isFetchingNextPage={isFetchingNextPage}
              isFetching={isFetching}
              dataUpdatedAt={dataUpdatedAt}
            />
          }
        />
      </div>

      {/* Selection summary + Inspect affordance (discoverability path 1 of 2) */}
      <SelectionSummary
        count={selectedKeys.length}
        profileId={profileId}
        bucket={bucket}
        firstKey={firstSelectedKey}
      />
    </div>
  );

  if (!fileMenuCtx) return tableContent;

  return <FileContextMenu ctx={fileMenuCtx}>{tableContent}</FileContextMenu>;
}
