/**
 * Tests for <PdfPreview />.
 *
 * Coverage:
 * 1. Registers media on mount (calls media_register invoke).
 * 2. Revokes token on unmount (calls media_revoke invoke).
 * 3. Shows loading skeleton while URL is pending.
 * 4. Renders toolbar with page indicator after load.
 * 5. Prev/Next page buttons change page state.
 * 6. Zoom controls change zoom level text.
 * 7. Shows error slot when mediaRegister rejects.
 * 8. Validation gate: profile not validated → placeholder for each (tested via
 *    PreviewPane; PdfPreview itself relies on the gate in useObjectHead).
 * 9. axe-core a11y on loading state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke, mockInvokeFn } from "@/test/mocks/tauri";
import { PdfPreview } from "../PdfPreview";

// ---------------------------------------------------------------------------
// Mock react-pdf — avoid needing a real PDF.js worker in jsdom.
// ---------------------------------------------------------------------------

vi.mock("react-pdf", () => {
  const Document = ({
    file,
    onLoadSuccess,
    children,
  }: {
    file: string | null;
    onLoadSuccess?: (info: { numPages: number }) => void;
    onLoadError?: (err: Error) => void;
    children?: React.ReactNode;
  }) => {
    // Simulate successful load when file is truthy.
    if (file && onLoadSuccess) {
      Promise.resolve().then(() => onLoadSuccess({ numPages: 5 }));
    }
    return <div data-testid="pdf-document">{children}</div>;
  };

  const Page = ({ pageNumber }: { pageNumber: number }) => (
    <div data-testid={`pdf-page-${pageNumber}`}>Page {pageNumber}</div>
  );

  return {
    Document,
    Page,
    pdfjs: { GlobalWorkerOptions: { workerSrc: "" } },
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MEDIA_URL = "http://127.0.0.1:12345/m/tok-pdf-abc";
const MEDIA_RESPONSE = { url: MEDIA_URL, expiresAt: Date.now() / 1000 + 3600 };

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInvoke("media_register", MEDIA_RESPONSE);
  mockInvoke("media_revoke", undefined);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Registers media on mount
// ---------------------------------------------------------------------------

describe("PdfPreview — media registration", () => {
  it("calls media_register on mount", async () => {
    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    await waitFor(() => {
      const registerCalls = mockInvokeFn.mock.calls.filter(
        ([cmd]) => cmd === "media_register",
      );
      expect(registerCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Revokes token on unmount
// ---------------------------------------------------------------------------

describe("PdfPreview — media revocation", () => {
  it("calls media_revoke on unmount", async () => {
    const { unmount } = render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    // Wait for URL to be set.
    await waitFor(() => {
      expect(screen.getByTestId("pdf-preview")).toBeInTheDocument();
    });

    unmount();

    await waitFor(() => {
      const revokeCalls = mockInvokeFn.mock.calls.filter(
        ([cmd]) => cmd === "media_revoke",
      );
      expect(revokeCalls.length).toBeGreaterThanOrEqual(1);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Loading skeleton
// ---------------------------------------------------------------------------

describe("PdfPreview — loading skeleton", () => {
  it("shows loading skeleton synchronously before URL resolves", () => {
    // Use a pending promise so the skeleton stays visible.
    mockInvoke("media_register", new Promise(() => {}));

    const { unmount } = render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    expect(screen.getByTestId("pdf-loading-skeleton")).toBeInTheDocument();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 4. Renders toolbar after load
// ---------------------------------------------------------------------------

describe("PdfPreview — toolbar", () => {
  it("shows page indicator after media URL resolves", async () => {
    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-indicator")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 5. Page navigation
// ---------------------------------------------------------------------------

describe("PdfPreview — page navigation", () => {
  it("increments page on next click", async () => {
    const user = userEvent.setup();
    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    // Wait for toolbar.
    await waitFor(() =>
      expect(screen.getByTestId("pdf-page-indicator")).toBeInTheDocument(),
    );

    // Wait for numPages to be set by simulated onLoadSuccess.
    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-indicator").textContent).toMatch(
        /Page 1 of/,
      );
    });

    await user.click(screen.getByTestId("pdf-next-page"));

    await waitFor(() => {
      expect(screen.getByTestId("pdf-page-indicator").textContent).toMatch(
        /Page 2/,
      );
    });
  });

  it("prev button is disabled on first page", async () => {
    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("pdf-prev-page")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("pdf-prev-page")).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// 6. Zoom controls
// ---------------------------------------------------------------------------

describe("PdfPreview — zoom controls", () => {
  it("shows zoom level and responds to zoom in click", async () => {
    const user = userEvent.setup();
    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("pdf-zoom-level")).toBeInTheDocument(),
    );

    expect(screen.getByTestId("pdf-zoom-level").textContent).toBe("100%");

    await user.click(screen.getByTestId("pdf-zoom-in"));

    expect(screen.getByTestId("pdf-zoom-level").textContent).toBe("125%");
  });
});

// ---------------------------------------------------------------------------
// 7. Error slot
// ---------------------------------------------------------------------------

describe("PdfPreview — error state", () => {
  it("shows error when media_register fails", async () => {
    mockInvoke("media_register", new Error("S3 access denied"));

    render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("pdf-error")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Axe-core a11y
// ---------------------------------------------------------------------------

describe("PdfPreview — a11y", () => {
  it("has no axe violations in loading state", async () => {
    mockInvoke("media_register", new Promise(() => {}));

    const { container, unmount } = render(
      <PdfPreview profileId="p1" bucket="my-bucket" objectKey="doc.pdf" />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});
