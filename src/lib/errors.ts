/**
 * AppError — discriminated union mirroring the Rust AppError enum.
 *
 * The IPC envelope shape is `{ kind, message, retryable, details? }`.
 * Each variant carries the same fields that the Rust serializer emits.
 *
 * OCP: adding a new backend variant = adding one union member here + one
 * branch in `present()`. No other consumer changes.
 */

// ---------------------------------------------------------------------------
// Detail types — match Rust per-variant detail structs (camelCase)
// ---------------------------------------------------------------------------

export interface AuthDetails {
  reason: "expired" | "invalid" | "missing";
}

export interface AccessDeniedDetails {
  op: string;
  resource: string;
}

export interface NotFoundDetails {
  resource: string;
}

export interface ConflictDetails {
  etagExpected: string;
  etagActual: string | null;
}

export interface RateLimitedDetails {
  retryAfterMs: number | null;
}

export interface UnsupportedDetails {
  op: string;
  provider: string;
}

export interface NetworkDetails {
  source: string;
}

export interface LockedDetails {
  lockId: string;
  opName: string;
}

export interface ValidationDetails {
  field: string;
  hint: string;
}

export interface ProviderSpecificDetails {
  code: string;
  message: string;
}

export interface InternalDetails {
  traceId: string;
}

// ---------------------------------------------------------------------------
// AppError discriminated union
// ---------------------------------------------------------------------------

export type AppError =
  | { kind: "Auth"; message: string; retryable: false; details: AuthDetails }
  | {
      kind: "AccessDenied";
      message: string;
      retryable: false;
      details: AccessDeniedDetails;
    }
  | {
      kind: "NotFound";
      message: string;
      retryable: false;
      details: NotFoundDetails;
    }
  | {
      kind: "Conflict";
      message: string;
      retryable: false;
      details: ConflictDetails;
    }
  | {
      kind: "RateLimited";
      message: string;
      retryable: true;
      details: RateLimitedDetails;
    }
  | {
      kind: "Unsupported";
      message: string;
      retryable: false;
      details: UnsupportedDetails;
    }
  | {
      kind: "Network";
      message: string;
      retryable: true;
      details: NetworkDetails;
    }
  | { kind: "Cancelled"; message: string; retryable: false; details?: never }
  | {
      kind: "Locked";
      message: string;
      retryable: false;
      details: LockedDetails;
    }
  | {
      kind: "Validation";
      message: string;
      retryable: false;
      details: ValidationDetails;
    }
  | {
      kind: "ProviderSpecific";
      message: string;
      retryable: false;
      details: ProviderSpecificDetails;
    }
  | {
      kind: "Internal";
      message: string;
      retryable: false;
      details: InternalDetails;
    };

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    "message" in value &&
    "retryable" in value
  );
}

export function isAuthError(
  error: AppError,
): error is Extract<AppError, { kind: "Auth" }> {
  return error.kind === "Auth";
}

export function isNotFoundError(
  error: AppError,
): error is Extract<AppError, { kind: "NotFound" }> {
  return error.kind === "NotFound";
}

export function isValidationError(
  error: AppError,
): error is Extract<AppError, { kind: "Validation" }> {
  return error.kind === "Validation";
}

export function isNetworkError(
  error: AppError,
): error is Extract<AppError, { kind: "Network" }> {
  return error.kind === "Network";
}

export function isRetryable(error: AppError): boolean {
  return error.retryable;
}

// ---------------------------------------------------------------------------
// Presentation policy
// ---------------------------------------------------------------------------

/**
 * Where and how to surface an error in the UI.
 *
 * `placement`:
 * - `"silent"` — swallow entirely; do not show anywhere.
 * - `"panel"` — log to the notifications panel only (background errors).
 * - `"panel+toast"` — log + ephemeral toast (global user-initiated ops).
 * - `"panel+inline"` — log + inline message inside the triggering surface.
 * - `"inline"` — inline only; panel is optional/omitted for low-signal cases.
 *
 * `severity` maps directly to the UI severity indicator.
 */
export interface PresentationPolicy {
  placement: "silent" | "panel" | "panel+toast" | "panel+inline" | "inline";
  severity: "info" | "warning" | "error";
}

/**
 * Context in which an error occurred.
 *
 * - `"background"` — the operation ran in the background without direct user
 *   interaction (e.g. a background sync, cache refresh). Errors should not
 *   interrupt the user.
 * - `"userInitiated"` — the error is the direct result of a user action
 *   (e.g. clicking Save, triggering an upload). Errors should be visible near
 *   the interaction surface.
 */
export type ErrorContext = "background" | "userInitiated";

/**
 * Map an `AppError` to a `PresentationPolicy`.
 *
 * Full AC-9 mapping:
 * - `Cancelled` → silent (never shown)
 * - `Network` (retryable) → panel + toast
 * - `Internal` → panel + toast (with trace ID)
 * - `RateLimited` → panel + toast (with retry-after countdown)
 * - `Auth` / `AccessDenied` in background context → panel only
 * - `Auth` / `AccessDenied` in user-initiated context → panel + inline
 * - `Validation` (user-initiated) → inline only
 * - `Locked` → panel + inline (always blocks the active surface)
 * - `NotFound` → panel + inline
 * - `Conflict` → panel + toast (optimistic concurrency)
 * - `Unsupported` → panel + toast
 * - `ProviderSpecific` → panel + toast
 *
 * OCP: adding a new error variant = adding one case here. No other changes needed.
 */
export function present(
  error: AppError,
  ctx: ErrorContext = "background",
): PresentationPolicy {
  switch (error.kind) {
    case "Cancelled":
      return { placement: "silent", severity: "info" };

    case "Network":
      return { placement: "panel+toast", severity: "warning" };

    case "Internal":
      return { placement: "panel+toast", severity: "error" };

    case "RateLimited":
      return { placement: "panel+toast", severity: "warning" };

    case "Auth":
    case "AccessDenied":
      if (ctx === "background") {
        return { placement: "panel", severity: "error" };
      }
      // userInitiated: switched from `panel+inline` to `panel+toast`. A
      // user just clicked Validate / Save / etc. expecting feedback on a
      // failed credential; `+inline` only shows up when the caller has a
      // dedicated inline-error slot (ProfileEditor.tsx manages its own
      // local state via setValidationError, independent of present()).
      // For everything else — sidebar Validate, command palette runs,
      // toolbar actions — the panel-only placement was silent unless the
      // user happened to have the notifications panel open. Forcing a
      // toast guarantees the message lands somewhere visible.
      return { placement: "panel+toast", severity: "error" };

    case "Validation":
      // Inline-only for user-initiated; panel optional for background
      if (ctx === "userInitiated") {
        return { placement: "inline", severity: "error" };
      }
      return { placement: "panel+inline", severity: "error" };

    case "Locked":
      return { placement: "panel+inline", severity: "warning" };

    case "NotFound":
      return { placement: "panel+inline", severity: "error" };

    case "Conflict":
      return { placement: "panel+toast", severity: "warning" };

    case "Unsupported":
      return { placement: "panel+toast", severity: "warning" };

    case "ProviderSpecific":
      return { placement: "panel+toast", severity: "error" };
  }
}

// ---------------------------------------------------------------------------
// Toast bus — minimal pub/sub for the Toaster component
// ---------------------------------------------------------------------------

/**
 * A notification payload dispatched to the toast bus.
 *
 * Mirrors the fields needed by `Toaster` without importing the full Zustand
 * store in this lower-level module.
 */
export interface ToastNotification {
  id: string;
  title: string;
  message: string;
  severity: "info" | "warning" | "error" | "success";
  /**
   * Optional clickable action on the toast (e.g. "Open folder" after a
   * download completes). The toast container renders this as a button and
   * dismisses the toast when the callback runs.
   */
  action?: {
    label: string;
    onClick: () => void;
  };
}

type ToastListener = (n: ToastNotification) => void;
const toastListeners: ToastListener[] = [];

/** Subscribe to toast events. Returns an unsubscribe function. */
export function onToast(listener: ToastListener): () => void {
  toastListeners.push(listener);
  return () => {
    const idx = toastListeners.indexOf(listener);
    if (idx !== -1) toastListeners.splice(idx, 1);
  };
}

/** Emit a toast notification to all subscribers. */
function emitToast(n: ToastNotification): void {
  for (const l of toastListeners) {
    l(n);
  }
}

/**
 * Public toast emitter for non-error flows (success confirmations,
 * informational notices). Use `surfaceError` / `surfaceUnknownError` for
 * error paths — those go through the presentation policy.
 */
export function notify(n: ToastNotification): void {
  emitToast(n);
}

// ---------------------------------------------------------------------------
// dispatch — fan-out helper
// ---------------------------------------------------------------------------

import type { Notification } from "@/store/notifications";

/**
 * Fan-out helper: given a notification payload and a presentation policy
 * placement, push to the appropriate surfaces.
 *
 * - Always pushes to the Zustand notifications store (panel) unless
 *   placement is `"silent"` or `"inline"`.
 * - Conditionally pushes to the toast bus when placement contains `+toast`.
 *
 * The store import is lazy (dynamic) to avoid a circular dependency between
 * `errors.ts` and `store/notifications.ts`. Call sites that already imported
 * the store can also push directly.
 *
 * OCP: adding a fourth surface (e.g. status bar) = one new branch here +
 * one new component. No other callers change.
 */
export async function dispatch(
  notification: Notification,
  placement: PresentationPolicy["placement"],
): Promise<void> {
  // Push to panel (Zustand store) unless silent or inline-only.
  if (placement !== "silent" && placement !== "inline") {
    const { useNotificationsStore } = await import("@/store/notifications");
    useNotificationsStore.getState().add(notification);
  }

  // Push to toast bus when placement includes toast.
  if (placement === "panel+toast") {
    emitToast({
      id: notification.id,
      title: notification.title,
      message: notification.message,
      severity: notification.severity,
    });
  }
}

// ---------------------------------------------------------------------------
// surfaceError — one-call convenience for user-facing error reporting
// ---------------------------------------------------------------------------

/** Human-friendly title for each AppError kind. */
function titleForKind(kind: AppError["kind"]): string {
  switch (kind) {
    case "Auth":
      return "Authentication failed";
    case "AccessDenied":
      return "Access denied";
    case "NotFound":
      return "Not found";
    case "Conflict":
      return "Conflict";
    case "RateLimited":
      return "Rate limited";
    case "Unsupported":
      return "Unsupported operation";
    case "Network":
      return "Network error";
    case "Cancelled":
      return "Cancelled";
    case "Locked":
      return "Resource locked";
    case "Validation":
      return "Invalid input";
    case "ProviderSpecific":
      return "Provider error";
    case "Internal":
      return "Internal error";
  }
}

export interface SurfaceErrorOptions {
  /** Logical operation name — appears in the notification ID + panel entry. */
  operation: string;
  /** Optional resource identifier the operation targeted (profile ID, bucket, key, etc.). */
  resource?: string | null;
  /** Defaults to `"userInitiated"`. */
  context?: ErrorContext;
  /** Override the auto-derived title (e.g. "Profile validation failed"). */
  title?: string;
}

/**
 * Surface a backend `AppError` through the standard notification pipeline.
 *
 * One-call helper that replaces the boilerplate of constructing a
 * `Notification`, calling `present()`, and calling `dispatch()` at every
 * mutation/onError site. Use this in:
 *
 * - `useMutation.onError` handlers
 * - `try/catch` blocks around `await invoke(...)` calls
 * - `useSuccess` handlers that receive `{ ok: false, error }` payloads
 *
 * Silently no-ops for `Cancelled` (its policy is `"silent"`).
 */
export async function surfaceError(
  error: AppError,
  opts: SurfaceErrorOptions,
): Promise<void> {
  const ctx = opts.context ?? "userInitiated";
  const policy = present(error, ctx);
  if (policy.placement === "silent") return;

  const notification: Notification = {
    id: `${opts.operation}:${opts.resource ?? "global"}:${Date.now()}`,
    severity: policy.severity,
    category: ctx,
    title: opts.title ?? titleForKind(error.kind),
    message: error.message,
    resource: opts.resource ?? null,
    operation: opts.operation,
    timestamp: Date.now(),
    details: "details" in error ? (error.details ?? null) : null,
  };

  await dispatch(notification, policy.placement);
}

/**
 * Surface an arbitrary unknown error value.
 *
 * Wraps `surfaceError` for cases where the caller doesn't know the error
 * shape upfront (typical `useMutation.onError` and `catch (err: unknown)`
 * sites). When `err` is not an `AppError`, fabricates a synthetic
 * `Internal`-shaped notification so the user still sees *something* rather
 * than silence.
 */
export async function surfaceUnknownError(
  err: unknown,
  opts: SurfaceErrorOptions,
): Promise<void> {
  if (isAppError(err)) {
    await surfaceError(err, opts);
    return;
  }

  const ctx = opts.context ?? "userInitiated";
  const message =
    err !== null &&
    typeof err === "object" &&
    "message" in err &&
    typeof (err as { message: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);

  const notification: Notification = {
    id: `${opts.operation}:${opts.resource ?? "global"}:${Date.now()}`,
    severity: "error",
    category: ctx,
    title: opts.title ?? "Unexpected error",
    message,
    resource: opts.resource ?? null,
    operation: opts.operation,
    timestamp: Date.now(),
    details: null,
  };

  await dispatch(notification, "panel+toast");
}
