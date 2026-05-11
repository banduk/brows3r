/**
 * Tests for crossPaneOps.ts.
 *
 * Coverage:
 * 1. Default drop (no Shift) → calls objectMove for each key.
 * 2. Shift drop → calls objectCopy for each key.
 * 3. Destination key is computed correctly relative to target prefix.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "@/test/mocks/tauri";
import { handleCrossPaneDrop } from "../crossPaneOps";
import type { DndPayload } from "../useDragSource";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockObjectMove = vi.fn().mockResolvedValue({ copyResult: {} });
const mockObjectCopy = vi
  .fn()
  .mockResolvedValue({ type: "serverSideCopy", result: {} });

vi.mock("@/api/objects", () => ({
  objectMove: (...args: unknown[]) => mockObjectMove(...args),
  objectCopy: (...args: unknown[]) => mockObjectCopy(...args),
}));

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePayload(overrides: Partial<DndPayload> = {}): DndPayload {
  return {
    sourcePaneId: "pane-a",
    profileId: "p1",
    bucket: "src-bucket",
    prefix: "src/",
    keys: ["src/file-a.txt", "src/file-b.txt"],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleCrossPaneDrop — move (no modifier)", () => {
  it("calls objectMove for each key when Shift is not held", async () => {
    mockInvoke("object_move", { copyResult: {} });

    const payload = makePayload();

    await handleCrossPaneDrop({
      payload,
      targetPaneId: "pane-b",
      targetBucket: "dest-bucket",
      targetPrefix: "dest/",
      modifierKeys: { shift: false },
    });

    expect(mockObjectMove).toHaveBeenCalledTimes(2);
    expect(mockObjectMove).toHaveBeenCalledWith(
      "p1",
      { bucket: "src-bucket", key: "src/file-a.txt" },
      { bucket: "dest-bucket", key: "dest/file-a.txt" },
    );
    expect(mockObjectMove).toHaveBeenCalledWith(
      "p1",
      { bucket: "src-bucket", key: "src/file-b.txt" },
      { bucket: "dest-bucket", key: "dest/file-b.txt" },
    );
  });
});

describe("handleCrossPaneDrop — copy (Shift held)", () => {
  it("calls objectCopy for each key when Shift is held", async () => {
    mockInvoke("object_copy", { type: "serverSideCopy", result: {} });

    const payload = makePayload();

    await handleCrossPaneDrop({
      payload,
      targetPaneId: "pane-b",
      targetBucket: "dest-bucket",
      targetPrefix: "dest/",
      modifierKeys: { shift: true },
    });

    expect(mockObjectCopy).toHaveBeenCalledTimes(2);
    expect(mockObjectCopy).toHaveBeenCalledWith(
      "p1",
      { bucket: "src-bucket", key: "src/file-a.txt" },
      { bucket: "dest-bucket", key: "dest/file-a.txt" },
    );
  });
});

describe("handleCrossPaneDrop — destination key computation", () => {
  it("strips the source prefix from each key before prepending the target prefix", async () => {
    mockInvoke("object_move", { copyResult: {} });

    const payload = makePayload({
      prefix: "deep/path/",
      keys: ["deep/path/report.pdf"],
    });

    await handleCrossPaneDrop({
      payload,
      targetPaneId: "pane-b",
      targetBucket: "dest-bucket",
      targetPrefix: "archive/",
      modifierKeys: { shift: false },
    });

    expect(mockObjectMove).toHaveBeenCalledWith(
      "p1",
      { bucket: "src-bucket", key: "deep/path/report.pdf" },
      { bucket: "dest-bucket", key: "archive/report.pdf" },
    );
  });

  it("handles empty target prefix (root)", async () => {
    mockInvoke("object_move", { copyResult: {} });

    const payload = makePayload({
      prefix: "src/",
      keys: ["src/img.png"],
    });

    await handleCrossPaneDrop({
      payload,
      targetPaneId: "pane-b",
      targetBucket: "dest-bucket",
      targetPrefix: "",
      modifierKeys: { shift: false },
    });

    expect(mockObjectMove).toHaveBeenCalledWith(
      "p1",
      { bucket: "src-bucket", key: "src/img.png" },
      { bucket: "dest-bucket", key: "img.png" },
    );
  });
});
