/**
 * NotificationsCenter — full-pane companion to the Activity Center.
 * Replaces the main pane when `useUiStore.notificationsCenterOpen` is
 * true. Mutually exclusive with the Activity Center (the ui store
 * enforces it).
 *
 * Why a dedicated screen vs the existing slide-out panel:
 *   - The panel is fine for ephemeral "what was that error?" glances
 *     but cramped for actually triaging a session's worth of notices.
 *   - Errors should not share visual real-estate with downloads —
 *     mixing them in one Activity surface mutes signal-to-noise.
 *   - With i18n + search + filters this is the place a user goes when
 *     they ask "what went wrong?".
 *
 * Same layout shape as the Activity Center for consistency: header,
 * filter tabs, search, scrollable body, footer with counts.
 */

import {
  AlertCircleIcon,
  AlertTriangleIcon,
  BellIcon,
  CheckCircle2Icon,
  InfoIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Notification, Severity } from "@/store/notifications";
import { useNotificationsStore } from "@/store/notifications";
import { useUiStore } from "@/store/ui";

// ---------------------------------------------------------------------------
// Filter model
// ---------------------------------------------------------------------------

type FilterId = "all" | "error" | "warning" | "info" | "success";

const FILTERS: ReadonlyArray<{ id: FilterId; labelKey: string }> = [
  { id: "all", labelKey: "notificationsCenter.filter.all" },
  { id: "error", labelKey: "notificationsCenter.filter.error" },
  { id: "warning", labelKey: "notificationsCenter.filter.warning" },
  { id: "info", labelKey: "notificationsCenter.filter.info" },
  { id: "success", labelKey: "notificationsCenter.filter.success" },
];

function matchesFilter(n: Notification, filter: FilterId): boolean {
  if (filter === "all") return true;
  return n.severity === filter;
}

function matchesSearch(n: Notification, q: string): boolean {
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    n.title.toLowerCase().includes(needle) ||
    n.message.toLowerCase().includes(needle)
  );
}

// ---------------------------------------------------------------------------
// Severity styling
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<
  Severity,
  React.ComponentType<{ className?: string }>
> = {
  info: InfoIcon,
  warning: AlertTriangleIcon,
  error: AlertCircleIcon,
  success: CheckCircle2Icon,
};

const SEVERITY_ICON_CLASS: Record<Severity, string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  error: "text-red-500",
  success: "text-green-500",
};

const SEVERITY_BORDER_CLASS: Record<Severity, string> = {
  info: "border-l-blue-500",
  warning: "border-l-yellow-500",
  error: "border-l-red-500",
  success: "border-l-green-500",
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NotificationsCenter() {
  const { t } = useTranslation();
  const entries = useNotificationsStore((s) => s.entries);
  const dismiss = useNotificationsStore((s) => s.dismiss);
  const clearAll = useNotificationsStore((s) => s.clearAll);
  const close = useUiStore((s) => s.setNotificationsCenterOpen);

  const [filter, setFilter] = useState<FilterId>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(
    () =>
      entries
        .filter((n) => matchesFilter(n, filter))
        .filter((n) => matchesSearch(n, query)),
    [entries, filter, query],
  );

  const counts = useMemo(() => {
    let err = 0;
    let warn = 0;
    let info = 0;
    let ok = 0;
    for (const n of entries) {
      if (n.severity === "error") err += 1;
      else if (n.severity === "warning") warn += 1;
      else if (n.severity === "info") info += 1;
      else if (n.severity === "success") ok += 1;
    }
    return { err, warn, info, ok };
  }, [entries]);

  return (
    <section
      aria-label={t("notificationsCenter.label")}
      className="flex h-full min-h-0 flex-col"
      data-testid="notifications-center"
    >
      {/* Header */}
      <header className="flex items-center justify-between border-b px-5 py-3">
        <div className="flex items-center gap-3">
          <BellIcon
            className="size-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h1 className="text-base font-semibold">
            {t("notificationsCenter.title")}
          </h1>
          <p className="text-xs text-muted-foreground">
            {t("notificationsCenter.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {entries.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {t("notificationsCenter.clearAll")}
            </button>
          )}
          <button
            type="button"
            onClick={() => close(false)}
            aria-label={t("notificationsCenter.close")}
            className="rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-4" />
          </button>
        </div>
      </header>

      {/* Filters + search */}
      <div className="flex flex-wrap items-center gap-3 border-b px-5 py-2">
        <nav
          aria-label={t("notificationsCenter.filtersAria")}
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

        <label
          htmlFor="notifications-search"
          className="ml-auto flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2 text-xs text-muted-foreground focus-within:ring-2 focus-within:ring-ring"
        >
          <SearchIcon className="size-3.5" aria-hidden="true" />
          <input
            id="notifications-search"
            type="text"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={t("notificationsCenter.searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            className="w-48 bg-transparent text-sm text-foreground placeholder:text-muted-foreground/60 outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("notificationsCenter.clearSearch")}
              className="text-muted-foreground hover:text-foreground"
            >
              <XIcon className="size-3" />
            </button>
          )}
        </label>
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3">
        {filtered.length === 0 ? (
          <EmptyState entries={entries} query={query} filter={filter} />
        ) : (
          <ul className="flex flex-col gap-2">
            {filtered.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onDismiss={dismiss}
              />
            ))}
          </ul>
        )}
      </div>

      {/* Footer — counts */}
      <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t bg-muted/30 px-5 py-2 text-xs text-muted-foreground">
        <span>
          {t("notificationsCenter.stats.total", { count: entries.length })}
        </span>
        {counts.err > 0 && (
          <>
            <span>•</span>
            <span className="text-destructive">
              {t("notificationsCenter.stats.errors", { count: counts.err })}
            </span>
          </>
        )}
        {counts.warn > 0 && (
          <>
            <span>•</span>
            <span className="text-yellow-700 dark:text-yellow-400">
              {t("notificationsCenter.stats.warnings", { count: counts.warn })}
            </span>
          </>
        )}
        {counts.info > 0 && (
          <>
            <span>•</span>
            <span>
              {t("notificationsCenter.stats.info", { count: counts.info })}
            </span>
          </>
        )}
        {counts.ok > 0 && (
          <>
            <span>•</span>
            <span>
              {t("notificationsCenter.stats.success", { count: counts.ok })}
            </span>
          </>
        )}
      </footer>
    </section>
  );
}

// ---------------------------------------------------------------------------
// NotificationRow
// ---------------------------------------------------------------------------

interface NotificationRowProps {
  notification: Notification;
  onDismiss: (id: string) => void;
}

function NotificationRow({ notification: n, onDismiss }: NotificationRowProps) {
  const { t } = useTranslation();
  const Icon = SEVERITY_ICON[n.severity];
  const iconColor = SEVERITY_ICON_CLASS[n.severity];
  const borderColor = SEVERITY_BORDER_CLASS[n.severity];
  const relTime = formatRelative(n.timestamp);

  return (
    <li
      className={cn(
        "flex items-start gap-3 rounded-md border border-l-4 bg-card px-3 py-2.5",
        borderColor,
      )}
    >
      <Icon
        className={cn("size-4 shrink-0 mt-0.5", iconColor)}
        aria-hidden="true"
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{n.title}</p>
          {n.category === "userInitiated" && (
            <span className="rounded border border-blue-200 px-1 py-0 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:border-blue-700 dark:text-blue-300">
              {t("notificationsCenter.userBadge")}
            </span>
          )}
        </div>
        <p className="break-words text-xs text-muted-foreground">{n.message}</p>
        <time
          className="text-[11px] text-muted-foreground/70"
          dateTime={new Date(n.timestamp).toISOString()}
          title={new Date(n.timestamp).toLocaleString()}
        >
          {relTime}
        </time>
      </div>
      <button
        type="button"
        onClick={() => onDismiss(n.id)}
        aria-label={t("notificationsCenter.dismissAria", { name: n.title })}
        className="shrink-0 rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <XIcon className="size-3.5" />
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// EmptyState
// ---------------------------------------------------------------------------

function EmptyState({
  entries,
  query,
  filter,
}: {
  entries: Notification[];
  query: string;
  filter: FilterId;
}) {
  const { t } = useTranslation();
  if (query) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium">
          {t("notificationsCenter.empty.searchTitle")}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("notificationsCenter.empty.searchBody", { query })}
        </p>
      </div>
    );
  }
  if (filter !== "all" && entries.length > 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium">
          {t("notificationsCenter.empty.filteredTitle")}
        </p>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-full bg-muted">
        <BellIcon className="size-5 text-muted-foreground" />
      </div>
      <p className="text-sm font-medium">
        {t("notificationsCenter.empty.title")}
      </p>
      <p className="max-w-xs text-xs text-muted-foreground">
        {t("notificationsCenter.empty.body")}
      </p>
    </div>
  );
}
