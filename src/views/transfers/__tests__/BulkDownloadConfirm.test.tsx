/**
 * Tests for <BulkDownloadConfirm />.
 *
 * Coverage:
 * 1. Renders the destination path.
 * 2. Shows "Counting…" while estimate is null and unlocks once final.
 * 3. Shows the risk callout once thresholds are exceeded.
 * 4. Confirm / Cancel invoke the respective callbacks.
 * 5. Inline error message disables confirm.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BulkDownloadConfirm } from "../BulkDownloadConfirm";

afterEach(() => {
  cleanup();
});

describe("BulkDownloadConfirm", () => {
  it("shows the destination path", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/Users/me/Downloads/photos"
        estimate={{ files: 5, bytes: 100 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByText("/Users/me/Downloads/photos")).toBeInTheDocument();
  });

  it("disables confirm while estimate is null (counting)", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={null}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId("bulk-download-confirm")).toBeDisabled();
  });

  it("enables confirm once a non-zero estimate arrives", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 234, bytes: 2 * 1024 * 1024 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId("bulk-download-confirm")).toBeEnabled();
  });

  it("renders the risk callout when totals exceed the threshold", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 5, bytes: 2 * 1024 * 1024 * 1024 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId("bulk-download-risk")).toBeInTheDocument();
  });

  it("does not render the risk callout for small downloads", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 3, bytes: 1024 }}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByTestId("bulk-download-risk")).not.toBeInTheDocument();
  });

  it("disables confirm when an enumeration error is set", () => {
    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 5, bytes: 1024 }}
        error="Access denied"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(screen.getByTestId("bulk-download-error")).toHaveTextContent(
      "Access denied",
    );
    expect(screen.getByTestId("bulk-download-confirm")).toBeDisabled();
  });

  it("invokes onConfirm when the user clicks Start download", async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();

    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 5, bytes: 1024 }}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    await user.click(screen.getByTestId("bulk-download-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("invokes onCancel when the user presses Escape", async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();

    render(
      <BulkDownloadConfirm
        open
        destination="/tmp/d"
        estimate={{ files: 5, bytes: 1024 }}
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
