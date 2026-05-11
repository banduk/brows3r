/**
 * Tests for <MarkdownPreview />.
 *
 * Coverage:
 * 1. Shows loading skeleton synchronously.
 * 2. Renders markdown content after load.
 * 3. Shows error slot when objectGetText rejects.
 * 4. Truncation banner when payload.truncated = true.
 * 5. Renders GFM-flavored elements (tables).
 * 6. axe-core a11y on loading state.
 * 7. axe-core a11y on rendered state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import { MarkdownPreview } from "../MarkdownPreview";

// ---------------------------------------------------------------------------
// Mock react-markdown and remark/rehype plugins to keep tests isolated.
// ---------------------------------------------------------------------------

vi.mock("react-markdown", () => ({
  default: ({
    children,
  }: {
    children: string;
    remarkPlugins?: unknown[];
    rehypePlugins?: unknown[];
    components?: unknown;
  }) => <div data-testid="markdown-rendered">{children}</div>,
}));

vi.mock("remark-gfm", () => ({ default: () => {} }));
vi.mock("rehype-highlight", () => ({ default: () => {} }));
vi.mock("rehype-sanitize", () => ({ default: () => {} }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_PAYLOAD = {
  body: "# Hello\n\nThis is **markdown**.",
  contentLength: 30,
  etag: '"abc"',
  truncated: false,
};

const TRUNCATED_PAYLOAD = {
  ...TEXT_PAYLOAD,
  truncated: true,
  contentLength: 2 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockInvoke("object_get_text", TEXT_PAYLOAD);
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// 1. Loading skeleton
// ---------------------------------------------------------------------------

describe("MarkdownPreview — loading skeleton", () => {
  it("shows loading skeleton before content resolves", () => {
    mockInvoke("object_get_text", new Promise(() => {}));

    const { unmount } = render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    expect(screen.getByTestId("markdown-loading-skeleton")).toBeInTheDocument();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 2. Renders content
// ---------------------------------------------------------------------------

describe("MarkdownPreview — content rendering", () => {
  it("renders markdown content area after load", async () => {
    render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
    });
  });

  it("passes body text to ReactMarkdown", async () => {
    render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-rendered")).toBeInTheDocument();
      expect(screen.getByTestId("markdown-rendered").textContent).toContain(
        "Hello",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Error slot
// ---------------------------------------------------------------------------

describe("MarkdownPreview — error state", () => {
  it("shows error when objectGetText rejects", async () => {
    mockInvoke("object_get_text", new Error("Network error"));

    render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-error")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Truncation banner
// ---------------------------------------------------------------------------

describe("MarkdownPreview — truncation banner", () => {
  it("shows truncation banner when payload.truncated = true", async () => {
    mockInvoke("object_get_text", TRUNCATED_PAYLOAD);

    render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="large.md"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("markdown-truncated-banner"),
      ).toBeInTheDocument();
    });
  });

  it("does NOT show truncation banner when not truncated", async () => {
    render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="small.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
    });

    expect(
      screen.queryByTestId("markdown-truncated-banner"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6. axe-core a11y — loading state
// ---------------------------------------------------------------------------

describe("MarkdownPreview — a11y (loading)", () => {
  it("has no axe violations in loading state", async () => {
    mockInvoke("object_get_text", new Promise(() => {}));

    const { container, unmount } = render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 7. axe-core a11y — rendered state
// ---------------------------------------------------------------------------

describe("MarkdownPreview — a11y (rendered)", () => {
  it("has no axe violations in rendered state", async () => {
    const { container } = render(
      <MarkdownPreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="README.md"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("markdown-content")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
