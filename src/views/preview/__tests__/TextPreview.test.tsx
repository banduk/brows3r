/**
 * Tests for <TextPreview />.
 *
 * Coverage:
 * 1. Shows loading skeleton synchronously.
 * 2. Renders highlighted HTML when Shiki returns HTML.
 * 3. Renders plain <pre> when no language is matched.
 * 4. Shows error slot when objectGetText rejects.
 * 5. Validation gate: profile not validated → placeholder (tested via
 *    PreviewPane routing; TextPreview itself does not have a gate — the
 *    gate lives in PreviewPane / useObjectHead, so we test the component
 *    directly here with a mocked invoke).
 * 6. Truncation banner when payload.truncated = true.
 * 7. axe-core a11y on loading state.
 * 8. axe-core a11y on rendered highlighted state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import { TextPreview } from "../TextPreview";

// ---------------------------------------------------------------------------
// Mock shiki lazy loader
// ---------------------------------------------------------------------------

vi.mock("@/lib/shiki", () => ({
  extensionToLanguage: (ext: string): string | null => {
    const map: Record<string, string> = {
      ".ts": "typescript",
      ".py": "python",
      ".json": "json",
    };
    return map[ext.toLowerCase()] ?? null;
  },
  highlight: vi.fn(),
  loadLanguage: vi.fn().mockResolvedValue(undefined),
  getHighlighter: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_PAYLOAD = {
  body: "const x = 1;",
  contentLength: 12,
  etag: '"abc123"',
  truncated: false,
};

const TRUNCATED_PAYLOAD = {
  ...TEXT_PAYLOAD,
  body: "x".repeat(100),
  contentLength: 1024 * 1024 + 1,
  truncated: true,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let mockHighlight: Mock;

beforeEach(async () => {
  const shikiMod = await import("@/lib/shiki");
  mockHighlight = shikiMod.highlight as Mock;
  mockHighlight.mockResolvedValue("<span>highlighted</span>");
  mockInvoke("object_get_text", TEXT_PAYLOAD);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Loading skeleton
// ---------------------------------------------------------------------------

describe("TextPreview — loading skeleton", () => {
  it("shows loading skeleton synchronously before fetch resolves", () => {
    const { unmount } = render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    expect(screen.getByTestId("text-preview-loading")).toBeInTheDocument();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 2. Highlighted HTML
// ---------------------------------------------------------------------------

describe("TextPreview — highlighted rendering", () => {
  it("renders highlighted HTML for a known extension", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("text-preview-highlighted"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("text-preview-highlighted").innerHTML).toContain(
      "highlighted",
    );
  });

  it("calls highlight with the correct language for .ts", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="app/main.ts" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("text-preview-highlighted"),
      ).toBeInTheDocument();
    });

    expect(mockHighlight).toHaveBeenCalledWith(
      TEXT_PAYLOAD.body,
      "typescript",
      expect.any(String),
    );
  });

  it("calls highlight with python for .py", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="script.py" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("text-preview-highlighted"),
      ).toBeInTheDocument();
    });

    expect(mockHighlight).toHaveBeenCalledWith(
      TEXT_PAYLOAD.body,
      "python",
      expect.any(String),
    );
  });

  it("calls highlight with json for .json", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="data.json" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("text-preview-highlighted"),
      ).toBeInTheDocument();
    });

    expect(mockHighlight).toHaveBeenCalledWith(
      TEXT_PAYLOAD.body,
      "json",
      expect.any(String),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Plain pre fallback for unknown extension
// ---------------------------------------------------------------------------

describe("TextPreview — plain text fallback", () => {
  it("renders plain <pre> when extension has no grammar", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="archive.tar" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-plain")).toBeInTheDocument();
    });
    expect(screen.getByTestId("text-preview-plain").textContent).toBe(
      TEXT_PAYLOAD.body,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Error slot
// ---------------------------------------------------------------------------

describe("TextPreview — error slot", () => {
  it("shows error slot when object_get_text fails", async () => {
    mockInvoke("object_get_text", new Error("S3 access denied"));

    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-error")).toBeInTheDocument();
    });
    // The error role is present; exact text depends on IPC normalization.
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. Truncation banner
// ---------------------------------------------------------------------------

describe("TextPreview — truncation banner", () => {
  it("shows truncation banner when payload.truncated = true", async () => {
    mockInvoke("object_get_text", TRUNCATED_PAYLOAD);

    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="large.ts" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("text-preview-truncated")).toBeInTheDocument();
    });
  });

  it("does not show truncation banner when payload.truncated = false", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="small.ts" />,
    );

    await waitFor(() => {
      // Wait for load to finish
      expect(screen.getByTestId("text-preview")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("text-preview-truncated"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 7. Axe-core a11y — loading state
// ---------------------------------------------------------------------------

describe("TextPreview — a11y (loading state)", () => {
  it("has no axe violations in loading state", async () => {
    const { container, unmount } = render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 8. Axe-core a11y — highlighted state
// ---------------------------------------------------------------------------

describe("TextPreview — a11y (highlighted state)", () => {
  it("has no axe violations when highlighted content is rendered", async () => {
    const { container } = render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("text-preview-highlighted"),
      ).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
