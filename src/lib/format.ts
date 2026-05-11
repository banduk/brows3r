/**
 * Formatting utilities shared across the UI.
 *
 * OCP: each function is a one-function swap — e.g. `formatRelative` can be
 * replaced with `date-fns` without touching callers.
 */

// ---------------------------------------------------------------------------
// formatBytes
// ---------------------------------------------------------------------------

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Format a byte count as a human-readable string.
 *
 * Examples:
 *   formatBytes(0)         → "0 B"
 *   formatBytes(1023)      → "1023 B"
 *   formatBytes(1024)      → "1.0 KB"
 *   formatBytes(1536)      → "1.5 KB"
 *   formatBytes(1073741824) → "1.0 GB"
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes === 0) return "0 B";

  const exp = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    BYTE_UNITS.length - 1,
  );
  if (exp === 0) return `${bytes.toFixed(0)} B`;

  const value = bytes / 1024 ** exp;
  const unit = BYTE_UNITS[exp];
  return `${value.toFixed(1)} ${unit}`;
}

// ---------------------------------------------------------------------------
// formatRelative
// ---------------------------------------------------------------------------

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;
const YEAR_MS = 365 * DAY_MS;

/**
 * Format a Unix timestamp (milliseconds) as a relative time string.
 *
 * Examples (assuming "now" is the reference):
 *   "just now"
 *   "30 sec ago"
 *   "2 min ago"
 *   "3 hrs ago"
 *   "5 days ago"
 *   "2 weeks ago"
 *   "3 months ago"
 *   "1 year ago"
 *
 * OCP: replace with date-fns `formatDistanceToNow` by swapping this function.
 */
export function formatRelative(timestampMs: number, nowMs?: number): string {
  const now = nowMs ?? Date.now();
  const diffMs = now - timestampMs;

  if (diffMs < 0) return "just now";
  if (diffMs < 10 * SECOND_MS) return "just now";
  if (diffMs < MINUTE_MS) {
    const secs = Math.floor(diffMs / SECOND_MS);
    return `${secs.toString()} sec ago`;
  }
  if (diffMs < HOUR_MS) {
    const mins = Math.floor(diffMs / MINUTE_MS);
    return `${mins.toString()} min ago`;
  }
  if (diffMs < DAY_MS) {
    const hrs = Math.floor(diffMs / HOUR_MS);
    return `${hrs.toString()} ${hrs === 1 ? "hr" : "hrs"} ago`;
  }
  if (diffMs < WEEK_MS) {
    const days = Math.floor(diffMs / DAY_MS);
    return `${days.toString()} ${days === 1 ? "day" : "days"} ago`;
  }
  if (diffMs < MONTH_MS) {
    const weeks = Math.floor(diffMs / WEEK_MS);
    return `${weeks.toString()} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  if (diffMs < YEAR_MS) {
    const months = Math.floor(diffMs / MONTH_MS);
    return `${months.toString()} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(diffMs / YEAR_MS);
  return `${years.toString()} ${years === 1 ? "year" : "years"} ago`;
}

// ---------------------------------------------------------------------------
// formatDate
// ---------------------------------------------------------------------------

/**
 * Format a Unix timestamp (milliseconds) as a locale date-time string.
 *
 * Uses the browser's Intl.DateTimeFormat for localization.
 *
 * Example: "May 10, 2026, 04:20 AM"
 */
export function formatDate(timestampMs: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestampMs));
}
