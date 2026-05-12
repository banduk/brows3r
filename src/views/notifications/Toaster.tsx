/**
 * Toaster — stacked toast container rendered in the bottom-right corner.
 *
 * Listens to the `onToast` bus from `src/lib/errors.ts`.
 * Toasts auto-dismiss after 5 seconds.
 * Severity maps to a color accent.
 *
 * Mounted once in App.tsx; always present in the DOM so it can receive
 * notifications at any time.
 *
 * OCP: to add a new surface (e.g. status bar) add a new component + one
 * branch in `dispatch()`. This component stays unchanged.
 */

import { useCallback, useEffect, useState } from "react";
import type { ToastNotification } from "@/lib/errors";
import { onToast } from "@/lib/errors";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const AUTO_DISMISS_MS = 5_000;

// ---------------------------------------------------------------------------
// Severity styling
// ---------------------------------------------------------------------------

type Severity = ToastNotification["severity"];

const SEVERITY_CLASS: Record<Severity, string> = {
  info: "border-l-blue-500 bg-background",
  warning: "border-l-yellow-500 bg-background",
  error: "border-l-red-500 bg-background",
  success: "border-l-green-500 bg-background",
};

const SEVERITY_ICON: Record<Severity, string> = {
  info: "ℹ",
  warning: "⚠",
  error: "✕",
  success: "✓",
};

const SEVERITY_ICON_CLASS: Record<Severity, string> = {
  info: "text-blue-500",
  warning: "text-yellow-500",
  error: "text-red-500",
  success: "text-green-500",
};

// ---------------------------------------------------------------------------
// Internal entry
// ---------------------------------------------------------------------------

interface ToastEntry extends ToastNotification {
  /** Unique render key (may differ from notification id for deduplication). */
  key: string;
}

// ---------------------------------------------------------------------------
// Toaster
// ---------------------------------------------------------------------------

export function Toaster() {
  const [toasts, setToasts] = useState<ToastEntry[]>([]);

  const remove = useCallback((key: string) => {
    setToasts((prev) => prev.filter((t) => t.key !== key));
  }, []);

  useEffect(() => {
    return onToast((notification) => {
      const key = `${notification.id}-${Date.now().toString()}`;
      setToasts((prev) => [...prev, { ...notification, key }]);

      // Auto-dismiss after timeout.
      const timer = window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.key !== key));
      }, AUTO_DISMISS_MS);

      // If the component unmounts before the timer fires, the cleanup below
      // handles it via the outer useEffect return — but the timer ref is
      // captured in closure here so we'd need to track all timers. Instead we
      // accept the minor race: the timer may fire after unmount but setToasts
      // is a no-op on an unmounted component in React 18+.
      return () => clearTimeout(timer);
    });
  }, []);

  if (toasts.length === 0) return null;

  return (
    <section
      aria-label="Toast notifications"
      aria-live="polite"
      aria-atomic="false"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none"
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.key} toast={toast} onDismiss={remove} />
      ))}
    </section>
  );
}

// ---------------------------------------------------------------------------
// ToastItem
// ---------------------------------------------------------------------------

interface ToastItemProps {
  toast: ToastEntry;
  onDismiss: (key: string) => void;
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  return (
    <div
      role="alert"
      aria-label={`${toast.severity}: ${toast.title}`}
      className={cn(
        "pointer-events-auto flex items-start gap-3 rounded-lg border border-l-4 p-3 shadow-md",
        SEVERITY_CLASS[toast.severity],
      )}
    >
      {/* Icon */}
      <span
        className={cn(
          "text-sm shrink-0 mt-0.5 select-none",
          SEVERITY_ICON_CLASS[toast.severity],
        )}
        aria-hidden="true"
      >
        {SEVERITY_ICON[toast.severity]}
      </span>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{toast.title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{toast.message}</p>
        {toast.action && (
          <button
            type="button"
            onClick={() => {
              toast.action?.onClick();
              onDismiss(toast.key);
            }}
            className="mt-1.5 text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {/* Dismiss */}
      <button
        type="button"
        onClick={() => onDismiss(toast.key)}
        className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
        aria-label={`Dismiss: ${toast.title}`}
      >
        ×
      </button>
    </div>
  );
}
