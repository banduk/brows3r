/**
 * Tests for <TextPreview />.
 *
 * Coverage:
 * 1. Shows loading skeleton synchronously.
 * 2. Renders Monaco editor (read-only) with the body once loaded.
 * 3. Detects language from the key extension.
 * 4. Shows error slot when objectGetText rejects.
 * 5. Truncation banner when payload.truncated = true.
 * 6. axe-core a11y on loading state.
 * 7. axe-core a11y on rendered state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import { TextPreviewCoreImpl as TextPreview } from "../TextPreview";

// ---------------------------------------------------------------------------
// Mock @monaco-editor/react — the real Monaco can't run in jsdom and pulling
// it in would blow up the test bundle. The mock surfaces every prop we assert
// on (`value`, `language`, `options.readOnly`, `options.wordWrap`) via
// data-attributes so we can verify wiring without launching Monaco.
// ---------------------------------------------------------------------------

vi.mock("@monaco-editor/react", () => ({
  default: ({
    value,
    language,
    options,
  }: {
    value?: string;
    language?: string;
    options?: { readOnly?: boolean; wordWrap?: string };
  }) => (
    <div
      data-testid="monaco-editor-mock"
      data-language={language}
      data-readonly={options?.readOnly ? "true" : "false"}
      data-word-wrap={options?.wordWrap}
    >
      {value}
    </div>
  ),
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

beforeEach(() => {
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
// 2. Renders body
// ---------------------------------------------------------------------------

describe("TextPreview — rendering", () => {
  it("renders Monaco in read-only mode with the body once loaded", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument();
    });

    const editor = screen.getByTestId("monaco-editor-mock");
    expect(editor.textContent).toContain(TEXT_PAYLOAD.body);
    expect(editor).toHaveAttribute("data-readonly", "true");
  });

  it("detects typescript language from .ts extension", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="app/main.ts" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument();
    });

    expect(screen.getByTestId("monaco-editor-mock")).toHaveAttribute(
      "data-language",
      "typescript",
    );
  });

  it("detects python language from .py extension", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="script.py" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument();
    });

    expect(screen.getByTestId("monaco-editor-mock")).toHaveAttribute(
      "data-language",
      "python",
    );
  });

  it("falls back to plaintext for unknown extensions", async () => {
    render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="archive.tar" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument();
    });

    expect(screen.getByTestId("monaco-editor-mock")).toHaveAttribute(
      "data-language",
      "plaintext",
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Error slot
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
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation banner
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
      expect(screen.getByTestId("text-preview")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("text-preview-truncated"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Axe-core a11y — loading state
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
// 6. Axe-core a11y — rendered state
// ---------------------------------------------------------------------------

describe("TextPreview — a11y (rendered state)", () => {
  it("has no axe violations when content is rendered", async () => {
    const { container } = render(
      <TextPreview profileId="p1" bucket="my-bucket" objectKey="index.ts" />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("monaco-editor-mock")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
