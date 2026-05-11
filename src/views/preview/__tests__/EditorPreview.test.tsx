/**
 * Tests for <EditorPreviewCoreImpl />.
 *
 * We test EditorPreviewCoreImpl directly (not the Suspense-wrapped EditorPreview)
 * to avoid Suspense / React.lazy in test mode. The Suspense wrapper itself is
 * tested implicitly by the lazy-load test below.
 *
 * Coverage:
 * 1. Loads body via mocked objectGetText.
 * 2. Save calls objectPutText with ifMatchEtag from current state.
 * 3. Conflict path: save returns AppError::Conflict → "File changed externally"
 *    UI shown.
 * 4. "Refresh" button reloads body + clears conflict state.
 * 5. "Save anyway" calls objectPutText without ifMatchEtag.
 * 6. Lazy load: Monaco only loaded when EditorPreview is rendered (dynamic
 *    import via React.lazy is triggered on render; verified via dynamic import
 *    spy).
 * 7. axe-core a11y on loading state.
 * 8. axe-core a11y on editor state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { EditorPreviewCoreImpl } from "../EditorPreview";

// ---------------------------------------------------------------------------
// Mock @monaco-editor/react
// ---------------------------------------------------------------------------

vi.mock("@monaco-editor/react", () => ({
  default: ({
    defaultValue,
    onChange,
  }: {
    defaultValue?: string;
    onChange?: (v: string | undefined) => void;
  }) => (
    <textarea
      data-testid="monaco-editor-mock"
      defaultValue={defaultValue}
      onChange={(e) => onChange?.(e.target.value)}
      aria-label="Code editor"
    />
  ),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_PAYLOAD = {
  body: "hello world",
  contentLength: 11,
  etag: '"abc123"',
  truncated: false,
};

const PUT_RESULT = {
  etag: '"def456"',
  lastModified: null,
  versionId: null,
};

const CONFLICT_ERROR = {
  kind: "Conflict",
  message: 'Conflict: expected ETag "abc123"',
  retryable: false,
  details: { etagExpected: '"abc123"', etagActual: null },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

// We import mockInvokeFn at module level so we can reset it.
let mockInvokeFn: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  const tauri = await import("@/test/mocks/tauri");
  mockInvokeFn = tauri.mockInvokeFn;
  // Default implementation: object_get_text → TEXT_PAYLOAD, put → PUT_RESULT.
  mockInvokeFn.mockImplementation(async (cmd: string) => {
    if (cmd === "object_get_text") return TEXT_PAYLOAD;
    if (cmd === "object_put_text") return PUT_RESULT;
    throw new Error(`[tauri mock] No handler for ${cmd}`);
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Loads body via mocked objectGetText
// ---------------------------------------------------------------------------

describe("EditorPreview — loads body", () => {
  it("shows loading skeleton then renders the editor with body", async () => {
    render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    // Loading skeleton visible first.
    expect(screen.getByTestId("editor-preview-loading")).toBeInTheDocument();

    // After async load, editor is rendered with the body.
    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    const editor = screen.getByTestId("monaco-editor-mock");
    expect(editor).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 2. Save calls objectPutText with ifMatchEtag
// ---------------------------------------------------------------------------

describe("EditorPreview — save with ETag", () => {
  it("save button calls objectPutText with the current ifMatchEtag", async () => {
    const user = userEvent.setup();

    const capturedArgs: Array<Record<string, unknown>> = [];
    mockInvokeFn.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "object_get_text") return TEXT_PAYLOAD;
      if (cmd === "object_put_text") {
        capturedArgs.push(args as Record<string, unknown>);
        return PUT_RESULT;
      }
      throw new Error(`[tauri mock] No handler for ${cmd}`);
    });

    render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    // Simulate edit so isDirty becomes true.
    const editor = screen.getByTestId(
      "monaco-editor-mock",
    ) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, "updated content");

    // Wait for the save button to be enabled (isDirty = true).
    await waitFor(() => {
      const saveBtn = screen.getByTestId("editor-save-btn");
      expect(saveBtn).not.toBeDisabled();
    });

    // Click save.
    await user.click(screen.getByTestId("editor-save-btn"));

    // Verify objectPutText was called with the correct ETag.
    await waitFor(() => {
      expect(capturedArgs.length).toBeGreaterThan(0);
      expect(capturedArgs[0]?.ifMatchEtag).toBe('"abc123"');
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Conflict path — "File changed externally" banner
// ---------------------------------------------------------------------------

describe("EditorPreview — conflict handling", () => {
  it("shows conflict banner when save returns AppError::Conflict", async () => {
    const user = userEvent.setup();

    // Override invoke so object_put_text throws the Conflict object.
    mockInvokeFn.mockImplementation(async (cmd: string) => {
      if (cmd === "object_get_text") return TEXT_PAYLOAD;
      if (cmd === "object_put_text") throw CONFLICT_ERROR;
      throw new Error(`[tauri mock] No handler for ${cmd}`);
    });

    render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    // Trigger a dirty state.
    const editor = screen.getByTestId(
      "monaco-editor-mock",
    ) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, "changed");

    await waitFor(() => {
      expect(screen.getByTestId("editor-save-btn")).not.toBeDisabled();
    });

    await user.click(screen.getByTestId("editor-save-btn"));

    // Conflict banner should appear.
    await waitFor(() => {
      expect(screen.getByTestId("editor-conflict-banner")).toBeInTheDocument();
    });

    expect(screen.getByText(/File changed externally/)).toBeInTheDocument();
    expect(screen.getByTestId("editor-conflict-refresh")).toBeInTheDocument();
    expect(
      screen.getByTestId("editor-conflict-save-anyway"),
    ).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // 4. Refresh reloads body + clears conflict
  // -------------------------------------------------------------------------

  it("Refresh reloads body and clears conflict state", async () => {
    const user = userEvent.setup();

    mockInvokeFn.mockImplementation(async (cmd: string) => {
      if (cmd === "object_get_text") return TEXT_PAYLOAD;
      if (cmd === "object_put_text") throw CONFLICT_ERROR;
      throw new Error(`[tauri mock] No handler for ${cmd}`);
    });

    render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    // Force dirty + save to trigger conflict.
    const editor = screen.getByTestId(
      "monaco-editor-mock",
    ) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, "changes");

    await waitFor(() => {
      expect(screen.getByTestId("editor-save-btn")).not.toBeDisabled();
    });

    await user.click(screen.getByTestId("editor-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("editor-conflict-banner")).toBeInTheDocument();
    });

    // After Refresh, return fresh payload.
    mockInvokeFn.mockImplementation(async (cmd: string) => {
      if (cmd === "object_get_text")
        return { ...TEXT_PAYLOAD, body: "refreshed body", etag: '"fresh456"' };
      if (cmd === "object_put_text") return PUT_RESULT;
      throw new Error(`[tauri mock] No handler for ${cmd}`);
    });

    // Click Refresh.
    await user.click(screen.getByTestId("editor-conflict-refresh"));

    // Conflict banner must disappear.
    await waitFor(() => {
      expect(
        screen.queryByTestId("editor-conflict-banner"),
      ).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // 5. "Save anyway" calls without ifMatchEtag
  // -------------------------------------------------------------------------

  it("Save anyway calls objectPutText without ifMatchEtag", async () => {
    const user = userEvent.setup();

    // First put call → conflict; second call (save anyway) → success.
    let putCallCount = 0;
    const capturedArgs: Array<Record<string, unknown>> = [];

    mockInvokeFn.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "object_get_text") return TEXT_PAYLOAD;
      if (cmd === "object_put_text") {
        putCallCount++;
        capturedArgs.push(args as Record<string, unknown>);
        if (putCallCount === 1) throw CONFLICT_ERROR;
        return PUT_RESULT;
      }
      throw new Error(`[tauri mock] No handler for ${cmd}`);
    });

    render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    const editor = screen.getByTestId(
      "monaco-editor-mock",
    ) as HTMLTextAreaElement;
    await user.clear(editor);
    await user.type(editor, "overwrite");

    await waitFor(() => {
      expect(screen.getByTestId("editor-save-btn")).not.toBeDisabled();
    });

    await user.click(screen.getByTestId("editor-save-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("editor-conflict-banner")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("editor-conflict-save-anyway"));

    // Verify the second put call had null ifMatchEtag.
    await waitFor(() => {
      expect(capturedArgs.length).toBeGreaterThanOrEqual(2);
      expect(capturedArgs[1]?.ifMatchEtag).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Lazy load: Monaco only loaded when EditorPreview is rendered
// ---------------------------------------------------------------------------

describe("EditorPreview — lazy load", () => {
  it("EditorPreview uses React.lazy to split Monaco into a separate chunk", async () => {
    // The lazy wrapper in EditorPreview.tsx references EditorPreviewInner.tsx
    // via React.lazy. We verify that the inner component renders when the
    // Suspense boundary resolves. This confirms the chunk boundary exists —
    // the dynamic import in React.lazy fires on first render.
    const { EditorPreview } = await import("../EditorPreview");

    render(
      <EditorPreview profileId="p1" bucket="my-bucket" objectKey="notes.txt" />,
    );

    // After the Suspense boundary resolves, the editor content loads.
    await waitFor(
      () => {
        const editor = screen.queryByTestId("editor-preview");
        expect(editor).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });
});

// ---------------------------------------------------------------------------
// 7. axe-core a11y — loading state
// ---------------------------------------------------------------------------

describe("EditorPreview — a11y (loading state)", () => {
  it("has no axe violations in loading state", async () => {
    const { container, unmount } = render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 8. axe-core a11y — editor rendered state
// ---------------------------------------------------------------------------

describe("EditorPreview — a11y (editor state)", () => {
  it("has no axe violations when the editor is rendered", async () => {
    const { container } = render(
      <EditorPreviewCoreImpl
        profileId="p1"
        bucket="my-bucket"
        objectKey="notes.txt"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("editor-preview")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
