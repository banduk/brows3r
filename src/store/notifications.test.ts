/**
 * Tests for the notifications Zustand store.
 */

import { describe, expect, it } from "vitest";
import type { Notification } from "./notifications";
import { createNotificationsStore } from "./notifications";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeNotification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: "n-1",
    severity: "info",
    category: "background",
    title: "Test notification",
    message: "Something happened",
    resource: null,
    operation: null,
    timestamp: Date.now(),
    details: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifications store", () => {
  it("starts with empty entries", () => {
    const store = createNotificationsStore();
    expect(store.getState().entries).toHaveLength(0);
  });

  it("add() prepends new notification to entries", () => {
    const store = createNotificationsStore();
    const n1 = makeNotification({ id: "n-1", title: "First" });
    const n2 = makeNotification({ id: "n-2", title: "Second" });

    store.getState().add(n1);
    store.getState().add(n2);

    const { entries } = store.getState();
    expect(entries).toHaveLength(2);
    // newest first
    expect(entries[0]?.id).toBe("n-2");
    expect(entries[1]?.id).toBe("n-1");
  });

  it("dismiss() removes the notification with the given id", () => {
    const store = createNotificationsStore();
    const n1 = makeNotification({ id: "n-1" });
    const n2 = makeNotification({ id: "n-2" });

    store.getState().add(n1);
    store.getState().add(n2);
    store.getState().dismiss("n-1");

    const { entries } = store.getState();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe("n-2");
  });

  it("dismiss() is a no-op for unknown id", () => {
    const store = createNotificationsStore();
    store.getState().add(makeNotification({ id: "n-1" }));
    store.getState().dismiss("unknown-id");

    expect(store.getState().entries).toHaveLength(1);
  });

  it("clearAll() empties entries", () => {
    const store = createNotificationsStore();
    store.getState().add(makeNotification({ id: "n-1" }));
    store.getState().add(makeNotification({ id: "n-2" }));
    store.getState().clearAll();

    expect(store.getState().entries).toHaveLength(0);
  });

  describe("selectors", () => {
    it("unreadCount() returns total entry count", () => {
      const store = createNotificationsStore();
      expect(store.getState().unreadCount()).toBe(0);

      store.getState().add(makeNotification({ id: "n-1" }));
      store.getState().add(makeNotification({ id: "n-2" }));
      expect(store.getState().unreadCount()).toBe(2);
    });

    it("bySeverity() returns only matching entries", () => {
      const store = createNotificationsStore();
      store.getState().add(makeNotification({ id: "n-1", severity: "info" }));
      store.getState().add(makeNotification({ id: "n-2", severity: "error" }));
      store
        .getState()
        .add(makeNotification({ id: "n-3", severity: "warning" }));
      store.getState().add(makeNotification({ id: "n-4", severity: "error" }));

      const errors = store.getState().bySeverity("error");
      expect(errors).toHaveLength(2);
      expect(errors.every((e) => e.severity === "error")).toBe(true);

      const infos = store.getState().bySeverity("info");
      expect(infos).toHaveLength(1);
      expect(infos[0]?.id).toBe("n-1");

      const successes = store.getState().bySeverity("success");
      expect(successes).toHaveLength(0);
    });
  });
});
