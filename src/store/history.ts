/**
 * Per-pane navigation history (back/forward stacks).
 *
 * Subscribes to `usePanesStore` and records each location change.
 * Provides back/forward/canBack/canForward for the active pane.
 *
 * Loop guard: when `back`/`forward` itself triggers `setLocation`, the
 * resulting location-change event must NOT be re-recorded as a new history
 * entry. We use an internal `inFlight` flag for that.
 *
 * OCP: extension to per-pane history depth limit, time-based TTL, or a
 * "history panel" view all live in this single module.
 */

import { usePanesStore } from "./panes";
import type { S3Location } from "./ui";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PaneHistory {
  /** Past locations (most recent at the end). */
  back: S3Location[];
  /** Future locations after a back() call (most recent at the end). */
  forward: S3Location[];
  /** Last seen location for this pane (for diff detection on update). */
  last: S3Location | null;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const histories = new Map<string, PaneHistory>();
let inFlight = false;
let unsubscribe: (() => void) | null = null;

// Tiny pub-sub so React components can observe canBack / canForward
// changes via useSyncExternalStore. Any mutation that affects history
// stacks should call `notify()`.
const subscribers = new Set<() => void>();
function notify(): void {
  for (const fn of subscribers) fn();
}

/** Subscribe to history-stack mutations (back/forward/install). */
export function subscribeHistory(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function getOrInit(paneId: string): PaneHistory {
  let h = histories.get(paneId);
  if (!h) {
    h = { back: [], forward: [], last: null };
    histories.set(paneId, h);
  }
  return h;
}

function locationsEqual(a: S3Location | null, b: S3Location | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.profileId === b.profileId &&
    a.bucket === b.bucket &&
    a.prefix === b.prefix
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Begin tracking pane location changes.
 * Idempotent: calling twice is a no-op.
 */
export function installHistoryTracker(): () => void {
  if (unsubscribe) return unsubscribe;

  unsubscribe = usePanesStore.subscribe((state) => {
    if (inFlight) return;
    let mutated = false;
    for (const pane of state.panes) {
      const h = getOrInit(pane.id);
      if (!locationsEqual(h.last, pane.location)) {
        if (h.last) {
          h.back.push(h.last);
          // Forward stack invalidated by a fresh navigation.
          h.forward = [];
        }
        h.last = pane.location;
        mutated = true;
      }
    }
    if (mutated) notify();
  });

  return () => {
    unsubscribe?.();
    unsubscribe = null;
    histories.clear();
  };
}

/** Move the given pane back one step. Returns true if it moved. */
export function back(paneId: string): boolean {
  const h = histories.get(paneId);
  if (!h || h.back.length === 0) return false;
  const target = h.back.pop();
  if (!target) return false;
  if (h.last) h.forward.push(h.last);
  h.last = target;

  inFlight = true;
  try {
    usePanesStore.getState().setLocation(paneId, target);
  } finally {
    inFlight = false;
  }
  notify();
  return true;
}

/** Move the given pane forward one step. Returns true if it moved. */
export function forward(paneId: string): boolean {
  const h = histories.get(paneId);
  if (!h || h.forward.length === 0) return false;
  const target = h.forward.pop();
  if (!target) return false;
  if (h.last) h.back.push(h.last);
  h.last = target;

  inFlight = true;
  try {
    usePanesStore.getState().setLocation(paneId, target);
  } finally {
    inFlight = false;
  }
  notify();
  return true;
}

export function canBack(paneId: string): boolean {
  const h = histories.get(paneId);
  return !!h && h.back.length > 0;
}

export function canForward(paneId: string): boolean {
  const h = histories.get(paneId);
  return !!h && h.forward.length > 0;
}

/** Test-only: clear all histories. */
export function _resetHistoriesForTest(): void {
  histories.clear();
}
