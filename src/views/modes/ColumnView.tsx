/**
 * ColumnView — Miller column / Finder column view.
 *
 * Columns are cascading: each column lists entries at a specific prefix. When
 * the user clicks (or presses ArrowRight on) a folder, a new column appends
 * to the right showing its children. Clicking a file in any column selects
 * it (fires onOpen for preview).
 *
 * Keyboard navigation:
 *   ArrowUp / ArrowDown → move cursor inside the active column.
 *   ArrowRight / Enter  → drill into the focused folder (or open the file
 *                         via onOpen). When the active column already has
 *                         a selected folder, ArrowRight focuses the next
 *                         column without re-firing the click.
 *   ArrowLeft           → focus the previous column (truncates view only
 *                         if the previously-focused entry is dropped).
 *   Backspace           → same as ArrowLeft.
 *   Home / End          → first / last row in the active column.
 *
 * State model:
 * - `columnPath` (store-owned): each element is the folder entry whose
 *   children fill the next column. columnPath[0] is the selection in
 *   the root column.
 * - `activeColumn` (local): which column the keyboard cursor lives in.
 *   Always the rightmost column on initial mount and on every click.
 * - `cursorByColumn` (local): per-column cursor row index. Resets when a
 *   column re-mounts at a new prefix.
 *
 * NOTE: Biome useSemanticElements, useKeyWithClickEvents,
 * useFocusableInteractive, and noArrayIndexKey are suppressed via biome.json.
 */

import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type { ObjectEntry } from "@/api/objects";
import { FileIcon } from "@/components/FileIcon";
import { cn } from "@/lib/utils";
import {
  useObjects,
  useValidatedProfile,
} from "@/query/hooks/useValidatedProfile";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COLUMN_WIDTH = 240;

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
// Column Entry Row
// ---------------------------------------------------------------------------

interface ColumnEntryProps {
  entry: ObjectEntry;
  isSelected: boolean;
  isActive: boolean;
  isCursor: boolean;
  onClick: (entry: ObjectEntry) => void;
}

function ColumnEntry({
  entry,
  isSelected,
  isActive,
  isCursor,
  onClick,
}: ColumnEntryProps) {
  const name = entryName(entry);
  const ext = entryExtension(entry);

  return (
    <div
      role="option"
      aria-selected={isSelected}
      className={cn(
        "flex items-center gap-2 px-3 py-1 cursor-default select-none text-sm",
        "hover:bg-accent/50",
        isSelected && "bg-accent text-accent-foreground",
        isActive && !isSelected && "bg-muted/40",
        isCursor && !isSelected && "ring-1 ring-inset ring-ring",
      )}
      style={{ height: 28 }}
      onClick={() => onClick(entry)}
      data-testid={`col-entry-${entry.key}`}
    >
      <FileIcon
        extension={ext ?? undefined}
        isFolder={entry.isPrefix}
        className="shrink-0 text-muted-foreground"
        size={14}
      />
      <span className="flex-1 truncate">{name}</span>
      {entry.isPrefix && (
        <span className="shrink-0 text-[10px] text-muted-foreground">▶</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SingleColumn — one column panel
// ---------------------------------------------------------------------------

interface SingleColumnProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  /** The key of the currently selected entry in this column (or null). */
  selectedKey: string | null;
  /** Column index in the overall column path (0 = root). */
  columnIndex: number;
  /** Whether this column owns the keyboard cursor right now. */
  isFocusedColumn: boolean;
  /** Row index of the keyboard cursor inside this column. */
  cursorIndex: number;
  onEntryClick: (entry: ObjectEntry, colIndex: number) => void;
  /** Reports the column's entries up so the parent can compute keyboard moves. */
  onEntriesReady: (colIndex: number, entries: ObjectEntry[]) => void;
}

function SingleColumn({
  profileId,
  bucket,
  prefix,
  selectedKey,
  columnIndex,
  isFocusedColumn,
  cursorIndex,
  onEntryClick,
  onEntriesReady,
}: SingleColumnProps) {
  const { data: entries, isLoading } = useObjects(profileId, bucket, prefix);

  // Bubble the loaded entries up so the parent's keyboard handler has data
  // to navigate against without each column owning its own listener.
  useEffect(() => {
    if (entries) onEntriesReady(columnIndex, entries);
  }, [entries, columnIndex, onEntriesReady]);

  if (isLoading) {
    return (
      <div
        className="flex flex-col border-r overflow-y-auto shrink-0"
        style={{ width: COLUMN_WIDTH }}
        aria-busy="true"
      >
        <span className="sr-only">Loading</span>
        {Array.from({ length: 8 }, (_, i) => (
          <div
            key={i}
            aria-hidden="true"
            className="m-2 h-4 animate-pulse rounded bg-muted"
          />
        ))}
      </div>
    );
  }

  const items = entries ?? [];

  return (
    <div
      role="listbox"
      aria-label={`Column ${(columnIndex + 1).toString()}`}
      className={cn(
        "flex flex-col border-r overflow-y-auto shrink-0",
        isFocusedColumn && "outline-none ring-1 ring-inset ring-ring/40",
      )}
      style={{ width: COLUMN_WIDTH }}
      data-testid={`column-panel-${columnIndex.toString()}`}
    >
      {items.length === 0 ? (
        <div className="p-3 text-xs text-muted-foreground">Empty</div>
      ) : (
        items.map((entry, i) => (
          <ColumnEntry
            key={entry.key}
            entry={entry}
            isSelected={entry.key === selectedKey}
            isActive={entry.key === selectedKey && entry.isPrefix}
            isCursor={isFocusedColumn && i === cursorIndex}
            onClick={(e) => onEntryClick(e, columnIndex)}
          />
        ))
      )}
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
// ColumnView
// ---------------------------------------------------------------------------

export interface ColumnViewProps {
  profileId: string | null | undefined;
  bucket: string | null | undefined;
  prefix: string;
  /**
   * The current column path: each entry is the folder that was clicked to
   * open the next column. Managed by the pane/store.
   *
   * `columnPath[0]` is the entry clicked in the root column (column 0).
   * `columnPath[i]` is the entry clicked in column i.
   */
  columnPath: ObjectEntry[];
  onColumnPathChange: (newPath: ObjectEntry[]) => void;
  onOpen?: (entry: ObjectEntry) => void;
  onValidateProfile?: () => void;
}

export function ColumnView({
  profileId,
  bucket,
  prefix,
  columnPath,
  onColumnPathChange,
  onOpen,
  onValidateProfile,
}: ColumnViewProps) {
  const { isValidated, isLoading: profileLoading } =
    useValidatedProfile(profileId);

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll right when new columns are appended.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — scrolls on every render when columnPath length changes; scrollContainerRef is a stable ref
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (el) {
      el.scrollLeft = el.scrollWidth;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnPath.length]);

  // Build the list of (prefix, selectedKey) pairs for each rendered column.
  // Column 0 always shows entries at props.prefix.
  // Column i+1 shows children of columnPath[i] (which must be a folder).
  const columns: Array<{ prefix: string; selectedKey: string | null }> = [
    {
      prefix,
      selectedKey: columnPath[0]?.key ?? null,
    },
  ];
  for (let i = 0; i < columnPath.length; i++) {
    const pathEntry = columnPath[i];
    if (!pathEntry?.isPrefix) break;
    columns.push({
      prefix: pathEntry.key,
      selectedKey: columnPath[i + 1]?.key ?? null,
    });
  }

  // -- Keyboard state -------------------------------------------------------

  // activeColumn defaults to the rightmost column so a fresh mount lands the
  // user at the deepest opened folder.
  const [activeColumn, setActiveColumn] = useState<number>(columns.length - 1);
  const [cursorByColumn, setCursorByColumn] = useState<Map<number, number>>(
    () => new Map(),
  );
  const entriesByColumnRef = useRef<Map<number, ObjectEntry[]>>(new Map());

  // Keep activeColumn within bounds when columns shrink (e.g. ArrowLeft).
  useEffect(() => {
    if (activeColumn > columns.length - 1) {
      setActiveColumn(Math.max(0, columns.length - 1));
    }
  }, [activeColumn, columns.length]);

  const handleEntriesReady = useCallback(
    (colIndex: number, entries: ObjectEntry[]) => {
      entriesByColumnRef.current.set(colIndex, entries);
    },
    [],
  );

  const handleEntryClick = useCallback(
    (entry: ObjectEntry, colIndex: number) => {
      // Move the keyboard cursor onto the clicked row before mutating
      // columnPath so the focus ring follows the user's intent.
      const colEntries = entriesByColumnRef.current.get(colIndex) ?? [];
      const rowIdx = colEntries.findIndex((e) => e.key === entry.key);
      if (rowIdx >= 0) {
        setCursorByColumn((m) => {
          const next = new Map(m);
          next.set(colIndex, rowIdx);
          return next;
        });
      }
      setActiveColumn(colIndex);

      if (entry.isPrefix) {
        const newPath = [...columnPath.slice(0, colIndex), entry];
        onColumnPathChange(newPath);
      } else {
        const newPath = columnPath.slice(0, colIndex);
        onColumnPathChange(newPath);
        onOpen?.(entry);
      }
    },
    [columnPath, onColumnPathChange, onOpen],
  );

  // -- Keyboard handler -----------------------------------------------------

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const colEntries = entriesByColumnRef.current.get(activeColumn) ?? [];
      const cursor = cursorByColumn.get(activeColumn) ?? 0;

      switch (e.key) {
        case "ArrowDown": {
          if (colEntries.length === 0) return;
          e.preventDefault();
          const next = Math.min(cursor + 1, colEntries.length - 1);
          setCursorByColumn((m) => {
            const n = new Map(m);
            n.set(activeColumn, next);
            return n;
          });
          return;
        }
        case "ArrowUp": {
          if (colEntries.length === 0) return;
          e.preventDefault();
          const prev = Math.max(cursor - 1, 0);
          setCursorByColumn((m) => {
            const n = new Map(m);
            n.set(activeColumn, prev);
            return n;
          });
          return;
        }
        case "Home": {
          if (colEntries.length === 0) return;
          e.preventDefault();
          setCursorByColumn((m) => {
            const n = new Map(m);
            n.set(activeColumn, 0);
            return n;
          });
          return;
        }
        case "End": {
          if (colEntries.length === 0) return;
          e.preventDefault();
          setCursorByColumn((m) => {
            const n = new Map(m);
            n.set(activeColumn, colEntries.length - 1);
            return n;
          });
          return;
        }
        case "ArrowRight":
        case "Enter": {
          const entry = colEntries[cursor];
          if (!entry) return;
          e.preventDefault();
          if (entry.isPrefix) {
            // Drill in: append to path, focus the new (next) column.
            const newPath = [...columnPath.slice(0, activeColumn), entry];
            onColumnPathChange(newPath);
            setActiveColumn(activeColumn + 1);
          } else {
            const newPath = columnPath.slice(0, activeColumn);
            onColumnPathChange(newPath);
            onOpen?.(entry);
          }
          return;
        }
        case "ArrowLeft":
        case "Backspace": {
          if (activeColumn === 0) return;
          e.preventDefault();
          setActiveColumn(activeColumn - 1);
          return;
        }
      }
    },
    [activeColumn, cursorByColumn, columnPath, onColumnPathChange, onOpen],
  );

  // -- Gates ----------------------------------------------------------------

  if (!profileLoading && !isValidated) {
    return (
      <div className="flex h-full flex-col">
        <ValidationGate onValidate={onValidateProfile} />
      </div>
    );
  }

  if (profileLoading) {
    return (
      <div className="flex h-full" aria-busy="true">
        <span className="sr-only">Loading column view</span>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onFocus={(e) => {
        // When the user tabs into the column view, light up the rightmost
        // column with a cursor at row 0 so the keyboard handler has
        // somewhere to start.
        if (e.currentTarget === e.target && !cursorByColumn.has(activeColumn)) {
          setCursorByColumn((m) => {
            const n = new Map(m);
            n.set(activeColumn, 0);
            return n;
          });
        }
      }}
      className="flex h-full flex-row overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-ring"
      role="group"
      aria-label="Column view"
      data-testid="column-view"
    >
      {columns.map((col, i) => (
        <SingleColumn
          key={col.prefix}
          profileId={profileId}
          bucket={bucket}
          prefix={col.prefix}
          selectedKey={col.selectedKey}
          columnIndex={i}
          isFocusedColumn={i === activeColumn}
          cursorIndex={cursorByColumn.get(i) ?? 0}
          onEntryClick={handleEntryClick}
          onEntriesReady={handleEntriesReady}
        />
      ))}
    </div>
  );
}
