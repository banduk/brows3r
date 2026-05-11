/**
 * Tests for <Toaster />.
 *
 * The auto-dismiss test uses vitest fake timers.
 * Other tests use real timers so async imports don't stall.
 */

import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";

const { Toaster } = await import("../Toaster");
const { dispatch } = await import("@/lib/errors");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNotificationPayload(
  overrides: Partial<import("@/store/notifications").Notification> = {},
): import("@/store/notifications").Notification {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    severity: "info",
    category: "background",
    title: "Test toast",
    message: "Toast message",
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

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Toaster", () => {
  it("shows a toast when dispatch emits to the toast bus (error)", async () => {
    render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          severity: "error",
          title: "Upload failed",
          message: "Network error",
        }),
        "panel+toast",
      );
    });

    expect(screen.getByText("Upload failed")).toBeInTheDocument();
    expect(screen.getByText("Network error")).toBeInTheDocument();
  });

  it("shows toast for warning severity", async () => {
    render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          severity: "warning",
          title: "Rate limited",
          message: "Slow down",
        }),
        "panel+toast",
      );
    });

    expect(screen.getByText("Rate limited")).toBeInTheDocument();
  });

  it("shows toast for success severity", async () => {
    render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          severity: "success",
          title: "Upload complete",
          message: "File saved",
        }),
        "panel+toast",
      );
    });

    expect(screen.getByText("Upload complete")).toBeInTheDocument();
  });

  it("does not show toast when placement is panel-only", async () => {
    render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          title: "Panel only",
          message: "Not in toast",
        }),
        "panel",
      );
    });

    expect(screen.queryByText("Panel only")).not.toBeInTheDocument();
  });

  it("dismiss button removes the toast immediately", async () => {
    const user = userEvent.setup();
    render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          title: "Dismiss me",
          message: "Click ×",
          severity: "error",
        }),
        "panel+toast",
      );
    });

    const dismissBtn = screen.getByRole("button", {
      name: /dismiss: dismiss me/i,
    });
    await user.click(dismissBtn);

    expect(screen.queryByText("Dismiss me")).not.toBeInTheDocument();
  });

  it("auto-dismisses toast after 5 seconds", async () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);

      // dispatch uses async import — run with real async while fake timers are on
      await act(async () => {
        await dispatch(
          makeNotificationPayload({
            title: "Auto-dismiss me",
            message: "Will be gone in 5s",
          }),
          "panel+toast",
        );
      });

      expect(screen.getByText("Auto-dismiss me")).toBeInTheDocument();

      // Advance fake timers by 5001ms.
      act(() => {
        vi.advanceTimersByTime(5001);
      });

      expect(screen.queryByText("Auto-dismiss me")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("has no a11y violations with active toast (axe)", async () => {
    const { container } = render(<Toaster />);

    await act(async () => {
      await dispatch(
        makeNotificationPayload({
          severity: "warning",
          title: "A11y test",
          message: "Testing axe",
        }),
        "panel+toast",
      );
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
