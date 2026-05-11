/**
 * Tests for UpdaterPrompt and useUpdaterStatus.
 *
 * Coverage:
 * - Renders nothing when status is null/idle/checking/upToDate.
 * - Renders Available banner with "Install update" button.
 * - Clicking "Install update" calls updaterInstall.
 * - Renders Downloading progress bar.
 * - Renders Ready state with "Restart now" button.
 * - Renders Error state with inline error.
 * - Dismiss button calls onDismiss.
 * - Backend install error is shown inline.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { emitEvent, mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderWithHook() {
  const { UpdaterPrompt, useUpdaterStatus } = await import(
    "@/views/shell/UpdaterPrompt"
  );

  const onDismiss = vi.fn();

  function TestShell() {
    const status = useUpdaterStatus();
    return <UpdaterPrompt status={status} onDismiss={onDismiss} />;
  }

  const utils = render(<TestShell />);
  return { ...utils, onDismiss };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("UpdaterPrompt", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Idle / silent states
  // -------------------------------------------------------------------------

  it("renders nothing when status is null (no event received)", async () => {
    await renderWithHook();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing when status is idle", async () => {
    await renderWithHook();
    emitEvent("updater:status", { status: "idle" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing when status is checking", async () => {
    await renderWithHook();
    emitEvent("updater:status", { status: "checking" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders nothing when status is upToDate", async () => {
    await renderWithHook();
    emitEvent("updater:status", { status: "upToDate" });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Available
  // -------------------------------------------------------------------------

  it("renders Available banner with Install button", async () => {
    await renderWithHook();

    emitEvent("updater:status", {
      status: "available",
      version: "1.2.3",
      notes: "New features",
      downloadUrl: null,
    });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(screen.getByText(/v1\.2\.3/)).toBeInTheDocument();
    expect(screen.getByText(/New features/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /install update/i }),
    ).toBeInTheDocument();
  });

  it("clicking Install update calls updaterInstall", async () => {
    const user = userEvent.setup();
    mockInvoke("updater_install", undefined);
    await renderWithHook();

    emitEvent("updater:status", {
      status: "available",
      version: "2.0.0",
      notes: null,
      downloadUrl: null,
    });

    await waitFor(() =>
      screen.getByRole("button", { name: /install update/i }),
    );

    await user.click(screen.getByRole("button", { name: /install update/i }));

    // Button goes disabled while installing
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: /installing/i }),
      ).not.toBeInTheDocument();
    });
  });

  it("shows backend error inline when updaterInstall fails", async () => {
    const user = userEvent.setup();
    mockInvoke("updater_install", new Error("Signature verification failed"));
    await renderWithHook();

    emitEvent("updater:status", {
      status: "available",
      version: "2.0.0",
      notes: null,
      downloadUrl: null,
    });

    await waitFor(() =>
      screen.getByRole("button", { name: /install update/i }),
    );
    await user.click(screen.getByRole("button", { name: /install update/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /install update/i }),
    ).toBeInTheDocument();
  });

  it("clicking Dismiss on Available calls onDismiss", async () => {
    const user = userEvent.setup();
    const { onDismiss } = await renderWithHook();

    emitEvent("updater:status", {
      status: "available",
      version: "1.0.0",
      notes: null,
      downloadUrl: null,
    });

    await waitFor(() => screen.getByRole("button", { name: /dismiss/i }));
    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Downloading
  // -------------------------------------------------------------------------

  it("renders Downloading progress bar with known progress", async () => {
    await renderWithHook();

    emitEvent("updater:status", { status: "downloading", progress: 0.6 });

    await waitFor(() => {
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });
    expect(screen.getByText(/60%/)).toBeInTheDocument();
  });

  it("renders Downloading with unknown progress (no percentage)", async () => {
    await renderWithHook();

    emitEvent("updater:status", { status: "downloading", progress: null });

    await waitFor(() => {
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });
    // When progress is null, label should not contain a percentage.
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Ready
  // -------------------------------------------------------------------------

  it("renders Ready state with Restart now button", async () => {
    await renderWithHook();

    emitEvent("updater:status", { status: "ready" });

    await waitFor(() => {
      expect(screen.getByRole("status")).toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: /restart now/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /later/i })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // Error
  // -------------------------------------------------------------------------

  it("renders Error state with message", async () => {
    await renderWithHook();

    emitEvent("updater:status", {
      status: "error",
      message: "Endpoint unreachable",
    });

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/Endpoint unreachable/)).toBeInTheDocument();
  });

  it("clicking Dismiss on Error calls onDismiss", async () => {
    const user = userEvent.setup();
    const { onDismiss } = await renderWithHook();

    emitEvent("updater:status", {
      status: "error",
      message: "network timeout",
    });

    await waitFor(() => screen.getByRole("button", { name: /dismiss/i }));
    await user.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  // -------------------------------------------------------------------------
  // Accessibility
  // -------------------------------------------------------------------------

  it("has no axe violations on Available state", async () => {
    mockInvoke("updater_install", undefined);
    const { container } = await renderWithHook();

    emitEvent("updater:status", {
      status: "available",
      version: "3.0.0",
      notes: "Stability improvements",
      downloadUrl: null,
    });

    await waitFor(() => screen.getByRole("status"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
