/**
 * Virtualized — generic windowed list using @tanstack/react-virtual.
 *
 * Only the rows visible in the viewport plus `overscan` rows above/below are
 * rendered, keeping DOM size constant regardless of item count.
 *
 * OCP: Icon Grid, Gallery, and Tree views can reuse this component or extend
 * it by wrapping with a different item size calculation.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface VirtualizedProps<T> {
  items: T[];
  rowHeight: number;
  renderRow: (item: T, index: number) => ReactNode;
  overscan?: number;
  className?: string;
  /** Forwarded to the outer scroll container (e.g. aria-label, role). */
  containerProps?: React.HTMLAttributes<HTMLDivElement>;
  /**
   * Optional infinite-scroll callback. Fires once when the last visible
   * row index crosses `items.length - endReachedThreshold`. Callers should
   * make this idempotent / cheap — typical use is `() => fetchNextPage()`.
   */
  onEndReached?: () => void;
  /**
   * How many rows from the bottom to start firing onEndReached. Defaults
   * to `overscan` so a fetch can finish before the user actually sees the
   * end-of-list marker.
   */
  endReachedThreshold?: number;
  /** Optional trailing element (e.g. "loading more" footer). */
  footer?: ReactNode;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders a windowed list with a fixed row height.
 *
 * The outer div acts as the scroll container and must have an explicit height
 * set by the parent (e.g. `h-full`, or `height: 400px`).
 *
 * @example
 *   <Virtualized
 *     items={entries}
 *     rowHeight={32}
 *     renderRow={(item, i) => <div key={item.key}>{item.key}</div>}
 *   />
 */
export function Virtualized<T>({
  items,
  rowHeight,
  renderRow,
  overscan = 8,
  className,
  containerProps,
  onEndReached,
  endReachedThreshold,
  footer,
}: VirtualizedProps<T>) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan,
  });

  const totalHeight = virtualizer.getTotalSize();
  const virtualItems = virtualizer.getVirtualItems();

  // Infinite-scroll trigger. Resolve threshold lazily so we never call
  // onEndReached for empty lists. The hook is intentionally cheap —
  // identity-stable callers can re-fetch idempotently.
  useEffect(() => {
    if (!onEndReached || items.length === 0) return;
    const threshold = endReachedThreshold ?? overscan;
    const lastVisible = virtualItems[virtualItems.length - 1];
    if (!lastVisible) return;
    if (lastVisible.index >= items.length - 1 - threshold) {
      onEndReached();
    }
  }, [virtualItems, items.length, onEndReached, endReachedThreshold, overscan]);

  return (
    <div
      ref={parentRef}
      className={`overflow-auto${className ? ` ${className}` : ""}`}
      style={{ contain: "strict" }}
      {...containerProps}
    >
      {/* Spacer that gives the scroller its full scroll height */}
      <div style={{ height: totalHeight, position: "relative", width: "100%" }}>
        {/* Only the virtualised rows are rendered */}
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            width: "100%",
            transform: `translateY(${(virtualItems[0]?.start ?? 0).toString()}px)`,
          }}
        >
          {virtualItems.map((vItem) => (
            <div
              key={vItem.key}
              data-index={vItem.index}
              ref={virtualizer.measureElement}
              style={{ height: rowHeight }}
            >
              {renderRow(items[vItem.index] as T, vItem.index)}
            </div>
          ))}
        </div>
      </div>
      {footer && (
        <div
          role="row"
          aria-label="Listing status"
          className="border-t border-border/40 px-3 py-2 text-xs text-muted-foreground"
        >
          <span role="gridcell">{footer}</span>
        </div>
      )}
    </div>
  );
}
