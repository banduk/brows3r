/**
 * InlineErrorSlot — small reusable error renderer for inline placement.
 *
 * Usage:
 *   <InlineErrorSlot error={appError} onRetry={() => refetch()} />
 *
 * Shows the error message; renders a "Retry" button only when
 * `error.retryable` is true. The `onRetry` callback is optional — if absent
 * the Retry button is not rendered even for retryable errors (callers decide
 * whether a retry action is available in their context).
 *
 * A11y: role="alert" ensures screen readers announce the error immediately.
 */

import type { AppError } from "@/lib/errors";
import { cn } from "@/lib/utils";

export interface InlineErrorSlotProps {
  error: AppError;
  onRetry?: () => void;
  className?: string;
}

export function InlineErrorSlot({
  error,
  onRetry,
  className,
}: InlineErrorSlotProps) {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={cn(
        "flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive",
        className,
      )}
    >
      <span className="shrink-0 select-none mt-0.5" aria-hidden="true">
        ✕
      </span>
      <div className="flex-1 min-w-0">
        <p className="break-words">{error.message}</p>
        {error.retryable && onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 text-xs underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
