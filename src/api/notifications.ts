/**
 * API module for notification commands.
 *
 * Types mirror `src-tauri/src/notifications/mod.rs` (camelCase via serde).
 */

import { invoke } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "info" | "warning" | "error" | "success";

export type NotificationCategory = "userInitiated" | "background";

/** A single immutable notification entry. */
export interface Notification {
  id: string;
  severity: Severity;
  category: NotificationCategory;
  title: string;
  message: string;
  resource: string | null;
  operation: string | null;
  /** Unix timestamp in milliseconds. */
  timestamp: number;
  details: unknown;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Return all notifications stored in the log.
 *
 * When `since` is provided only notifications with `timestamp >= since`
 * (unix milliseconds) are returned.
 */
export function notificationsList(since?: number): Promise<Notification[]> {
  return invoke<Notification[]>("notifications_list", {
    since: since ?? null,
  });
}

/**
 * Dismiss (remove) a notification by its id.
 *
 * Returns `true` when the notification was found and removed.
 */
export function notificationDismiss(id: string): Promise<boolean> {
  return invoke<boolean>("notification_dismiss", { id });
}
