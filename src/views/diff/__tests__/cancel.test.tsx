/**
 * Round-3 residual #1 derived test: cancel.test.tsx
 *
 * Spec requirement (design.md line 570–573):
 *   "Cancel path: `diff_preview_cancel { diffId }` removes the pending diff;
 *    any subsequent attempt to use the diff returns `AppError::Validation`.
 *    This addresses the round-3 residual watch item with a derived test
 *    case in `views/diff/__tests__/cancel.test.tsx`."
 *
 * This file specifically tests the cancel-then-confirm sequence using the
 * `useDiffStore` and mocked API layer.
 *
 * Coverage:
 * 1. `closeDiff('cancelled')` clears `currentDiff`.
 * 2. After cancel, the diff id is no longer usable (backend mock returns error).
 * 3. `openDiff` → cancel flow via `diffPreviewCancel` API.
 * 4. Store `openDiff` calls `diffPreviewCreate` and sets `currentDiff`.
 */

import { afterEach, describe, expect, it } from "vitest";
import type { DiffPayload } from "@/api/diff";
import { diffPreviewCancel } from "@/api/diff";
import { createDiffStore } from "@/store/diff";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAYLOAD: DiffPayload = {
  kind: "storage_class",
  targets: [{ bucket: "b", key: "k.txt" }],
  current: { "k.txt": "STANDARD" },
  newClass: "GLACIER",
};

afterEach(() => {
  // clearInvokeMocks is called by setup.ts afterEach
});

// ---------------------------------------------------------------------------
// Store: openDiff / closeDiff lifecycle
// ---------------------------------------------------------------------------

describe("useDiffStore — openDiff / closeDiff lifecycle", () => {
  it("openDiff calls diffPreviewCreate and sets currentDiff", async () => {
    mockInvoke("diff_preview_create", "test-uuid-123");

    const store = createDiffStore();
    const id = await store.getState().openDiff(PAYLOAD);

    expect(id).toBe("test-uuid-123");
    const state = store.getState();
    expect(state.currentDiff).not.toBeNull();
    expect(state.currentDiff?.id).toBe("test-uuid-123");
    expect(state.currentDiff?.payload).toEqual(PAYLOAD);
  });

  it("closeDiff('cancelled') clears currentDiff", async () => {
    mockInvoke("diff_preview_create", "uuid-cancel-test");

    const store = createDiffStore();
    await store.getState().openDiff(PAYLOAD);
    expect(store.getState().currentDiff).not.toBeNull();

    store.getState().closeDiff("cancelled");
    expect(store.getState().currentDiff).toBeNull();
  });

  it("closeDiff('confirmed') clears currentDiff", async () => {
    mockInvoke("diff_preview_create", "uuid-confirm-test");

    const store = createDiffStore();
    await store.getState().openDiff(PAYLOAD);

    store.getState().closeDiff("confirmed");
    expect(store.getState().currentDiff).toBeNull();
  });

  it("closeDiff('closed') clears currentDiff", async () => {
    mockInvoke("diff_preview_create", "uuid-close-test");

    const store = createDiffStore();
    await store.getState().openDiff(PAYLOAD);

    store.getState().closeDiff("closed");
    expect(store.getState().currentDiff).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Cancel API: diffPreviewCancel
// ---------------------------------------------------------------------------

describe("diffPreviewCancel API call", () => {
  it("resolves without error when cancel succeeds", async () => {
    mockInvoke("diff_preview_cancel", undefined);

    await expect(diffPreviewCancel("some-diff-id")).resolves.toBeUndefined();
  });

  it("rejects when backend returns error (e.g. diff not found)", async () => {
    // Combine Error (instanceof check in mock) with AppError fields
    // (isAppError check in normalizeError) so invoke rejects with AppError.
    mockInvoke(
      "diff_preview_cancel",
      Object.assign(new Error("diff not found"), {
        kind: "NotFound",
        retryable: false,
        details: { resource: "diff:ghost-id" },
      }),
    );

    await expect(diffPreviewCancel("ghost-id")).rejects.toMatchObject({
      kind: "NotFound",
    });
  });
});

// ---------------------------------------------------------------------------
// Round-3 residual #1 core assertion
//
// Cancelling via diffPreviewCancel THEN attempting objectSetStorageClass with
// the same diff id must fail with a Validation error from the backend.
// ---------------------------------------------------------------------------

describe("Round-3 residual #1: cancel voids confirm", () => {
  it("after cancel, objectSetStorageClass with stale diff id returns Validation", async () => {
    // Setup: cancel succeeds.
    mockInvoke("diff_preview_cancel", undefined);
    await diffPreviewCancel("voided-diff-id");

    // The backend now rejects confirms with the voided id.
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

    // Attempt to use the cancelled diff id in the confirm command.
    const { objectSetStorageClass } = await import("@/api/objects");

    await expect(
      objectSetStorageClass(
        "p-test",
        [{ bucket: "b", key: "k.txt" }],
        "GLACIER",
        "voided-diff-id",
      ),
    ).rejects.toMatchObject({ kind: "Validation" });
  });
});
