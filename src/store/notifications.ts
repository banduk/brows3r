/**
 * Zustand slice for in-app notifications.
 *
 * The store mirrors backend `notification:new` events pushed via the event
 * bridge in `src/query/client.ts`. All entries are in-memory only — the
 * backend log is the source of truth; nothing is persisted across restarts.
 *
 * OCP: adding a new severity value = one new union member in the backend
 * `TauriEventMap` type. This store never needs to change.
 */

import { create } from "zustand";
import type { TauriEventMap } from "@/lib/tauri";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single notification entry — mirrors the `notification:new` event shape. */
export type Notification = TauriEventMap["notification:new"];

export type Severity = Notification["severity"];

/**
 * True when a notification was emitted by a transfer (download / upload)
 * terminal-state event. The Notifications Center / bell chip filter
 * these out — transfers have their own dedicated surface (Activity
 * Center) so they don't double-surface as "alerts" in the bell.
 */
export function isTransferNotification(n: Notification): boolean {
  return n.operation === "upload" || n.operation === "download";
}

/** Notifications that should surface in the bell chip + center. */
export function nonTransferEntries(entries: Notification[]): Notification[] {
  return entries.filter((n) => !isTransferNotification(n));
}

export interface NotificationsState {
  entries: Notification[];

  /** Append a new notification. */
  add(n: Notification): void;

  /** Dismiss (remove) a notification by id. */
  dismiss(id: string): void;

  /** Remove all notifications. */
  clearAll(): void;

  // ---- Selectors ----

  /** Count of all entries (used as "unread count" since we have no read flag). */
  unreadCount(): number;

  /** Filter entries by severity. */
  bySeverity(sev: Severity): Notification[];
}

// ---------------------------------------------------------------------------
// Store factory — isolated instances for tests
// ---------------------------------------------------------------------------

export function createNotificationsStore() {
  return create<NotificationsState>((set, get) => ({
    entries: [],

    add(n: Notification) {
      set((state) => ({ entries: [n, ...state.entries] }));
    },

    dismiss(id: string) {
      set((state) => ({
        entries: state.entries.filter((e) => e.id !== id),
      }));
    },

    clearAll() {
      set({ entries: [] });
    },

    unreadCount() {
      return get().entries.length;
    },

    bySeverity(sev: Severity) {
      return get().entries.filter((e) => e.severity === sev);
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton
// ---------------------------------------------------------------------------

export const useNotificationsStore = createNotificationsStore();
