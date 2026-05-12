/**
 * Tests for `notifyTransferStarted`.
 *
 * Coverage:
 * 1. Fires one info toast with download title for kind=download.
 * 2. Fires one info toast with upload title for kind=upload.
 * 3. Uses messageOne when count === 1, messageMany otherwise.
 * 4. Action click opens the Activity Center via the UI store.
 * 5. No-op when count === 0.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { onToast, type ToastNotification } from "@/lib/errors";
import { notifyTransferStarted } from "@/query/notifyTransferStarted";
import { useUiStore } from "@/store/ui";

function captureToasts(): ToastNotification[] {
  const captured: ToastNotification[] = [];
  onToast((n) => {
    captured.push(n);
  });
  return captured;
}

beforeEach(() => {
  useUiStore.setState({ activityCenterOpen: false });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("notifyTransferStarted", () => {
  it("fires one info toast for a download", () => {
    const toasts = captureToasts();
    notifyTransferStarted(5, "download");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.severity).toBe("info");
    expect(toasts[0]?.title.toLowerCase()).toContain("download");
  });

  it("fires one info toast for an upload", () => {
    const toasts = captureToasts();
    notifyTransferStarted(3, "upload");
    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.title.toLowerCase()).toContain("upload");
  });

  it("uses the singular message when count is 1", () => {
    const toasts = captureToasts();
    notifyTransferStarted(1, "download");
    expect(toasts[0]?.message).toContain("1");
  });

  it("uses the many message when count > 1", () => {
    const toasts = captureToasts();
    notifyTransferStarted(7, "download");
    expect(toasts[0]?.message).toContain("7");
  });

  it("the action opens the Activity Center", () => {
    const toasts = captureToasts();
    notifyTransferStarted(2, "download");
    expect(useUiStore.getState().activityCenterOpen).toBe(false);
    toasts[0]?.action?.onClick();
    expect(useUiStore.getState().activityCenterOpen).toBe(true);
  });

  it("is a no-op when count <= 0", () => {
    const toasts = captureToasts();
    notifyTransferStarted(0, "download");
    expect(toasts).toHaveLength(0);
  });
});
