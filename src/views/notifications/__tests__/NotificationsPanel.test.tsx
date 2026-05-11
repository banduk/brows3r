/**
 * Tests for <NotificationsPanel />.
 *
 * Uses an isolated store instance injected via vi.mock to avoid
 * side-effects on the app-level singleton.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

// ---------------------------------------------------------------------------
// Isolated store
// ---------------------------------------------------------------------------

let _testStore: ReturnType<
  typeof import("@/store/notifications").createNotificationsStore
> | null = null;

vi.mock("@/store/notifications", async () => {
  const mod = await vi.importActual<typeof import("@/store/notifications")>(
    "@/store/notifications",
  );
  const store = mod.createNotificationsStore();
  _testStore = store;
  return {
    ...mod,
    useNotificationsStore: store,
  };
});

const { useNotificationsStore } = await import("@/store/notifications");
const { NotificationsPanel } = await import("../NotificationsPanel");

function getStore() {
  if (_testStore === null) throw new Error("test store not initialized");
  return _testStore;
}

function makeNotification(
  overrides: Partial<import("@/store/notifications").Notification> = {},
): import("@/store/notifications").Notification {
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
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  getStore().getState().clearAll();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NotificationsPanel", () => {
  it("renders empty state when no notifications", () => {
    render(<NotificationsPanel />);
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("renders notifications list when entries exist", () => {
    useNotificationsStore.getState().add(
      makeNotification({
        id: "n-1",
        title: "First error",
        severity: "error",
      }),
    );
    useNotificationsStore
      .getState()
      .add(
        makeNotification({ id: "n-2", title: "Info event", severity: "info" }),
      );

    render(<NotificationsPanel />);

    expect(screen.getByText("First error")).toBeInTheDocument();
    expect(screen.getByText("Info event")).toBeInTheDocument();
  });

  it("dismiss button removes the notification", async () => {
    const user = userEvent.setup();
    useNotificationsStore
      .getState()
      .add(makeNotification({ id: "n-1", title: "To dismiss" }));

    render(<NotificationsPanel />);

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss notification: to dismiss/i,
    });
    await user.click(dismissBtn);

    expect(screen.queryByText("To dismiss")).not.toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("Clear all button removes all notifications", async () => {
    const user = userEvent.setup();
    useNotificationsStore
      .getState()
      .add(makeNotification({ id: "n-1", title: "First" }));
    useNotificationsStore
      .getState()
      .add(makeNotification({ id: "n-2", title: "Second" }));

    render(<NotificationsPanel />);

    const clearAllBtn = screen.getByRole("button", {
      name: /clear all notifications/i,
    });
    await user.click(clearAllBtn);

    expect(screen.queryByText("First")).not.toBeInTheDocument();
    expect(screen.queryByText("Second")).not.toBeInTheDocument();
    expect(screen.getByText("No notifications yet")).toBeInTheDocument();
  });

  it("shows count in header when notifications exist", () => {
    useNotificationsStore.getState().add(makeNotification({ id: "n-1" }));
    useNotificationsStore.getState().add(makeNotification({ id: "n-2" }));

    render(<NotificationsPanel />);

    expect(screen.getByText("(2)")).toBeInTheDocument();
  });

  it("does not show Clear all button when empty", () => {
    render(<NotificationsPanel />);
    expect(
      screen.queryByRole("button", { name: /clear all/i }),
    ).not.toBeInTheDocument();
  });

  it("shows category badge for background notifications", () => {
    useNotificationsStore
      .getState()
      .add(makeNotification({ id: "n-1", category: "background" }));

    render(<NotificationsPanel />);
    expect(screen.getByText("BG")).toBeInTheDocument();
  });

  it("shows category badge for userInitiated notifications", () => {
    useNotificationsStore
      .getState()
      .add(makeNotification({ id: "n-1", category: "userInitiated" }));

    render(<NotificationsPanel />);
    expect(screen.getByText("User")).toBeInTheDocument();
  });

  it("has no a11y violations (axe)", async () => {
    useNotificationsStore
      .getState()
      .add(
        makeNotification({ id: "n-1", title: "Axe test", severity: "warning" }),
      );

    const { container } = render(<NotificationsPanel />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no a11y violations in empty state (axe)", async () => {
    const { container } = render(<NotificationsPanel />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
