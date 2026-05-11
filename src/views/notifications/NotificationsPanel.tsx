/**
 * NotificationsPanel — slide-out panel listing all in-app notifications.
 *
 * Header: unread count + "Clear all" button.
 * Each row: severity icon, title, message, relative timestamp,
 *           category badge, dismiss "×" button.
 * Empty state: "No notifications yet".
 *
 * A11y: role="region" with aria-label, list/listitem roles, dismiss buttons
 * have accessible labels.
 */

import { formatRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Notification, Severity } from "@/store/notifications";
import { useNotificationsStore } from "@/store/notifications";

// ---------------------------------------------------------------------------
// Severity icon helpers
// ---------------------------------------------------------------------------

const SEVERITY_ICON: Record<Severity, string> = {
  info: "ℹ",
  warning: "⚠",
  error: "✕",
  success: "✓",
};

const SEVERITY_CLASS: Record<Severity, string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  error: "text-red-500",
  success: "text-green-500",
};

// ---------------------------------------------------------------------------
// NotificationsPanel
// ---------------------------------------------------------------------------

export interface NotificationsPanelProps {
  className?: string;
}

export function NotificationsPanel({ className }: NotificationsPanelProps) {
  const entries = useNotificationsStore((s) => s.entries);
  const dismiss = useNotificationsStore((s) => s.dismiss);
  const clearAll = useNotificationsStore((s) => s.clearAll);

  return (
    <section
      aria-label="Notifications"
      className={cn(
        "flex flex-col w-80 bg-background border-l border-border overflow-hidden",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        <h2 className="text-sm font-semibold">
          Notifications
          {entries.length > 0 && (
            <span
              className="ml-2 text-xs text-muted-foreground"
              aria-live="polite"
              aria-atomic="true"
            >
              ({entries.length.toString()})
            </span>
          )}
        </h2>
        {entries.length > 0 && (
          <button
            type="button"
            onClick={clearAll}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            aria-label="Clear all notifications"
          >
            Clear all
          </button>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {entries.length === 0 ? (
          <p
            className="text-sm text-muted-foreground text-center py-8 px-4"
            aria-live="polite"
          >
            No notifications yet
          </p>
        ) : (
          <ul aria-label="Notification entries">
            {entries.map((n) => (
              <NotificationRow
                key={n.id}
                notification={n}
                onDismiss={dismiss}
              />
            ))}
          </ul>
        )}
      </div>
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
  const iconChar = SEVERITY_ICON[n.severity];
  const iconClass = SEVERITY_CLASS[n.severity];
  const relTime = formatRelative(n.timestamp);

  return (
    <li className="flex items-start gap-3 px-4 py-3 border-b border-border/50 last:border-b-0 hover:bg-muted/30 transition-colors">
      {/* Severity icon */}
      <span
        className={cn("text-base shrink-0 mt-0.5 select-none", iconClass)}
        aria-hidden="true"
        title={n.severity}
      >
        {iconChar}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium truncate">{n.title}</p>
          {/* Category badge */}
          <span
            className={cn(
              "text-xs shrink-0 px-1.5 py-0.5 rounded border",
              n.category === "userInitiated"
                ? "border-blue-200 text-blue-700 dark:border-blue-700 dark:text-blue-300"
                : "border-muted text-muted-foreground",
            )}
          >
            {n.category === "userInitiated" ? "User" : "BG"}
          </span>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 break-words">
          {n.message}
        </p>
        <time
          className="text-xs text-muted-foreground/70 mt-1 block"
          dateTime={new Date(n.timestamp).toISOString()}
        >
          {relTime}
        </time>
      </div>

      {/* Dismiss button */}
      <button
        type="button"
        onClick={() => onDismiss(n.id)}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-0.5"
        aria-label={`Dismiss notification: ${n.title}`}
      >
        ×
      </button>
    </li>
  );
}
