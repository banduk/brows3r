/**
 * Tests for src/store/locks.ts
 *
 * Coverage:
 * 1. addLock / removeLock / clearAll basic operations.
 * 2. byScope: prefix matching semantics.
 * 3. isLocked: boolean convenience selector.
 * 4. useLocks: returns correct blockedActions for an active upload lock.
 * 5. AC-4 lock release: simulate lock:released → blocked actions become empty.
 * 6. LOCK_BLOCKED_ACTIONS_MAP: upload blocks expected command ids.
 */

import { renderHook } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLocksStore,
  LOCK_BLOCKED_ACTIONS_MAP,
  useLocks,
  useLocksStore,
} from "./locks";

// ---------------------------------------------------------------------------
// Store unit tests (isolated instances)
// ---------------------------------------------------------------------------

describe("locks store — basic operations", () => {
  it("addLock stores a lock and byScope returns it for matching scope", () => {
    const store = createLocksStore();
    store.getState().addLock({
      lockId: "l1",
      resource: "p1/my-bucket/photos/",
      opName: "upload",
    });
    const locks = store.getState().byScope("p1/my-bucket/photos/");
    expect(locks).toHaveLength(1);
    expect(locks[0]?.lockId).toBe("l1");
  });

  it("removeLock removes the lock by id", () => {
    const store = createLocksStore();
    store.getState().addLock({
      lockId: "l1",
      resource: "p1/bucket/",
      opName: "upload",
    });
    store.getState().removeLock("l1");
    expect(store.getState().byScope("p1/bucket/")).toHaveLength(0);
  });

  it("clearAll removes all locks", () => {
    const store = createLocksStore();
    store
      .getState()
      .addLock({ lockId: "l1", resource: "a/b/", opName: "upload" });
    store
      .getState()
      .addLock({ lockId: "l2", resource: "c/d/", opName: "delete" });
    store.getState().clearAll();
    expect(store.getState().locks).toHaveLength(0);
  });

  it("addLock is idempotent for same lockId", () => {
    const store = createLocksStore();
    const lock = { lockId: "l1", resource: "a/b/", opName: "upload" };
    store.getState().addLock(lock);
    store.getState().addLock(lock);
    expect(store.getState().locks).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// byScope prefix matching
// ---------------------------------------------------------------------------

describe("locks store — byScope prefix matching", () => {
  it("parent scope matches child resource", () => {
    const store = createLocksStore();
    // Lock on child, query on parent.
    store.getState().addLock({
      lockId: "l1",
      resource: "p1/bucket/photos/summer/",
      opName: "upload",
    });
    expect(store.getState().byScope("p1/bucket/")).toHaveLength(1);
  });

  it("child scope matches parent resource", () => {
    const store = createLocksStore();
    // Lock on parent, query on child.
    store
      .getState()
      .addLock({ lockId: "l1", resource: "p1/bucket/", opName: "upload" });
    expect(store.getState().byScope("p1/bucket/photos/")).toHaveLength(1);
  });

  it("exact match works", () => {
    const store = createLocksStore();
    store
      .getState()
      .addLock({ lockId: "l1", resource: "p1/bucket/k.txt", opName: "delete" });
    expect(store.getState().byScope("p1/bucket/k.txt")).toHaveLength(1);
  });

  it("unrelated scope does not match", () => {
    const store = createLocksStore();
    store
      .getState()
      .addLock({ lockId: "l1", resource: "p1/bucket-a/", opName: "upload" });
    expect(store.getState().byScope("p1/bucket-b/")).toHaveLength(0);
  });

  it("isLocked returns true when a matching lock exists", () => {
    const store = createLocksStore();
    store
      .getState()
      .addLock({ lockId: "l1", resource: "p1/b/", opName: "upload" });
    expect(store.getState().isLocked("p1/b/photos/")).toBe(true);
  });

  it("isLocked returns false when no matching lock", () => {
    const store = createLocksStore();
    expect(store.getState().isLocked("p1/empty-bucket/")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LOCK_BLOCKED_ACTIONS_MAP
// ---------------------------------------------------------------------------

describe("LOCK_BLOCKED_ACTIONS_MAP", () => {
  it("upload lock blocks file.delete", () => {
    expect(LOCK_BLOCKED_ACTIONS_MAP.upload).toContain("file.delete");
  });

  it("upload lock blocks storage_class.change", () => {
    expect(LOCK_BLOCKED_ACTIONS_MAP.upload).toContain("storage_class.change");
  });

  it("move lock blocks all mutating actions", () => {
    const blocked = LOCK_BLOCKED_ACTIONS_MAP.move ?? [];
    expect(blocked).toContain("file.delete");
    expect(blocked).toContain("file.rename");
    expect(blocked).toContain("storage_class.change");
  });
});

// ---------------------------------------------------------------------------
// useLocks hook (singleton store)
// ---------------------------------------------------------------------------

afterEach(() => {
  useLocksStore.getState().clearAll();
});

describe("useLocks hook", () => {
  it("returns empty locks and blockedActions when no locks exist", () => {
    const { result } = renderHook(() => useLocks("p1/bucket/"));
    expect(result.current.locks).toHaveLength(0);
    expect(result.current.isLocked).toBe(false);
    expect(result.current.blockedActions).toHaveLength(0);
  });

  it("returns blocked actions for an active upload lock on the same key", () => {
    act(() => {
      useLocksStore.getState().addLock({
        lockId: "upload-1",
        resource: "p1/bucket/file.txt",
        opName: "upload",
      });
    });

    const { result } = renderHook(() => useLocks("p1/bucket/file.txt"));
    expect(result.current.isLocked).toBe(true);
    expect(result.current.blockedActions).toContain("file.delete");
    expect(result.current.blockedActions).toContain("storage_class.change");
  });

  it("AC-4: lock released → blocked actions become empty", () => {
    act(() => {
      useLocksStore.getState().addLock({
        lockId: "upload-1",
        resource: "p1/bucket/file.txt",
        opName: "upload",
      });
    });

    const { result } = renderHook(() => useLocks("p1/bucket/file.txt"));
    expect(result.current.isLocked).toBe(true);

    // Simulate lock:released.
    act(() => {
      useLocksStore.getState().removeLock("upload-1");
    });

    expect(result.current.isLocked).toBe(false);
    expect(result.current.blockedActions).toHaveLength(0);
  });

  it("blockedActions are deduplicated even when multiple locks block the same command", () => {
    act(() => {
      useLocksStore
        .getState()
        .addLock({ lockId: "l1", resource: "p1/b/", opName: "upload" });
      useLocksStore
        .getState()
        .addLock({ lockId: "l2", resource: "p1/b/", opName: "delete" });
    });

    const { result } = renderHook(() => useLocks("p1/b/"));
    const seen = new Set(result.current.blockedActions);
    // If deduplicated, set size equals array length.
    expect(seen.size).toBe(result.current.blockedActions.length);
  });
});
