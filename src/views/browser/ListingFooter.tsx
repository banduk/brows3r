/**
 * ListingFooter — pagination / truncation indicator + freshness timestamp
 * for the bottom of a virtualized object listing.
 *
 * States:
 *   isFetching (full refresh)      → "Refreshing…"
 *   isFetchingNextPage             → "Loading more…"
 *   !isFetchingNextPage + hasNext  → "Showing N items — scroll for more"
 *   !hasNext                       → "End of listing — N items"
 *
 * Always renders a discreet "Updated <relative time>" tag on the right so
 * users can tell when the data on screen was last fetched.
 *
 * Passed to <Virtualized footer={...}> so it sits below the last virtual
 * row and scrolls with the content.
 */

import { formatRelative } from "@/lib/format";

interface ListingFooterProps {
  loadedCount: number;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  /** True while a full refresh is in flight (different from page-append). */
  isFetching?: boolean;
  /** ms-since-epoch the active page was loaded; undefined hides the tag. */
  dataUpdatedAt?: number;
}

export function ListingFooter({
  loadedCount,
  hasNextPage,
  isFetchingNextPage,
  isFetching,
  dataUpdatedAt,
}: ListingFooterProps) {
  let primary: string;
  if (isFetchingNextPage) {
    primary = `Loading more… (${loadedCount} so far)`;
  } else if (isFetching) {
    primary = `Refreshing…`;
  } else if (hasNextPage) {
    primary = `Showing ${loadedCount} items — scroll for more`;
  } else {
    primary = `End of listing — ${loadedCount} ${
      loadedCount === 1 ? "item" : "items"
    }`;
  }

  return (
    <span aria-live="polite" className="flex w-full items-center gap-2">
      <span className="flex-1">{primary}</span>
      {dataUpdatedAt !== undefined && dataUpdatedAt > 0 && (
        <span
          className="shrink-0 opacity-70"
          title={`Last fetched: ${new Date(dataUpdatedAt).toLocaleString()}`}
        >
          Updated {formatRelative(dataUpdatedAt)}
        </span>
      )}
    </span>
  );
}
