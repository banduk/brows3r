/**
 * Tests for <TransferManager />.
 *
 * Coverage:
 * 1. Renders active + completed sections.
 * 2. Cancel / retry buttons are present on active / terminal rows.
 * 3. Minimize / expand toggles state (panel pill shown when minimized).
 * 4. "Clear completed" removes terminal transfers.
 * 5. Empty state when no transfers.
 * 6. axe-core a11y assertion.
 * 7. ARIA live region announces terminal state changes (done/failed/canceled).
 *    In-progress percent updates do NOT produce an announcement.
 */

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type { Transfer } from "@/api/transfers";
import { useTransfersStore } from "@/store/transfers";
import { mockInvoke } from "@/test/mocks/tauri";
import { TransferManager } from "../TransferManager";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t-1",
    kind: "download",
    profileId: "p-1",
    bucket: "my-bucket",
    key: "file.txt",
    transferredBytes: 500,
    totalBytes: 1000,
    partsDone: 0,
    partsTotal: 1,
    state: "running",
    startedAt: Date.now() - 5_000,
    ...overrides,
  };
}

beforeEach(() => {
  // Open the panel, not minimized, with a clean slate.
  useTransfersStore.setState({
    transfers: new Map(),
    panelOpen: true,
    panelMinimized: false,
  });

  mockInvoke("transfer_cancel", undefined);
  mockInvoke("transfer_retry", "new-id");
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------

describe("TransferManager — empty state", () => {
  it("shows 'No transfers' when transfer list is empty", () => {
    render(<TransferManager />);
    expect(screen.getByText("No transfers")).toBeInTheDocument();
  });

  it("renders nothing when panelOpen is false", () => {
    useTransfersStore.setState({ panelOpen: false });
    const { container } = render(<TransferManager />);
    expect(container.firstChild).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Active section
// ---------------------------------------------------------------------------

describe("TransferManager — active section", () => {
  it("renders active transfers", () => {
    useTransfersStore.setState({
      transfers: new Map([
        [
          "t-1",
          makeTransfer({ id: "t-1", key: "active.txt", state: "running" }),
        ],
      ]),
    });
    render(<TransferManager />);
    expect(screen.getByTitle("active.txt")).toBeInTheDocument();
  });

  it("shows cancel button for active transfers", () => {
    useTransfersStore.setState({
      transfers: new Map([["t-1", makeTransfer({ state: "running" })]]),
    });
    render(<TransferManager />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Completed section
// ---------------------------------------------------------------------------

describe("TransferManager — completed section", () => {
  it("shows completed count but hides rows by default (collapsed)", () => {
    useTransfersStore.setState({
      transfers: new Map([
        [
          "t-done",
          makeTransfer({ id: "t-done", key: "done.txt", state: "done" }),
        ],
      ]),
    });
    render(<TransferManager />);
    // The toggle button contains "Completed (1)" — match the expanded label.
    expect(
      screen.getByRole("button", { name: /^Completed \(/ }),
    ).toBeInTheDocument();
    // The completed row itself is hidden by default.
    expect(screen.queryByTitle("done.txt")).toBeNull();
  });

  it("shows completed rows when section is expanded", async () => {
    useTransfersStore.setState({
      transfers: new Map([
        [
          "t-fail",
          makeTransfer({ id: "t-fail", key: "fail.txt", state: "failed" }),
        ],
      ]),
    });
    render(<TransferManager />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Completed \(/ }),
    );
    expect(screen.getByTitle("fail.txt")).toBeInTheDocument();
  });

  it("shows retry button on failed transfers in expanded completed section", async () => {
    useTransfersStore.setState({
      transfers: new Map([
        ["t-fail", makeTransfer({ id: "t-fail", state: "failed" })],
      ]),
    });
    render(<TransferManager />);

    await userEvent.click(
      screen.getByRole("button", { name: /^Completed \(/ }),
    );
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Clear completed
// ---------------------------------------------------------------------------

describe("TransferManager — clear completed", () => {
  it("removes completed transfers from the store", async () => {
    useTransfersStore.setState({
      transfers: new Map([
        ["t-run", makeTransfer({ id: "t-run", state: "running" })],
        ["t-done", makeTransfer({ id: "t-done", state: "done" })],
      ]),
    });
    render(<TransferManager />);

    await userEvent.click(
      screen.getByRole("button", { name: /clear completed/i }),
    );

    expect(useTransfersStore.getState().transfers.has("t-run")).toBe(true);
    expect(useTransfersStore.getState().transfers.has("t-done")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Minimize / expand
// ---------------------------------------------------------------------------

describe("TransferManager — minimize / expand", () => {
  it("shows the pill when panel is minimized", () => {
    useTransfersStore.setState({
      transfers: new Map([["t-1", makeTransfer()]]),
      panelOpen: true,
      panelMinimized: true,
    });
    render(<TransferManager />);
    expect(
      screen.getByRole("button", { name: /expand transfer manager/i }),
    ).toBeInTheDocument();
  });

  it("clicking minimize button sets panelMinimized to true", async () => {
    useTransfersStore.setState({
      transfers: new Map([["t-1", makeTransfer()]]),
      panelOpen: true,
      panelMinimized: false,
    });
    render(<TransferManager />);

    await userEvent.click(
      screen.getByRole("button", { name: /minimize transfer manager/i }),
    );

    expect(useTransfersStore.getState().panelMinimized).toBe(true);
  });

  it("clicking the pill expands the panel", async () => {
    useTransfersStore.setState({
      transfers: new Map([["t-1", makeTransfer()]]),
      panelOpen: true,
      panelMinimized: true,
    });
    render(<TransferManager />);

    await userEvent.click(
      screen.getByRole("button", { name: /expand transfer manager/i }),
    );

    expect(useTransfersStore.getState().panelMinimized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ARIA live region — terminal state announcements
// ---------------------------------------------------------------------------

describe("TransferManager — ARIA live region announcements", () => {
  it("renders the aria-live region when panel is open", () => {
    render(<TransferManager />);
    const region = screen.getByTestId("transfer-announcement");
    expect(region).toBeInTheDocument();
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("announces 'Download completed' when a download transitions to done", async () => {
    const running = makeTransfer({
      id: "t-dl",
      key: "docs/report.pdf",
      kind: "download",
      state: "running",
    });
    useTransfersStore.setState({
      transfers: new Map([["t-dl", running]]),
    });
    render(<TransferManager />);

    // Transition to done.
    act(() => {
      useTransfersStore.setState({
        transfers: new Map([["t-dl", { ...running, state: "done" }]]),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("transfer-announcement")).toHaveTextContent(
        "Download completed: report.pdf",
      );
    });
  });

  it("announces 'Upload completed' when an upload transitions to done", async () => {
    const running = makeTransfer({
      id: "t-ul",
      key: "photos/sunset.jpg",
      kind: "upload",
      state: "running",
    });
    useTransfersStore.setState({
      transfers: new Map([["t-ul", running]]),
    });
    render(<TransferManager />);

    act(() => {
      useTransfersStore.setState({
        transfers: new Map([["t-ul", { ...running, state: "done" }]]),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("transfer-announcement")).toHaveTextContent(
        "Upload completed: sunset.jpg",
      );
    });
  });

  it("announces 'Download failed' when a download transitions to failed", async () => {
    const running = makeTransfer({
      id: "t-fail",
      key: "data/large.csv",
      kind: "download",
      state: "running",
    });
    useTransfersStore.setState({
      transfers: new Map([["t-fail", running]]),
    });
    render(<TransferManager />);

    act(() => {
      useTransfersStore.setState({
        transfers: new Map([["t-fail", { ...running, state: "failed" }]]),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("transfer-announcement")).toHaveTextContent(
        "Download failed: large.csv",
      );
    });
  });

  it("announces 'Transfer canceled' when a transfer is canceled", async () => {
    const running = makeTransfer({
      id: "t-cancel",
      key: "archive/backup.tar.gz",
      state: "running",
    });
    useTransfersStore.setState({
      transfers: new Map([["t-cancel", running]]),
    });
    render(<TransferManager />);

    act(() => {
      useTransfersStore.setState({
        transfers: new Map([["t-cancel", { ...running, state: "canceled" }]]),
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("transfer-announcement")).toHaveTextContent(
        "Transfer canceled: backup.tar.gz",
      );
    });
  });

  it("does NOT announce for in-progress byte updates (suppress flood)", async () => {
    const running = makeTransfer({
      id: "t-progress",
      key: "video.mp4",
      state: "running",
      transferredBytes: 500,
    });
    useTransfersStore.setState({
      transfers: new Map([["t-progress", running]]),
    });
    render(<TransferManager />);

    // Simulate a percent update — state stays "running".
    act(() => {
      useTransfersStore.setState({
        transfers: new Map([
          ["t-progress", { ...running, transferredBytes: 750 }],
        ]),
      });
    });

    // The live region should remain empty (no terminal transition occurred).
    const region = screen.getByTestId("transfer-announcement");
    expect(region).toHaveTextContent("");
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("TransferManager — a11y", () => {
  it("has no axe violations in the empty state", async () => {
    const { container } = render(<TransferManager />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations with active transfers", async () => {
    useTransfersStore.setState({
      transfers: new Map([["t-1", makeTransfer({ state: "running" })]]),
    });
    const { container } = render(<TransferManager />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
