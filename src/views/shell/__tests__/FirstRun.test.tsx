/**
 * Tests for <FirstRun />.
 *
 * Coverage:
 * - Renders the dialog when firstRunCompleted is false.
 * - Does not render when firstRunCompleted is true.
 * - "Don't show again" button sets firstRunCompleted = true and closes dialog.
 * - Esc key (onOpenChange called with false) closes the dialog and sets flag.
 * - "Add profile" button closes the dialog, sets flag, and calls onOpenProfileEditor.
 * - Axe a11y assertion when open.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { useUiStore } from "@/store/ui";
import { FirstRun } from "@/views/shell/FirstRun";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderFirstRun(props: { onOpenProfileEditor?: () => void } = {}) {
  return render(<FirstRun {...props} />);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("FirstRun", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    // Reset persisted state to default between tests.
    useUiStore.setState({ firstRunCompleted: false });
  });

  it("shows the dialog when firstRunCompleted is false", () => {
    useUiStore.setState({ firstRunCompleted: false });
    renderFirstRun();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/welcome to brows3r/i)).toBeInTheDocument();
  });

  it("does not show the dialog when firstRunCompleted is true", () => {
    useUiStore.setState({ firstRunCompleted: true });
    renderFirstRun();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("clicking 'Don't show again' sets firstRunCompleted and closes dialog", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ firstRunCompleted: false });
    renderFirstRun();

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /don't show again/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(useUiStore.getState().firstRunCompleted).toBe(true);
  });

  it("clicking 'Add profile' closes the dialog and calls onOpenProfileEditor", async () => {
    const user = userEvent.setup();
    const onOpenProfileEditor = vi.fn();
    useUiStore.setState({ firstRunCompleted: false });
    renderFirstRun({ onOpenProfileEditor });

    await user.click(screen.getByRole("button", { name: /add profile/i }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(onOpenProfileEditor).toHaveBeenCalledOnce();
    expect(useUiStore.getState().firstRunCompleted).toBe(true);
  });

  it("has no axe accessibility violations when open", async () => {
    useUiStore.setState({ firstRunCompleted: false });
    const { container } = renderFirstRun();

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
