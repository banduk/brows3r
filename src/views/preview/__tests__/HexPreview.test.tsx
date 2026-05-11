/**
 * Tests for <HexPreview />.
 *
 * Coverage:
 * 1. Shows loading skeleton before content resolves.
 * 2. Renders hex dump content after load.
 * 3. Shows error slot when objectGetBytes rejects.
 * 4. Truncation banner when payload.truncated = true.
 * 5. formatHexRow: synthetic bytes → row formatted correctly.
 * 6. base64ToUint8Array: decodes correctly.
 * 7. axe-core a11y on loading state.
 * 8. axe-core a11y on rendered state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import { base64ToUint8Array, formatHexRow, HexPreview } from "../HexPreview";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Base64 of "Hello world!\n" (13 bytes).
 * `btoa("Hello world!\n")` = "SGVsbG8gd29ybGQhCg=="
 */
const HELLO_B64 = btoa("Hello world!\n");

const BYTES_PAYLOAD = {
  body: HELLO_B64,
  contentLength: 13,
  etag: '"abc"',
  truncated: false,
};

const TRUNCATED_PAYLOAD = {
  ...BYTES_PAYLOAD,
  truncated: true,
  contentLength: 8192,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInvoke("object_get_bytes", BYTES_PAYLOAD);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Loading skeleton
// ---------------------------------------------------------------------------

describe("HexPreview — loading skeleton", () => {
  it("shows loading skeleton before content resolves", () => {
    mockInvoke("object_get_bytes", new Promise(() => {}));

    const { unmount } = render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    expect(screen.getByTestId("hex-loading-skeleton")).toBeInTheDocument();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 2. Renders hex dump
// ---------------------------------------------------------------------------

describe("HexPreview — hex dump rendering", () => {
  it("renders hex content area after load", async () => {
    render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hex-content")).toBeInTheDocument();
    });
  });

  it("hex dump contains the expected offset prefix", async () => {
    render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Hex dump")).toBeInTheDocument();
    });

    const pre = screen.getByLabelText("Hex dump");
    // First row starts at offset 0x00000000.
    expect(pre.textContent).toContain("00000000");
    // ASCII "Hello" appears in the ASCII column.
    expect(pre.textContent).toContain("Hello");
  });
});

// ---------------------------------------------------------------------------
// 3. Error slot
// ---------------------------------------------------------------------------

describe("HexPreview — error state", () => {
  it("shows error when objectGetBytes rejects", async () => {
    mockInvoke("object_get_bytes", new Error("Access denied"));

    render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hex-error")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation banner
// ---------------------------------------------------------------------------

describe("HexPreview — truncation banner", () => {
  it("shows truncation banner when payload.truncated = true", async () => {
    mockInvoke("object_get_bytes", TRUNCATED_PAYLOAD);

    render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="large.bin" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hex-truncated-banner")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. formatHexRow — unit tests
// ---------------------------------------------------------------------------

describe("formatHexRow", () => {
  it("formats a full 16-byte row correctly", () => {
    const bytes = new Uint8Array(16).fill(0x41); // 'A' = 0x41
    const row = formatHexRow(0, bytes);

    // Offset at start.
    expect(row).toMatch(/^00000000/);
    // Hex representation of 'A'.
    expect(row).toContain("41");
    // ASCII 'A' column.
    expect(row).toContain("AAAAAAAAAAAAAAAA");
  });

  it("pads incomplete last row with spaces", () => {
    // 4-byte row.
    const bytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c]); // "Hell"
    const row = formatHexRow(16, bytes);

    expect(row).toMatch(/^00000010/);
    expect(row).toContain("48 65 6c 6c");
    expect(row).toContain("Hell");
  });

  it("replaces non-printable bytes with dots in ASCII column", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x41, 0x7f]);
    const row = formatHexRow(0, bytes);

    // 0x00, 0x01, 0x7f → '.'; 0x41 → 'A'
    expect(row).toContain("..A.");
  });

  it("formats offset correctly for non-zero offsets", () => {
    const bytes = new Uint8Array([0xff]);
    const row = formatHexRow(0x100, bytes);
    expect(row).toMatch(/^00000100/);
  });
});

// ---------------------------------------------------------------------------
// 6. base64ToUint8Array — unit tests
// ---------------------------------------------------------------------------

describe("base64ToUint8Array", () => {
  it("decodes a base64 string to correct bytes", () => {
    // "ABC" → base64 "QUJD"
    const b64 = btoa("ABC");
    const result = base64ToUint8Array(b64);

    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(3);
    expect(result[0]).toBe(65); // 'A'
    expect(result[1]).toBe(66); // 'B'
    expect(result[2]).toBe(67); // 'C'
  });

  it("decodes empty base64 to empty Uint8Array", () => {
    const result = base64ToUint8Array(btoa(""));
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. axe-core a11y — loading state
// ---------------------------------------------------------------------------

describe("HexPreview — a11y (loading)", () => {
  it("has no axe violations in loading state", async () => {
    mockInvoke("object_get_bytes", new Promise(() => {}));

    const { container, unmount } = render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 8. axe-core a11y — rendered state
// ---------------------------------------------------------------------------

describe("HexPreview — a11y (rendered)", () => {
  it("has no axe violations in rendered state", async () => {
    const { container } = render(
      <HexPreview profileId="p1" bucket="my-bucket" objectKey="data.bin" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("hex-content")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
