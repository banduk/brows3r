/**
 * Tests for <BulkDownloadConfirm />.
 *
 * Coverage:
 * 1. Renders the destination path.
 * 2. Updates totals as the enumerator yields progressive estimates.
 * 3. Shows the risk callout once thresholds are exceeded.
 * 4. Confirm / Cancel invoke the respective callbacks.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkDownloadConfirm, type Estimate } from "../BulkDownloadConfirm";

afterEach(() => {
  cleanup();
});

function makeEnumerator(yields: Estimate[]) {
  return async function* enumerate() {
    for (const e of yields) {
      // Tick the microtask queue so React state can flush between yields.
      await Promise.resolve();
      yield e;
    }
  };
}

describe("BulkDownloadConfirm", () => {
  it("shows the destination path", async () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/Users/me/Downloads/photos"
        enumerate={makeEnumerator([{ files: 5, bytes: 100, done: true }])}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByText("/Users/me/Downloads/photos"),
      ).toBeInTheDocument();
    });
  });

  it("reflects progressive estimates from the enumerator", async () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        enumerate={makeEnumerator([
          { files: 10, bytes: 1024, done: false },
          { files: 50, bytes: 50 * 1024, done: false },
          { files: 234, bytes: 2 * 1024 * 1024, done: true },
        ])}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      const summary = screen.getByTestId("bulk-download-summary");
      expect(summary.textContent).toContain("234");
    });
  });

  it("renders the risk callout when totals exceed the threshold", async () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        // 2 GiB → above the 1 GiB threshold.
        enumerate={makeEnumerator([
          { files: 5, bytes: 2 * 1024 * 1024 * 1024, done: true },
        ])}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("bulk-download-risk")).toBeInTheDocument();
    });
  });

  it("does not render the risk callout for small downloads", async () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        enumerate={makeEnumerator([{ files: 3, bytes: 1024, done: true }])}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("bulk-download-summary")).toBeInTheDocument();
    });
    expect(screen.queryByTestId("bulk-download-risk")).not.toBeInTheDocument();
  });

  it("invokes onConfirm when the user clicks Start download", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        enumerate={makeEnumerator([{ files: 5, bytes: 1024, done: true }])}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("bulk-download-summary")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("bulk-download-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel when the user dismisses", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        enumerate={makeEnumerator([{ files: 5, bytes: 1024, done: true }])}
        onConfirm={() => {}}
        onCancel={onCancel}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("bulk-download-summary")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");
    expect(onCancel).toHaveBeenCalled();
  });
});
