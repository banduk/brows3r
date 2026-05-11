/**
 * Tests for <InlineErrorSlot />.
 */

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { AppError } from "@/lib/errors";
import { InlineErrorSlot } from "../InlineErrorSlot";

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const networkError: AppError = {
  kind: "Network",
  message: "Connection timed out",
  retryable: true,
  details: { source: "timeout" },
};

const authError: AppError = {
  kind: "Auth",
  message: "Credentials have expired",
  retryable: false,
  details: { reason: "expired" },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InlineErrorSlot", () => {
  it("renders the error message", () => {
    render(<InlineErrorSlot error={networkError} />);
    expect(screen.getByText("Connection timed out")).toBeInTheDocument();
  });

  it("shows Retry button when error is retryable AND onRetry is provided", async () => {
    const onRetry = vi.fn();
    render(<InlineErrorSlot error={networkError} onRetry={onRetry} />);

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();
  });

  it("calls onRetry when Retry button is clicked", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<InlineErrorSlot error={networkError} onRetry={onRetry} />);

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("does not show Retry button when error is not retryable", () => {
    render(<InlineErrorSlot error={authError} onRetry={vi.fn()} />);
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("does not show Retry button when retryable but no onRetry provided", () => {
    render(<InlineErrorSlot error={networkError} />);
    expect(
      screen.queryByRole("button", { name: /retry/i }),
    ).not.toBeInTheDocument();
  });

  it("has role=alert for immediate announcement", () => {
    render(<InlineErrorSlot error={authError} />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("has no a11y violations (axe)", async () => {
    const { container } = render(
      <InlineErrorSlot error={networkError} onRetry={vi.fn()} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
