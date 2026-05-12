/**
 * Tests for `notifyDownloadComplete`.
 *
 * Coverage:
 * 1. A single completed download fires one success toast with an
 *    "Open folder" action.
 * 2. Several completions within the coalesce window collapse into one
 *    toast that reports the batch count.
 * 3. Non-download transfers (uploads) do not fire the toast.
 * 4. Transfers without a destPath do not fire the toast.
 * 5. Clicking the action invokes `revealItemInDir(destPath)`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TransferKind } from "@/api/transfers";
import { onToast, type ToastNotification } from "@/lib/errors";
import { notifyDownloadComplete } from "@/query/notifyDownloadComplete";
import { type Transfer, useTransfersStore } from "@/store/transfers";

// ---------------------------------------------------------------------------
// Mock @tauri-apps/plugin-opener
// ---------------------------------------------------------------------------

const revealItemInDirMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/plugin-opener", () => ({
  revealItemInDir: (path: string) => revealItemInDirMock(path),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeTransfer(id: string, overrides: Partial<Transfer> = {}): Transfer {
  return {
    id,
    kind: "download" as TransferKind,
    profileId: "p1",
    bucket: "my-bucket",
    key: "photos/cat.jpg",
    destPath: "/Users/me/Downloads/cat.jpg",
    transferredBytes: 1024,
    partsDone: 1,
    partsTotal: 1,
    state: "done",
    startedAt: Date.now(),
    finishedAt: Date.now(),
    ...overrides,
  };
}

function captureToasts(): ToastNotification[] {
  const captured: ToastNotification[] = [];
  onToast((n) => {
    captured.push(n);
  });
  return captured;
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.useFakeTimers();
  useTransfersStore.setState({
    transfers: new Map(),
  });
  revealItemInDirMock.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifyDownloadComplete", () => {
  it("fires one success toast with an Open folder action for a single download", () => {
    const t = fakeTransfer("req-1");
    useTransfersStore.getState().upsert(t);
    const toasts = captureToasts();

    notifyDownloadComplete("req-1");
    vi.advanceTimersByTime(500);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.severity).toBe("success");
    expect(toasts[0]?.action?.label).toBeTruthy();
    expect(toasts[0]?.message).toContain("cat.jpg");
  });

  it("coalesces a burst of completions into one toast", () => {
    for (let i = 0; i < 5; i++) {
      const t = fakeTransfer(`req-${i}`, {
        destPath: `/Users/me/Downloads/file-${i}.jpg`,
      });
      useTransfersStore.getState().upsert(t);
    }
    const toasts = captureToasts();

    for (let i = 0; i < 5; i++) {
      notifyDownloadComplete(`req-${i}`);
    }
    vi.advanceTimersByTime(500);

    expect(toasts).toHaveLength(1);
    expect(toasts[0]?.message).toContain("5");
  });

  it("does not fire for upload transfers", () => {
    useTransfersStore
      .getState()
      .upsert(fakeTransfer("upl-1", { kind: "upload" }));
    const toasts = captureToasts();

    notifyDownloadComplete("upl-1");
    vi.advanceTimersByTime(500);

    expect(toasts).toHaveLength(0);
  });

  it("does not fire when destPath is missing", () => {
    useTransfersStore
      .getState()
      .upsert(fakeTransfer("req-nodest", { destPath: undefined }));
    const toasts = captureToasts();

    notifyDownloadComplete("req-nodest");
    vi.advanceTimersByTime(500);

    expect(toasts).toHaveLength(0);
  });

  it("clicking the action calls revealItemInDir(destPath)", () => {
    useTransfersStore.getState().upsert(fakeTransfer("req-rev"));
    const toasts = captureToasts();

    notifyDownloadComplete("req-rev");
    vi.advanceTimersByTime(500);

    expect(toasts[0]?.action).toBeTruthy();
    toasts[0]?.action?.onClick();

    // The mocked revealItemInDir is called asynchronously inside the
    // onClick handler; the import happens at the same tick.
    return vi.waitFor(() => {
      expect(revealItemInDirMock).toHaveBeenCalledWith(
        "/Users/me/Downloads/cat.jpg",
      );
    });
  });
});
