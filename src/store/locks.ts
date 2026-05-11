/**
 * Zustand slice for resource locks.
 *
 * Mirrors backend `lock:acquired` and `lock:released` events so the UI can
 * gate conflicting actions in context menus, toolbars, and inline controls.
 *
 * Design:
 * - Each lock carries a `resource` scope string and a human-readable `opName`.
 * - `byScope(scope)` returns locks whose `resource` starts with or equals the
 *   given scope. Longest-prefix semantics match the Rust lock registry.
 * - `isLocked(scope)` is a boolean convenience on top of `byScope`.
 * - `blockedActions(scope)` maps active lock opNames to the set of command ids
 *   that must be disabled (defined via LOCK_BLOCKED_ACTIONS_MAP).
 *
 * OCP: adding a new op that blocks additional commands = one entry in
 * LOCK_BLOCKED_ACTIONS_MAP. The hook and store shape do not change.
 */

import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single active resource lock. Mirrors the `lock:acquired` event payload. */
export interface ResourceLock {
  lockId: string;
  resource: string;
  opName: string;
}

export interface LocksState {
  locks: ResourceLock[];

  // ---- Actions ----

  /** Add a lock (called when `lock:acquired` fires). */
  addLock(lock: ResourceLock): void;

  /** Remove a lock by id (called when `lock:released` fires). */
  removeLock(lockId: string): void;

  /** Remove all locks (called on app startup to clear stale locks). */
  clearAll(): void;

  // ---- Selectors ----

  /** Locks whose resource scope matches the given scope (prefix match). */
  byScope(scope: string): ResourceLock[];

  /** Whether any lock matches the given scope. */
  isLocked(scope: string): boolean;
}

// ---------------------------------------------------------------------------
// Lock → blocked command ids mapping
//
// Maps an operation name (opName from the backend) to the set of command ids
// that must be disabled while that operation holds a lock on the same scope.
// This is the single authority for what "conflicts with what".
//
// OCP: adding a new op = one entry here.
// ---------------------------------------------------------------------------

export const LOCK_BLOCKED_ACTIONS_MAP: Readonly<Record<string, string[]>> = {
  upload: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.copy",
    "file.move_to",
    "file.copy_to",
    "storage_class.change",
  ],
  download: [],
  delete: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.copy",
    "file.move_to",
    "file.copy_to",
    "storage_class.change",
  ],
  copy: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.move_to",
    "storage_class.change",
  ],
  move: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.copy",
    "file.move_to",
    "file.copy_to",
    "storage_class.change",
  ],
  rename: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.copy",
    "file.move_to",
    "file.copy_to",
    "storage_class.change",
  ],
  storage_class_change: [
    "file.delete",
    "file.rename",
    "file.cut",
    "file.copy",
    "file.move_to",
    "file.copy_to",
    "storage_class.change",
  ],
} as const;

// ---------------------------------------------------------------------------
// Scope matching helper
// ---------------------------------------------------------------------------

/**
 * Returns true when the lock's `resource` scope intersects the given scope.
 *
 * Intersection: either `resource` is a prefix of `scope` (lock is on a parent)
 * or `scope` is a prefix of `resource` (lock is on a child), or they are equal.
 */
function scopeIntersects(lockResource: string, scope: string): boolean {
  if (lockResource === scope) return true;
  if (scope.startsWith(lockResource)) return true;
  if (lockResource.startsWith(scope)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Store factory — isolated instances for tests
// ---------------------------------------------------------------------------

export function createLocksStore() {
  return create<LocksState>((set, get) => ({
    locks: [],

    addLock(lock: ResourceLock) {
      set((s) => {
        // Deduplicate by lockId.
        if (s.locks.some((l) => l.lockId === lock.lockId)) return s;
        return { locks: [...s.locks, lock] };
      });
    },

    removeLock(lockId: string) {
      set((s) => ({ locks: s.locks.filter((l) => l.lockId !== lockId) }));
    },

    clearAll() {
      set({ locks: [] });
    },

    byScope(scope: string): ResourceLock[] {
      return get().locks.filter((l) => scopeIntersects(l.resource, scope));
    },

    isLocked(scope: string): boolean {
      return get().locks.some((l) => scopeIntersects(l.resource, scope));
    },
  }));
}

// ---------------------------------------------------------------------------
// App-level singleton
// ---------------------------------------------------------------------------

export const useLocksStore = createLocksStore();

// ---------------------------------------------------------------------------
// useLocks hook
// ---------------------------------------------------------------------------

/**
 * React hook that returns lock state for a given resource scope.
 *
 * @param scope - The resource scope string, e.g. `"p-1/my-bucket/photos/"`.
 *
 * Returns:
 * - `locks`          — active lock records intersecting the scope.
 * - `isLocked`       — `true` when any lock intersects.
 * - `blockedActions` — command ids that must be disabled due to active locks.
 *
 * Implementation note: we subscribe to the raw `locks` array and filter in
 * the selector so that Zustand can determine reference equality. Calling
 * `s.byScope(scope)` from the selector would create a new array on every
 * render even when the locks array hasn't changed, causing infinite re-renders.
 */
export function useLocks(scope: string): {
  locks: ResourceLock[];
  isLocked: boolean;
  blockedActions: string[];
} {
  // Subscribe to raw locks and filter in the render path.
  // Zustand re-renders only when `s.locks` reference changes (i.e. on addLock
  // or removeLock), not on every render cycle.
  const allLocks = useLocksStore((s) => s.locks);
  const activeLocks = allLocks.filter((l) =>
    scopeIntersects(l.resource, scope),
  );

  const blockedActions = activeLocks.flatMap((lock) => {
    const key = lock.opName.toLowerCase();
    return LOCK_BLOCKED_ACTIONS_MAP[key] ?? [];
  });

  // Deduplicate.
  const uniqueBlocked = [...new Set(blockedActions)];

  return {
    locks: activeLocks,
    isLocked: activeLocks.length > 0,
    blockedActions: uniqueBlocked,
  };
}
