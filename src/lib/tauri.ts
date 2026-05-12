/**
 * Typed wrappers around @tauri-apps/api.
 *
 * - `invoke<T>` — wraps core `invoke`, normalizes Tauri errors to `AppError`.
 * - `listen<T>` — wraps event `listen` with typed payload.
 * - `TauriEventMap` — compile-time map of event names → payload types.
 *   Adding a new backend event = adding one entry here. Consumers that
 *   handle unknown event names get a compile error.
 */

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";

import { type AppError, isAppError } from "./errors";

// Re-export so callers don't need to import from @tauri-apps/api directly.
export type { UnlistenFn };

// ---------------------------------------------------------------------------
// TauriEventMap — extension point for new backend events
// ---------------------------------------------------------------------------

/**
 * Maps event name strings to their payload types.
 *
 * OCP: adding a new Rust `EventKind` variant = adding one entry here.
 * The `listen` wrapper is typed over this map, so consumers that use
 * an unknown event name will get a compile-time error.
 */
export interface TauriEventMap {
  "objects:updated": {
    profileId: string;
    bucket: string;
    prefix: string;
  };
  "buckets:updated": {
    profileId: string;
  };
  "transfer:progress": {
    requestId: string;
    bytesDone: number;
    bytesTotal?: number;
    partsDone: number;
    partsTotal: number;
  };
  "transfer:state": {
    requestId: string;
    state: "queued" | "running" | "done" | "failed" | "canceled";
    /** Populated when state === "failed"; carries the AppError so the
     *  frontend can render the failure reason on the transfer row. */
    error?: import("@/lib/errors").AppError;
  };
  "lock:acquired": {
    lockId: string;
    resource: string;
    opName: string;
  };
  "lock:released": {
    lockId: string;
  };
  "notification:new": {
    id: string;
    severity: "info" | "warning" | "error" | "success";
    category: "userInitiated" | "background";
    title: string;
    message: string;
    resource: string | null;
    operation: string | null;
    timestamp: number;
    details: unknown;
  };
  "search:page": import("@/api/search").SearchPage;
  "media:revoked": {
    url: string;
  };
  "updater:status": import("@/api/updater").UpdateStatus;
  /**
   * Emitted by the backend when the OS keychain is unavailable and the
   * FileBackend passphrase has not yet been provided for this session.
   * The Credential Manager UI listens for this and shows the fallback
   * prompt exactly once per session.
   */
  "keychain:fallback-required": Record<string, never>;
  // Menu events — emitted by the Rust on_menu_event handler.
  // Each entry corresponds to a menu item id defined in menus.rs.
  "menu:file.new-folder": Record<string, never>;
  "menu:file.open": Record<string, never>;
  "menu:file.save": Record<string, never>;
  "menu:edit.find": Record<string, never>;
  "menu:view.refresh": Record<string, never>;
  "menu:view.toggle-sidebar": Record<string, never>;
  "menu:view.toggle-preview": Record<string, never>;
  "menu:view.mode.details": Record<string, never>;
  "menu:view.mode.icon-grid": Record<string, never>;
  "menu:view.mode.gallery": Record<string, never>;
  "menu:view.mode.column": Record<string, never>;
  "menu:view.mode.tree": Record<string, never>;
  "menu:view.mode.flat-key": Record<string, never>;
  "menu:view.mode.dual-pane": Record<string, never>;
  "menu:go.back": Record<string, never>;
  "menu:go.forward": Record<string, never>;
  "menu:go.up": Record<string, never>;
  "menu:go.bookmarks": Record<string, never>;
  "menu:help.docs": Record<string, never>;
  "menu:help.report-bug": Record<string, never>;
}

// ---------------------------------------------------------------------------
// invoke<T>
// ---------------------------------------------------------------------------

/**
 * Typed wrapper around Tauri's `invoke`.
 *
 * On success returns the typed result `T`.
 * On failure attempts to parse the error as `AppError`; if parsing fails
 * (unexpected shape) it constructs a synthetic `Internal` AppError so
 * callers always deal with a uniform error type.
 */
export async function invoke<T>(
  cmd: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, payload);
  } catch (raw) {
    throw normalizeError(raw);
  }
}

/**
 * Normalize an unknown Tauri IPC error to an `AppError`.
 *
 * Tauri serializes command errors as the JSON the command returned — in our
 * case always `{ kind, message, retryable, details? }`. If the shape doesn't
 * match we fall back to a synthetic Internal error.
 */
function normalizeError(raw: unknown): AppError {
  if (isAppError(raw)) {
    return raw;
  }
  // Tauri may wrap the payload in an object with a `message` string.
  if (typeof raw === "object" && raw !== null) {
    const candidate = raw as Record<string, unknown>;
    if (isAppError(candidate)) {
      return candidate as AppError;
    }
  }
  // Last resort: synthetic Internal with a descriptive trace.
  const trace =
    typeof raw === "string" ? raw : JSON.stringify(raw, null, 0).slice(0, 200);
  return {
    kind: "Internal",
    message: `Unexpected IPC error: ${trace}`,
    retryable: false,
    details: { traceId: `ipc-normalize-${Date.now()}` },
  } satisfies AppError;
}

// ---------------------------------------------------------------------------
// listen<K>
// ---------------------------------------------------------------------------

/**
 * Typed wrapper around Tauri's `listen`.
 *
 * The event name must be a key in `TauriEventMap` — unknown event names are
 * a compile error.  The handler receives the payload typed by the map entry.
 *
 * Returns an `UnlistenFn` that should be called when the listener is no
 * longer needed (e.g. on component unmount).
 */
export async function listen<K extends keyof TauriEventMap>(
  event: K,
  handler: (payload: TauriEventMap[K]) => void,
): Promise<UnlistenFn> {
  return tauriListen<TauriEventMap[K]>(event, (e) => handler(e.payload));
}
