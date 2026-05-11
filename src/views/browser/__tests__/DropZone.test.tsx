/**
 * Tests for <DropZone />.
 *
 * Coverage:
 * 1. dragenter sets visual state to "over" when Files type is present.
 * 2. dragleave resets visual state when leaving the container.
 * 3. drop with Tauri file paths calls transferUploadMany with correct specs.
 * 4. drop with no paths or no bucket is a no-op.
 * 5. Snapshot test for idle, drag-over, drop-success visual states.
 * 6. Axe-core a11y assertion.
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke, mockInvokeFn } from "@/test/mocks/tauri";
import { DropZone } from "../DropZone";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(name: string, path: string): File & { path: string } {
  const f = new File(["content"], name, { type: "text/plain" });
  // Simulate the Tauri-injected .path property.
  Object.defineProperty(f, "path", { value: path, writable: false });
  return f as File & { path: string };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DropZone — drag-over visual state", () => {
  it("shows overlay when Files are dragged over", () => {
    render(
      <DropZone profileId="p1" bucket="my-bucket" prefix="">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(screen.getByTestId("drop-zone-overlay")).toBeInTheDocument();
  });

  it("does not show overlay for non-Files drag", () => {
    render(
      <DropZone profileId="p1" bucket="my-bucket" prefix="">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ["text/plain"], files: [] },
    });
    expect(screen.queryByTestId("drop-zone-overlay")).not.toBeInTheDocument();
  });

  it("hides overlay on dragLeave when leaving container", () => {
    render(
      <DropZone profileId="p1" bucket="my-bucket" prefix="">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(screen.getByTestId("drop-zone-overlay")).toBeInTheDocument();

    // relatedTarget = null means we left the container boundary.
    fireEvent.dragLeave(zone, { relatedTarget: null });
    expect(screen.queryByTestId("drop-zone-overlay")).not.toBeInTheDocument();
  });
});

describe("DropZone — drop triggers transferUploadMany", () => {
  it("calls transfer_upload_many with the correct specs", async () => {
    mockInvoke("transfer_upload_many", ["req-1", "req-2"]);

    render(
      <DropZone profileId="p1" bucket="my-bucket" prefix="photos/">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");

    const file1 = makeFile("cat.jpg", "/home/user/cat.jpg");
    const file2 = makeFile("dog.png", "/home/user/dog.png");

    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [file1, file2] },
    });

    await waitFor(() => {
      expect(mockInvokeFn).toHaveBeenCalledWith(
        "transfer_upload_many",
        expect.objectContaining({
          specs: expect.arrayContaining([
            expect.objectContaining({
              profileId: "p1",
              bucket: "my-bucket",
              key: "photos/cat.jpg",
              sourcePath: "/home/user/cat.jpg",
            }),
            expect.objectContaining({
              key: "photos/dog.png",
              sourcePath: "/home/user/dog.png",
            }),
          ]),
        }),
      );
    });
  });

  it("shows success state after drop", async () => {
    mockInvoke("transfer_upload_many", ["req-1"]);

    render(
      <DropZone profileId="p1" bucket="my-bucket" prefix="">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    const file = makeFile("test.txt", "/tmp/test.txt");

    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByTestId("drop-zone-success")).toBeInTheDocument();
    });
  });

  it("is a no-op when bucket is null", () => {
    render(
      <DropZone profileId="p1" bucket={null} prefix="">
        <div>content</div>
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    const file = makeFile("test.txt", "/tmp/test.txt");
    // Should not throw.
    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [file] },
    });
  });

  it("announces the upload via aria-live", async () => {
    mockInvoke("transfer_upload_many", ["req-1"]);

    render(
      <DropZone profileId="p1" bucket="b" prefix="docs/">
        <div />
      </DropZone>,
    );

    const zone = screen.getByTestId("drop-zone");
    const file = makeFile("report.pdf", "/tmp/report.pdf");
    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [file] },
    });

    await waitFor(() => {
      expect(screen.getByTestId("drop-zone-announcement").textContent).toMatch(
        /uploading 1 file/i,
      );
    });
  });
});

describe("DropZone — snapshot", () => {
  it("matches snapshot in idle state", () => {
    const { container } = render(
      <DropZone profileId="p1" bucket="b" prefix="">
        <div>idle content</div>
      </DropZone>,
    );
    expect(container.firstChild).toMatchSnapshot();
  });

  it("matches snapshot in drag-over state", () => {
    const { container } = render(
      <DropZone profileId="p1" bucket="b" prefix="">
        <div>content</div>
      </DropZone>,
    );
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    expect(container.firstChild).toMatchSnapshot();
  });
});

describe("DropZone — a11y", () => {
  it("has no axe violations in idle state", async () => {
    const { container } = render(
      <DropZone profileId="p1" bucket="b" prefix="">
        <div>content</div>
      </DropZone>,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations in drag-over state", async () => {
    const { container } = render(
      <DropZone profileId="p1" bucket="b" prefix="">
        <div>content</div>
      </DropZone>,
    );
    const zone = screen.getByTestId("drop-zone");
    fireEvent.dragEnter(zone, {
      dataTransfer: { types: ["Files"], files: [] },
    });
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
