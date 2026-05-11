/**
 * Tests for useDragOut hook (DragOut.tsx).
 *
 * Coverage:
 * 1. On macOS: startDragOut calls transferDownloadMany then tauriDragFiles.
 * 2. On Linux: startDragOut opens the save dialog then calls transferDownloadMany.
 * 3. isDragOutReady reflects the platform.
 * 4. startDragOut is a no-op when entries is empty.
 * 5. Save dialog cancel is handled (no download if destPath is null).
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mocks — must be declared before dynamic imports
// ---------------------------------------------------------------------------

// Platform mock: start as mac, override per-test.
let mockPlatformValue = "mac";

vi.mock("@/lib/platform", () => ({
  isDragOutSupported: async () =>
    mockPlatformValue === "mac" || mockPlatformValue === "win",
  getPlatform: async () => mockPlatformValue,
}));

// Tauri drag API mock.
const mockStartDragging = vi.fn().mockResolvedValue(undefined);
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({ startDragging: mockStartDragging }),
}));

// Dialog save mock.
const mockSave = vi.fn().mockResolvedValue("/home/user/output.txt");
vi.mock("@tauri-apps/plugin-dialog", () => ({
  save: (...args: unknown[]) => mockSave(...args),
  open: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntries() {
  return [
    {
      profileId: "p1",
      bucket: "my-bucket",
      key: "docs/report.pdf",
      filename: "report.pdf",
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockPlatformValue = "mac";
});

describe("useDragOut — macOS/Windows: Tauri drag API path", () => {
  it("isDragOutReady is true on mac", async () => {
    mockPlatformValue = "mac";
    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() => useDragOut({ entries: makeEntries() }));

    // Wait for the async platform check.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.isDragOutReady).toBe(true);
  });

  it("calls transferDownloadMany then tauriDragFiles on drag start (mac)", async () => {
    mockPlatformValue = "mac";
    mockInvoke("transfer_download_many", ["req-1"]);

    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() =>
      useDragOut({ entries: makeEntries(), tempDir: "/tmp/test-drag" }),
    );

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      result.current.startDragOut({
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent);
      // Let the async work complete.
      await new Promise((r) => setTimeout(r, 30));
    });

    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    expect(mockInvokeFn).toHaveBeenCalledWith(
      "transfer_download_many",
      expect.objectContaining({
        specs: expect.arrayContaining([
          expect.objectContaining({
            profileId: "p1",
            bucket: "my-bucket",
            key: "docs/report.pdf",
            destPath: "/tmp/test-drag/report.pdf",
          }),
        ]),
      }),
    );
    expect(mockStartDragging).toHaveBeenCalledWith([
      "/tmp/test-drag/report.pdf",
    ]);
  });
});

describe("useDragOut — Linux: Save dialog fallback", () => {
  it("isDragOutReady is false on linux", async () => {
    mockPlatformValue = "linux";
    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() => useDragOut({ entries: makeEntries() }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(result.current.isDragOutReady).toBe(false);
  });

  it("opens save dialog then calls transferDownloadMany on linux", async () => {
    mockPlatformValue = "linux";
    mockSave.mockResolvedValue("/home/user/report.pdf");
    mockInvoke("transfer_download_many", ["req-1"]);

    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() => useDragOut({ entries: makeEntries() }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      result.current.startDragOut({
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "report.pdf" }),
    );
    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    expect(mockInvokeFn).toHaveBeenCalledWith(
      "transfer_download_many",
      expect.objectContaining({
        specs: expect.arrayContaining([
          expect.objectContaining({
            destPath: "/home/user/report.pdf",
          }),
        ]),
      }),
    );
  });

  it("does not call transferDownloadMany when the save dialog is cancelled (null)", async () => {
    mockPlatformValue = "linux";
    mockSave.mockResolvedValue(null);

    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() => useDragOut({ entries: makeEntries() }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      result.current.startDragOut({
        preventDefault: vi.fn(),
      } as unknown as React.MouseEvent);
      await new Promise((r) => setTimeout(r, 30));
    });

    const { mockInvokeFn } = await import("@/test/mocks/tauri");
    expect(mockInvokeFn).not.toHaveBeenCalledWith(
      "transfer_download_many",
      expect.anything(),
    );
  });
});

describe("useDragOut — empty entries guard", () => {
  it("startDragOut is a no-op when entries is empty", async () => {
    mockPlatformValue = "mac";

    const { useDragOut } = await import("../DragOut");
    const { result } = renderHook(() => useDragOut({ entries: [] }));

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      result.current.startDragOut({
        preventDefault: vi.fn(),
      } as unknown as React.DragEvent);
      await new Promise((r) => setTimeout(r, 30));
    });

    expect(mockStartDragging).not.toHaveBeenCalled();
  });
});
