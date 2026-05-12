/**
 * GalleryView — image-heavy grid with thumbnail loading.
 *
 * Image tiles: ~200 px. Image entries get a lazy <img> with placeholder until
 * the thumbnail loads. Non-image entries get FileIcon (same as IconGridView).
 *
 * Thumbnail seam: `thumbnailUrlFor(entry)` currently returns null (placeholder)
 * and will be wired in task 47 without touching this file.
 *
 * Selection + keyboard nav: same model as IconGridView.
 *
 * OCP:
 * - `thumbnailUrlFor` is the only seam — task 47 replaces the stub.
 * - `useSelection` reused untouched.
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
import { useThumbnailUrl } from "@/lib/thumbnail";
import { cn } from "@/lib/utils";
import {
  useObjects,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";
import { usePanesStore } from "@/store/panes";
import { ListingFooter } from "@/views/browser/ListingFooter";
import { useFilteredEntries } from "./useFilteredEntries";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_SIZE = 200;
const FALLBACK_COLS = 3;

/** MIME types / extensions that should render as image thumbnails in v1. */
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
]);

// ---------------------------------------------------------------------------
// thumbnailUrlFor — now wired to useThumbnailUrl (task 48)
//
// NOTE: This export is kept for backward-compatibility with any test or
// consumer that imports it by name.  The live GalleryTile component now uses
// `useThumbnailUrl` directly (a React hook) so it can manage the async
// token lifecycle properly.
//
// Callers outside React (e.g. non-hook contexts) still receive `null`;
// the hook is the canonical consumer.
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `useThumbnailUrl` from `@/lib/thumbnail` instead.
 * Kept for backward-compatibility; always returns null outside a hook context.
 */
export function thumbnailUrlFor(
  _entry: ObjectEntry, // eslint-disable-line @typescript-eslint/no-unused-vars
): string | null {
  return null;
}

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

function isImageEntry(entry: ObjectEntry): boolean {
  const ext = entryExtension(entry);
  return ext != null && IMAGE_EXTENSIONS.has(ext);
}

// ---------------------------------------------------------------------------
// Gallery Tile
// ---------------------------------------------------------------------------

interface TileProps {
  entry: ObjectEntry;
  index: number;
  isSelected: boolean;
  isCursor: boolean;
  onClick: (item: ObjectEntry, index: number, e: React.MouseEvent) => void;
  onOpen?: (item: ObjectEntry) => void;
  size: number;
  /** Profile ID used to mint thumbnail URLs via the media server. */
  profileId?: string | null;
  /** Bucket containing the entry. */
  bucket?: string | null;
}

function GalleryTile({
  entry,
  index,
  isSelected,
  isCursor,
  onClick,
  onOpen,
  size,
  profileId,
  bucket,
}: TileProps) {
  const name = entryName(entry);
  const ext = entryExtension(entry);
  const isImage = isImageEntry(entry);
  // Use the hook for live thumbnail URLs; falls back to null for non-image
  // entries or when profileId/bucket are not available.
  const thumbUrl = useThumbnailUrl(profileId, bucket, entry);

  return (
    <div
      role="gridcell"
      aria-selected={isSelected}
      tabIndex={isCursor ? 0 : -1}
      className={cn(
        "flex flex-col rounded-md overflow-hidden cursor-default select-none",
        "hover:ring-1 hover:ring-ring",
        isSelected && "ring-2 ring-primary",
        isCursor && !isSelected && "ring-1 ring-inset ring-ring",
      )}
      style={{ width: size, height: size }}
      onClick={(e) => onClick(entry, index, e)}
      onDoubleClick={() => onOpen?.(entry)}
      data-testid={`gallery-tile-${index.toString()}`}
    >
      {/* Thumbnail or icon area */}
      <div
        className="flex flex-1 items-center justify-center bg-muted/40 overflow-hidden"
        style={{ minHeight: 0 }}
      >
        {isImage ? (
          thumbUrl != null ? (
            <img
              src={thumbUrl}
              alt={name}
              loading="lazy"
              className="w-full h-full object-cover"
              data-testid={`gallery-img-${index.toString()}`}
            />
          ) : (
            // Placeholder background until task 47 wires thumbnail URL.
            <div
              className="w-full h-full bg-muted/60 flex items-center justify-center"
              data-testid={`gallery-img-${index.toString()}`}
            >
              <FileIcon
                extension={ext ?? undefined}
                isFolder={false}
                className="text-muted-foreground opacity-40"
                size={40}
              />
            </div>
          )
        ) : (
          <FileIcon
            extension={ext ?? undefined}
            isFolder={entry.isPrefix}
            className="text-muted-foreground"
            size={40}
          />
        )}
      </div>
      {/* Label row */}
      <div className="flex flex-col px-1.5 pb-1.5 pt-1 bg-background/80">
        <span
          className="truncate text-xs font-medium leading-tight"
          title={name}
        >
          {name}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {entry.isPrefix ? "Folder" : formatBytes(entry.size ?? 0)}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Validation gate + Empty state
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
// GalleryView
// ---------------------------------------------------------------------------

export interface GalleryViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  onOpen?: (entry: ObjectEntry) => void;
  onNavigateUp?: () => void;
  onValidateProfile?: () => void;
  onCreateFolder?: () => void;
}

export function GalleryView({
  profileId,
  bucket,
  prefix,
  onOpen,
  onNavigateUp,
  onValidateProfile,
  onCreateFolder,
}: GalleryViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const {
    data: entries,
    isLoading: entriesLoading,
    isGated,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useObjects(profileId, bucket, prefix);

  // Track container width to compute column count.
  const observerRef = useRef<ResizeObserver | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);

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
    return Math.max(1, Math.floor(containerWidth / TILE_SIZE));
  }, [containerWidth]);

  const items = useFilteredEntries(entries ?? [], prefix);

  const rows = useMemo(() => {
    const result: ObjectEntry[][] = [];
    for (let i = 0; i < items.length; i += cols) {
      result.push(items.slice(i, i + cols));
    }
    return result;
  }, [items, cols]);

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
          {Array.from({ length: 9 }, (_, i) => (
            <div
              key={i}
              aria-hidden="true"
              className="rounded-md bg-muted animate-pulse"
              style={{ width: TILE_SIZE, height: TILE_SIZE }}
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

  const tileSize =
    containerWidth > 0 ? Math.floor(containerWidth / cols) : TILE_SIZE;

  // -- Gallery ----------------------------------------------------------------
  return (
    <div
      ref={attachRef}
      className="flex h-full flex-col"
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="grid"
      aria-label="File gallery"
      aria-rowcount={rows.length}
    >
      <Virtualized
        items={rows}
        rowHeight={tileSize}
        overscan={3}
        className="flex-1"
        renderRow={(row, rowIndex) => (
          <div key={rowIndex} role="row" className="flex">
            {row.map((entry, colIndex) => {
              const flatIndex = rowIndex * cols + colIndex;
              return (
                <GalleryTile
                  key={entry.key}
                  entry={entry}
                  index={flatIndex}
                  isSelected={isSelected(entry.key)}
                  isCursor={cursor === flatIndex}
                  onClick={onClick}
                  onOpen={onOpen}
                  size={tileSize}
                  profileId={profileId}
                  bucket={bucket}
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
          />
        }
      />
    </div>
  );
}
