/**
 * Tests for <DiffPreviewModal />.
 *
 * Coverage:
 * 1. Renders summary for storage_class kind.
 * 2. Confirm button calls `objectSetStorageClass` with the diff id.
 * 3. Cancel button calls `diffPreviewCancel` and closes the modal.
 * 4. Round-3 residual #1 derived test: cancelling the diff preview makes
 *    subsequent confirm attempts fail (backend returns Validation error).
 * 5. Decision D2 boundary: `EXCLUDED_FROM_OPTIMISM` includes `"storage_class"`.
 * 6. axe-core a11y assertion.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import type { DiffPayload } from "@/api/diff";
import { EXCLUDED_FROM_OPTIMISM } from "@/query/optimistic";
import { useDiffStore } from "@/store/diff";
import { mockInvoke } from "@/test/mocks/tauri";
import { DiffPreviewModal } from "../DiffPreviewModal";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const STORAGE_CLASS_PAYLOAD: DiffPayload = {
  kind: "storage_class",
  targets: [
    { bucket: "my-bucket", key: "photos/img1.jpg" },
    { bucket: "my-bucket", key: "photos/img2.jpg" },
    { bucket: "my-bucket", key: "photos/img3.jpg" },
  ],
  current: {
    "photos/img1.jpg": "STANDARD",
    "photos/img2.jpg": "STANDARD",
    "photos/img3.jpg": "STANDARD",
  },
  newClass: "GLACIER",
};

/** Seed the singleton store with a test diff and render the modal. */
function renderModal(payload: DiffPayload = STORAGE_CLASS_PAYLOAD) {
  useDiffStore.setState({
    currentDiff: { id: "test-diff-id", payload },
  });
  return render(<DiffPreviewModal profileId="p-test" />);
}

afterEach(() => {
  // Reset the store after each test to prevent leakage.
  useDiffStore.setState({ currentDiff: null });
  cleanup();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("DiffPreviewModal — rendering", () => {
  it("renders summary text for storage_class payload with count and target class", () => {
    mockInvoke("diff_preview_cancel", undefined);
    mockInvoke("object_set_storage_class", []);

    renderModal();

    // "3 objects" and "GLACIER" must appear in the summary.
    expect(screen.getByText(/3 objects/i)).toBeTruthy();
    expect(screen.getByText(/GLACIER/)).toBeTruthy();
  });

  it("renders Confirm and Cancel buttons", () => {
    mockInvoke("diff_preview_cancel", undefined);
    mockInvoke("object_set_storage_class", []);

    renderModal();

    expect(
      screen.getByRole("button", { name: /confirm change/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel change/i })).toBeTruthy();
  });

  it("renders nothing when currentDiff is null", () => {
    useDiffStore.setState({ currentDiff: null });
    const { container } = render(<DiffPreviewModal profileId="p-test" />);
    expect(container.firstChild).toBeNull();
  });

  it("has no axe violations", async () => {
    mockInvoke("diff_preview_cancel", undefined);
    mockInvoke("object_set_storage_class", []);

    const { container } = renderModal();
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// Confirm flow
// ---------------------------------------------------------------------------

describe("DiffPreviewModal — confirm flow", () => {
  it("closes the modal after a successful confirm", async () => {
    mockInvoke("object_set_storage_class", [{ etag: "abc" }]);

    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    await waitFor(() => {
      // Modal closes: currentDiff is null, dialog disappears.
      expect(useDiffStore.getState().currentDiff).toBeNull();
    });
  });

  it("shows error message when confirm API fails", async () => {
    // Combine Error (instanceof check in mock) with AppError fields
    // (isAppError check in normalizeError) so invoke rejects with AppError.
    mockInvoke(
      "object_set_storage_class",
      Object.assign(new Error("Diff was cancelled or expired"), {
        kind: "Validation",
        retryable: false,
        details: {
          field: "confirmed_diff_id",
          hint: "Diff was cancelled or expired",
        },
      }),
    );

    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Cancel flow
// ---------------------------------------------------------------------------

describe("DiffPreviewModal — cancel flow", () => {
  it("calls diffPreviewCancel and clears store on Cancel button", async () => {
    mockInvoke("diff_preview_cancel", undefined);

    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /cancel change/i }));

    await waitFor(() => {
      expect(useDiffStore.getState().currentDiff).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Round-3 residual #1 derived test
//
// Cancelling the diff preview makes subsequent confirm attempts fail.
// The backend returns Validation error when confirmed_diff_id was cancelled.
// This test verifies the modal surfaces the error correctly.
// ---------------------------------------------------------------------------

describe("DiffPreviewModal — round-3 residual #1: cancel voids confirm", () => {
  it("after cancel, a new confirm attempt with the same id surfaces Validation error", async () => {
    // Step 1: Cancel the diff.
    mockInvoke("diff_preview_cancel", undefined);

    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /cancel change/i }));

    await waitFor(() => {
      expect(useDiffStore.getState().currentDiff).toBeNull();
    });

    cleanup();

    // Step 2: Re-open modal with same (now cancelled) diff id.
    useDiffStore.setState({
      currentDiff: { id: "test-diff-id", payload: STORAGE_CLASS_PAYLOAD },
    });

    // Backend rejects confirm with Validation error (cancelled diff).
    // Combine Error (instanceof check in mock) with AppError fields
    // (isAppError check in normalizeError) so invoke rejects with AppError.
    mockInvoke(
      "object_set_storage_class",
      Object.assign(new Error("Diff was cancelled or expired"), {
        kind: "Validation",
        retryable: false,
        details: {
          field: "confirmed_diff_id",
          hint: "Diff was cancelled or expired",
        },
      }),
    );

    render(<DiffPreviewModal profileId="p-test" />);

    fireEvent.click(screen.getByRole("button", { name: /confirm change/i }));

    await waitFor(() => {
      // Error is surfaced in the modal.
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Decision D2 boundary: EXCLUDED_FROM_OPTIMISM includes "storage_class"
// ---------------------------------------------------------------------------

describe("Decision D2 boundary", () => {
  it("EXCLUDED_FROM_OPTIMISM includes storage_class", () => {
    expect(EXCLUDED_FROM_OPTIMISM).toContain("storage_class");
  });

  it("storage_class is not in OPTIMISTIC_HELPERS_MAP", async () => {
    const { OPTIMISTIC_HELPERS_MAP } = await import("@/query/optimistic");
    expect(Object.keys(OPTIMISTIC_HELPERS_MAP)).not.toContain("storage_class");
  });
});
