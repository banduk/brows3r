/**
 * IconGridView — grid of file/folder cards with virtualized row rendering.
 *
 * Layout: responsive CSS grid with ~120 px columns. Virtualization is
 * row-based: each "row" holds N cards (computed from container width).
 * @tanstack/react-virtual virtualises the rows so large listings render
 * efficiently.
 *
 * Selection: same model as DetailsView via `useSelection`.
 *
 * Keyboard nav: ArrowLeft / ArrowRight move within a row; ArrowUp / ArrowDown
 * move between rows by column offset.
 *
 * OCP:
 * - `thumbnailUrlFor` seam: task 47 replaces the stub without touching this file.
 * - `useSelection` is reused untouched.
 * - Row-based virtualization via `Virtualized` is the same component used by
 *   DetailsView — only the render function changes.
 *
 * NOTE: Biome useSemanticElements, useKeyWithClickEvents, useFocusableInteractive,
 * and noArrayIndexKey are suppressed via biome.json override for this file
 * (same pattern as DetailsView).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ObjectEntry } from "@/api/objects";
import { FileIcon } from "@/components/FileIcon";
import { Virtualized } from "@/components/Virtualized";
import { formatBytes } from "@/lib/format";
import { useSelection } from "@/lib/selection";
import { cn } from "@/lib/utils";
import {
  useObjects,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";
import { usePanesStore } from "@/store/panes";
import { FileContextMenu } from "@/views/browser/ContextMenu";
import { ListingFooter } from "@/views/browser/ListingFooter";
import { useFilteredEntries } from "./useFilteredEntries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target card width in pixels (CSS grid minmax). */
const CARD_MIN_WIDTH = 120;
/** Card height: icon area + label + size text. */
const CARD_HEIGHT = 96;
/** Fallback column count when container width is unknown. */
const FALLBACK_COLS = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function entryName(entry: ObjectEntry): string {
  if (entry.isPrefix) {
    const parts = entry.key.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] ?? entry.key;
  }
  const parts = entry.key.split("/");
  return parts[parts.length - 1] ?? entry.key;
}

function entryExtension(entry: ObjectEntry): string | null {
  if (entry.isPrefix) return null;
  const name = entryName(entry);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return name.slice(dot + 1).toLowerCase();
}

// ---------------------------------------------------------------------------
// Grid Card
// ---------------------------------------------------------------------------

interface GridCardProps {
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
  width: number;
}

function GridCard({
  entry,
  index,
  isSelected,
  isCursor,
  onClick,
  onContextMenu,
  onOpen,
  width,
}: GridCardProps) {
  const name = entryName(entry);
  const ext = entryExtension(entry);

  return (
    <div
      role="gridcell"
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={cn(
        "flex flex-col items-center justify-start gap-1 rounded-md p-2 cursor-default select-none text-center",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        isCursor && "ring-2 ring-inset ring-primary",
      )}
      style={{ width, height: CARD_HEIGHT }}
      onClick={(e) => onClick(entry, index, e)}
      onContextMenu={(e) => onContextMenu(entry, index, e)}
      onDoubleClick={() => onOpen?.(entry)}
      data-testid={`icon-card-${index.toString()}`}
    >
      <FileIcon
        extension={ext ?? undefined}
        isFolder={entry.isPrefix}
        className="shrink-0 text-muted-foreground mt-1"
        size={32}
      />
      <span className="w-full truncate text-xs leading-tight" title={name}>
        {name}
      </span>
      <span className="text-[10px] text-muted-foreground">
        {entry.isPrefix ? "Folder" : formatBytes(entry.size ?? 0)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation gate + Empty state (shared pattern from DetailsView)
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
// IconGridView
// ---------------------------------------------------------------------------

export interface IconGridViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  onOpen?: (entry: ObjectEntry) => void;
  onNavigateUp?: () => void;
  onValidateProfile?: () => void;
  onCreateFolder?: () => void;
}

export function IconGridView({
  profileId,
  bucket,
  prefix,
  onOpen,
  onNavigateUp,
  onValidateProfile,
  onCreateFolder,
}: IconGridViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const {
    data: entries,
    isLoading: entriesLoading,
    isGated,
    hasNextPage,
    isFetchingNextPage,
    isFetching,
    fetchNextPage,
    dataUpdatedAt,
  } = useObjects(profileId, bucket, prefix);

  // Track container width to compute column count.
  const [containerWidth, setContainerWidth] = useState<number>(0);

  // ResizeObserver keeps `containerWidth` in sync with actual layout.
  const observerRef = useRef<ResizeObserver | null>(null);
  const attachRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (node) {
      setContainerWidth(node.offsetWidth);
      observerRef.current = new ResizeObserver((resizeEntries) => {
        const w = resizeEntries[0]?.contentRect.width ?? 0;
        setContainerWidth(w);
      });
      observerRef.current.observe(node);
    }
  }, []);

  const cols = useMemo(() => {
    if (containerWidth <= 0) return FALLBACK_COLS;
    return Math.max(1, Math.floor(containerWidth / CARD_MIN_WIDTH));
  }, [containerWidth]);

  const items = useFilteredEntries(entries ?? [], prefix);

  // Group items into rows of `cols` for row virtualisation.
  const rows = useMemo(() => {
    const result: ObjectEntry[][] = [];
    for (let i = 0; i < items.length; i += cols) {
      result.push(items.slice(i, i + cols));
    }
    return result;
  }, [items, cols]);

  const {
    selection,
    isSelected,
    onClick,
    onContextMenu,
    onKeyDown,
    cursor,
    setCursor,
  } = useSelection<ObjectEntry>(items, (e) => e.key);

  // Mirror the local selection into the panes store so cross-cutting
  // features (Preview, Inspector, Star bookmark) react to clicks here.
  const activePaneIdForSync = usePanesStore((s) => s.activePaneId);
  const setStoreSelection = usePanesStore((s) => s.setSelection);
  useEffect(() => {
    setStoreSelection(activePaneIdForSync, new Set(selection.toArray()));
  }, [selection, activePaneIdForSync, setStoreSelection]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      onKeyDown(e);

      switch (e.key) {
        case "ArrowRight": {
          e.preventDefault();
          setCursor(Math.min(cursor + 1, items.length - 1));
          break;
        }
        case "ArrowLeft": {
          e.preventDefault();
          setCursor(Math.max(cursor - 1, 0));
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          setCursor(Math.min(cursor + cols, items.length - 1));
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          setCursor(Math.max(cursor - cols, 0));
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
    [onKeyDown, cursor, items, cols, setCursor, onOpen, onNavigateUp],
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
        <span className="sr-only">Loading file list</span>
        <div className="flex flex-wrap gap-2 p-2">
          {Array.from({ length: 12 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="rounded-md bg-muted animate-pulse"
              style={{ width: CARD_MIN_WIDTH, height: CARD_HEIGHT }}
            />
          ))}
        </div>
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
        <EmptyState onCreateFolder={onCreateFolder} />
      </div>
    );
  }

  const cardWidth =
    containerWidth > 0 ? Math.floor(containerWidth / cols) : CARD_MIN_WIDTH;

  // -- Grid -------------------------------------------------------------------
  const selectedKeys = selection.toArray();
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

  const gridContent = (
    <div
      ref={attachRef}
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="grid"
      aria-label="File grid"
      aria-rowcount={rows.length}
    >
      <Virtualized
        items={rows}
        rowHeight={CARD_HEIGHT}
        overscan={4}
        className="flex-1"
        renderRow={(row, rowIndex) => (
          <div key={rowIndex} role="row" className="flex">
            {row.map((entry, colIndex) => {
              const flatIndex = rowIndex * cols + colIndex;
              return (
                <GridCard
                  key={entry.key}
                  entry={entry}
                  index={flatIndex}
                  isSelected={isSelected(entry.key)}
                  isCursor={cursor === flatIndex}
                  onClick={onClick}
                  onContextMenu={onContextMenu}
                  onOpen={onOpen}
                  width={cardWidth}
                />
              );
            })}
          </div>
        )}
        onEndReached={hasNextPage ? fetchNextPage : undefined}
        footer={
          <ListingFooter
            loadedCount={items.length}
            hasNextPage={hasNextPage}
            isFetchingNextPage={isFetchingNextPage}
            isFetching={isFetching}
            dataUpdatedAt={dataUpdatedAt}
          />
        }
      />
    </div>
  );

  if (!fileMenuCtx) return gridContent;
  return <FileContextMenu ctx={fileMenuCtx}>{gridContent}</FileContextMenu>;
}
