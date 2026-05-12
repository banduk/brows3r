/**
 * ActivityCenter — full-pane transfer history with filters, search, and
 * session stats. Replaces the main pane when `useUiStore.activityCenterOpen`
 * is true.
 *
 * Why a dedicated screen vs the floating popup:
 *   - The popup is great for ambient "is my download still going?"
 *     awareness, but cramped for actually browsing transfer history.
 *   - When you kick off a 50-file download you want a real surface to
 *     filter by state, search by filename, and review what landed
 *     where. A 384-px-wide floating panel can't do that.
 *
 * Layout:
 *   ┌─────────────────────────────────────────────────────┐
 *   │ Title                              [Clear completed]│
 *   ├─────────────────────────────────────────────────────┤
 *   │ [All] [Active] [Completed] [Failed]    [🔍 Search…] │
 *   ├─────────────────────────────────────────────────────┤
 *   │ (Transfer groups + singletons, filtered + sorted)   │
 *   ├─────────────────────────────────────────────────────┤
 *   │ N active · M completed · X MB transferred           │
 *   └─────────────────────────────────────────────────────┘
 *
 * OCP: adding a new filter tab = one entry in `FILTERS`. Adding a new
 * sort = one entry in `SORTS`. The body renders any combination.
 */

import { ArrowDownIcon, ArrowUpIcon, SearchIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Transfer } from "@/api/transfers";
import { formatBytes } from "@/lib/format";
import { useTransfersStore } from "@/store/transfers";
import { useUiStore } from "@/store/ui";
import { TransferGroup } from "./TransferGroup";
import { TransferRow } from "./TransferRow";

// ---------------------------------------------------------------------------
// Filters + sorting
// ---------------------------------------------------------------------------

type FilterId = "all" | "active" | "completed" | "failed";
type SortId = "newest" | "oldest" | "largest";

const FILTERS: ReadonlyArray<{ id: FilterId; labelKey: string }> = [
  { id: "all", labelKey: "activityCenter.filter.all" },
  { id: "active", labelKey: "activityCenter.filter.active" },
  { id: "completed", labelKey: "activityCenter.filter.completed" },
  { id: "failed", labelKey: "activityCenter.filter.failed" },
];

const SORTS: ReadonlyArray<{ id: SortId; labelKey: string }> = [
  { id: "newest", labelKey: "activityCenter.sort.newest" },
  { id: "oldest", labelKey: "activityCenter.sort.oldest" },
  { id: "largest", labelKey: "activityCenter.sort.largest" },
];

function matchesFilter(t: Transfer, filter: FilterId): boolean {
  switch (filter) {
    case "all":
      return true;
    case "active":
      return t.state === "queued" || t.state === "running";
    case "completed":
      return t.state === "done";
    case "failed":
      return t.state === "failed" || t.state === "canceled";
  }
}

function matchesSearch(t: Transfer, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    t.key.toLowerCase().includes(needle) ||
    t.bucket.toLowerCase().includes(needle) ||
    (t.destPath?.toLowerCase().includes(needle) ?? false) ||
    (t.sourcePath?.toLowerCase().includes(needle) ?? false)
  );
}

function sortTransfers(transfers: Transfer[], sort: SortId): Transfer[] {
  const copy = [...transfers];
  switch (sort) {
    case "newest":
      return copy.sort((a, b) => b.startedAt - a.startedAt);
    case "oldest":
      return copy.sort((a, b) => a.startedAt - b.startedAt);
    case "largest":
      return copy.sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));
  }
}

// ---------------------------------------------------------------------------
// Grouping (mirrors TransferManager but takes a sort order into account)
// ---------------------------------------------------------------------------

interface Grouping {
  /** [batchId, sorted children] pairs in the order their first child appeared. */
  groups: Array<[string, Transfer[]]>;
  /** Singletons (no batchId, or batches of size 1). */
  singletons: Transfer[];
}

function groupAndSort(transfers: Transfer[], sort: SortId): Grouping {
  const groupMap = new Map<string, Transfer[]>();
  const order: string[] = [];
  const singletons: Transfer[] = [];
  for (const t of transfers) {
    if (!t.batchId) {
      singletons.push(t);
      continue;
    }
    const existing = groupMap.get(t.batchId);
    if (existing) existing.push(t);
    else {
      groupMap.set(t.batchId, [t]);
      order.push(t.batchId);
    }
  }
  const groups: Array<[string, Transfer[]]> = [];
  for (const id of order) {
    const arr = groupMap.get(id);
    if (!arr) continue;
    if (arr.length === 1) {
      singletons.push(arr[0] as Transfer);
      continue;
    }
    // Sort children within the group so the expanded view is meaningful.
    groups.push([id, sortTransfers(arr, sort)]);
  }
  // Sort the singletons + the group HEADS by the same comparator. We use
  // the first child's startedAt as the proxy for the group's age.
  const groupHeads = groups.map(
    ([id, children]) => [id, children[0] as Transfer, children] as const,
  );
  const sortedGroupHeads = [...groupHeads].sort((a, b) => {
    if (sort === "newest") return b[1].startedAt - a[1].startedAt;
    if (sort === "oldest") return a[1].startedAt - b[1].startedAt;
    const aSize = a[2].reduce((s, t) => s + (t.totalBytes ?? 0), 0);
    const bSize = b[2].reduce((s, t) => s + (t.totalBytes ?? 0), 0);
    return bSize - aSize;
  });
  return {
    groups: sortedGroupHeads.map(([id, , children]) => [id, children]),
    singletons: sortTransfers(singletons, sort),
  };
}

// ---------------------------------------------------------------------------
// Session stats
// ---------------------------------------------------------------------------

interface SessionStats {
  active: number;
  completed: number;
  failed: number;
  bytesTransferred: number;
}

function computeStats(transfers: Transfer[]): SessionStats {
  let active = 0;
  let completed = 0;
  let failed = 0;
  let bytesTransferred = 0;
  for (const t of transfers) {
    bytesTransferred += t.transferredBytes;
    if (t.state === "queued" || t.state === "running") active += 1;
    else if (t.state === "done") completed += 1;
    else if (t.state === "failed" || t.state === "canceled") failed += 1;
  }
  return { active, completed, failed, bytesTransferred };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActivityCenter() {
  const { t } = useTranslation();
  const transfersMap = useTransfersStore((s) => s.transfers);
  const clearCompleted = useTransfersStore((s) => s.clearCompleted);
  const closeCenter = useUiStore((s) => s.setActivityCenterOpen);

  const [filter, setFilter] = useState<FilterId>("all");
  const [sort, setSort] = useState<SortId>("newest");
  const [query, setQuery] = useState("");

  const allTransfers = useMemo(
    () => Array.from(transfersMap.values()),
    [transfersMap],
  );

  const filtered = useMemo(
    () =>
      allTransfers
        .filter((tr) => matchesFilter(tr, filter))
        .filter((tr) => matchesSearch(tr, query)),
    [allTransfers, filter, query],
  );

  const { groups, singletons } = useMemo(
    () => groupAndSort(filtered, sort),
    [filtered, sort],
  );

  const stats = useMemo(() => computeStats(allTransfers), [allTransfers]);
  const hasAny = filtered.length > 0;
  const hasCompleted = allTransfers.some(
    (tr) =>
      tr.state === "done" || tr.state === "failed" || tr.state === "canceled",
  );

  return (
    <section
      aria-label={t("activityCenter.label")}
      className="flex h-full min-h-0 flex-col"
      data-testid="activity-center"
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold">
            {t("activityCenter.title")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t("activityCenter.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {hasCompleted && (
            <button
              type="button"
              onClick={clearCompleted}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("transferManager.clearCompleted")}
            </button>
          )}
          <button
            type="button"
            onClick={() => closeCenter(false)}
            aria-label={t("activityCenter.close")}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </header>

      {/* Filters + search + sort */}
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-2">
        <nav
          aria-label={t("activityCenter.filtersAria")}
          className="flex items-center gap-1"
        >
          {FILTERS.map((f) => {
            const isActive = filter === f.id;
            return (
              <button
                key={f.id}
                type="button"
                aria-pressed={isActive}
                onClick={() => setFilter(f.id)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {t(f.labelKey)}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {/* Search */}
          <label
            htmlFor="activity-search"
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus-within:ring-2 focus-within:ring-ring"
          >
            <SearchIcon className="size-3.5" aria-hidden="true" />
            <input
              id="activity-search"
              type="text"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder={t("activityCenter.searchPlaceholder")}
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              className="w-44 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label={t("activityCenter.clearSearch")}
                className="text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3" />
              </button>
            )}
          </label>

          {/* Sort */}
          <label
            htmlFor="activity-sort"
            className="flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <span>{t("activityCenter.sortBy")}:</span>
            <select
              id="activity-sort"
              value={sort}
              onChange={(e) => setSort(e.currentTarget.value as SortId)}
              className="h-7 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {t(s.labelKey)}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {!hasAny ? (
          <EmptyState query={query} filter={filter} />
        ) : (
          <ul className="flex flex-col gap-2">
            {groups.map(([batchId, group]) => (
              <TransferGroup
                key={batchId}
                transfers={group}
                defaultExpanded={false}
              />
            ))}
            {singletons.map((tr) => (
              <TransferRow key={tr.id} transfer={tr} />
            ))}
          </ul>
        )}
      </div>

      {/* Footer — session stats */}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <ArrowDownIcon className="size-3" aria-hidden="true" />
          <ArrowUpIcon className="-ml-2.5 size-3" aria-hidden="true" />
          {t("activityCenter.stats.active", { count: stats.active })}
        </span>
        <span>•</span>
        <span>
          {t("activityCenter.stats.completed", { count: stats.completed })}
        </span>
        {stats.failed > 0 && (
          <>
            <span>•</span>
            <span className="text-destructive">
              {t("activityCenter.stats.failed", { count: stats.failed })}
            </span>
          </>
        )}
        <span>•</span>
        <span>
          {t("activityCenter.stats.transferred", {
            bytes: formatBytes(stats.bytesTransferred),
          })}
        </span>
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({ query, filter }: { query: string; filter: FilterId }) {
  const { t } = useTranslation();
  if (query) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium">
          {t("activityCenter.empty.searchTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("activityCenter.empty.searchBody", { query })}
        </p>
      </div>
    );
  }
  if (filter !== "all") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium">
          {t("activityCenter.empty.filteredTitle")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <ArrowDownIcon className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">{t("activityCenter.empty.title")}</p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t("activityCenter.empty.body")}
      </p>
    </div>
  );
}
