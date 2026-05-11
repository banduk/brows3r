/**
 * Tests for <TransferRow />.
 *
 * Coverage:
 * 1. Progress bar reflects percent complete.
 * 2. Cancel button present for active transfers; calls transferCancel.
 * 3. Retry button present for failed/canceled transfers; calls transferRetry.
 * 4. Retry button absent for running/queued transfers.
 * 5. Format helpers: formatRate, formatEta.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Transfer } from "@/api/transfers";
import { mockInvoke } from "@/test/mocks/tauri";
import { formatEta, formatRate, TransferRow } from "../TransferRow";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTransfer(overrides: Partial<Transfer> = {}): Transfer {
  return {
    id: "t-1",
    kind: "download",
    profileId: "p-1",
    bucket: "my-bucket",
    key: "path/to/file.txt",
    transferredBytes: 500,
    totalBytes: 1000,
    partsDone: 0,
    partsTotal: 1,
    state: "running",
    startedAt: Date.now() - 10_000,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

describe("TransferRow — progress bar", () => {
  it("reflects percent complete via aria-valuenow", () => {
    render(<TransferRow transfer={makeTransfer()} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "50");
  });

  it("shows 0% when no bytes transferred", () => {
    render(<TransferRow transfer={makeTransfer({ transferredBytes: 0 })} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "0");
  });

  it("caps at 100%", () => {
    render(
      <TransferRow
        transfer={makeTransfer({ transferredBytes: 2000, totalBytes: 1000 })}
      />,
    );
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "100");
  });
});

// ---------------------------------------------------------------------------
// Cancel button
// ---------------------------------------------------------------------------

describe("TransferRow — cancel", () => {
  beforeEach(() => {
    mockInvoke("transfer_cancel", undefined);
  });

  it("renders Cancel for running transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "running" })} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("renders Cancel for queued transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "queued" })} />);
    expect(screen.getByRole("button", { name: /cancel/i })).toBeInTheDocument();
  });

  it("calls transferCancel with the transfer id", async () => {
    const onCanceled = vi.fn();
    render(
      <TransferRow
        transfer={makeTransfer({ id: "t-abc", state: "running" })}
        onCanceled={onCanceled}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCanceled).toHaveBeenCalledWith("t-abc");
  });

  it("does not render Cancel for done transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "done" })} />);
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Retry button
// ---------------------------------------------------------------------------

describe("TransferRow — retry", () => {
  beforeEach(() => {
    mockInvoke("transfer_retry", "new-req-id");
  });

  it("renders Retry for failed transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "failed" })} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders Retry for canceled transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "canceled" })} />);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("calls transferRetry and fires onRetried", async () => {
    const onRetried = vi.fn();
    render(
      <TransferRow
        transfer={makeTransfer({ id: "t-fail", state: "failed" })}
        onRetried={onRetried}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetried).toHaveBeenCalledWith("t-fail", "new-req-id");
  });

  it("does not render Retry for running transfers", () => {
    render(<TransferRow transfer={makeTransfer({ state: "running" })} />);
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

describe("formatRate", () => {
  it("returns — for zero rate", () => {
    expect(formatRate(0)).toBe("—");
  });

  it("formats bytes per second", () => {
    expect(formatRate(500)).toBe("500 B/s");
  });

  it("formats KB/s", () => {
    expect(formatRate(2048)).toBe("2.0 KB/s");
  });

  it("formats MB/s", () => {
    expect(formatRate(2 * 1024 * 1024)).toBe("2.0 MB/s");
  });
});

describe("formatEta", () => {
  it("returns — for null", () => {
    expect(formatEta(null)).toBe("—");
  });

  it("returns Done for 0 seconds", () => {
    expect(formatEta(0)).toBe("Done");
  });

  it("formats seconds only", () => {
    expect(formatEta(45)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatEta(90)).toBe("1m 30s");
  });
});
