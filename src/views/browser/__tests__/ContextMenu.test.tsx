/**
 * Tests for <FileContextMenu />.
 *
 * Coverage:
 * 1. Right-click opens menu with correct items.
 * 2. Disabled state: items in blockedActions appear as disabled when a lock exists.
 * 3. AC-4: after lock release, previously-disabled items become enabled.
 * 4. "Copy Presigned URL" calls objectPresign + writeText (mocked).
 * 5. Keyboard nav: Escape closes the menu (Radix handles natively; smoke-test).
 * 6. Axe-core a11y on opened menu.
 * 7. Items disabled when no selection.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { useLocksStore } from "@/store/locks";
import { mockInvoke } from "@/test/mocks/tauri";
// Import to trigger command registration side-effects.
import "@/commands/definitions/file";
import { FileContextMenu } from "../ContextMenu";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock writeText so we can assert it was called.
const mockWriteText = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/clipboard", () => ({
  writeText: (...args: unknown[]) => mockWriteText(...args),
  writeFiles: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Wrapper
// ---------------------------------------------------------------------------

function makeWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }
  return { Wrapper, client };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CTX = {
  profileId: "p1",
  bucket: "my-bucket",
  prefix: "photos/",
  keys: ["photos/cat.jpg"],
};

function renderMenu(ctx = BASE_CTX) {
  const { Wrapper } = makeWrapper();
  return render(
    <Wrapper>
      <FileContextMenu ctx={ctx}>
        <div data-testid="trigger-area">right-click here</div>
      </FileContextMenu>
    </Wrapper>,
  );
}

/** Fire a contextmenu event on the trigger area to open the menu. */
function openMenu() {
  const trigger = screen.getByTestId("trigger-area");
  fireEvent.contextMenu(trigger);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  useLocksStore.getState().clearAll();
  mockWriteText.mockClear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  useLocksStore.getState().clearAll();
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

describe("FileContextMenu — rendering", () => {
  it("renders children without a visible menu initially", () => {
    renderMenu();
    expect(screen.getByTestId("trigger-area")).toBeInTheDocument();
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("right-click opens the context menu", async () => {
    renderMenu();
    openMenu();
    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });
  });

  it("shows Download item in the menu", async () => {
    // Replaces the old "shows Copy" expectation — `file.copy` was
    // hidden from the right-click menu in v0.2.6 because its underlying
    // clipboard handler is not implemented. `file.download` covers the
    // primary "get this file off S3" workflow users were trying to use
    // Copy for.
    renderMenu();
    openMenu();
    await waitFor(() => {
      expect(screen.getByText("Download")).toBeInTheDocument();
    });
  });

  it("shows Delete item in the menu", async () => {
    renderMenu();
    openMenu();
    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
  });

  it("shows Copy Presigned URL item in the menu", async () => {
    renderMenu();
    openMenu();
    await waitFor(() => {
      expect(screen.getByText("Copy Presigned URL")).toBeInTheDocument();
    });
  });

  it("shows Refresh item in the menu", async () => {
    renderMenu();
    openMenu();
    await waitFor(() => {
      expect(screen.getByText("Refresh")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Disabled state when no selection
// ---------------------------------------------------------------------------

describe("FileContextMenu — disabled state with no selection", () => {
  it("Copy Presigned URL is disabled when no keys are selected", async () => {
    renderMenu({ ...BASE_CTX, keys: [] });
    openMenu();
    await waitFor(() => {
      const item = screen.getByText("Copy Presigned URL");
      expect(
        item.closest("[data-disabled]") ??
          item.closest("[aria-disabled='true']") ??
          item,
      ).toHaveAttribute("data-disabled");
    });
  });
});

// ---------------------------------------------------------------------------
// Lock-aware gating
// ---------------------------------------------------------------------------

describe("FileContextMenu — lock-aware gating", () => {
  it("file.delete is disabled when an upload lock is held on the same scope", async () => {
    act(() => {
      useLocksStore.getState().addLock({
        lockId: "upload-1",
        resource: "p1/my-bucket/photos/",
        opName: "upload",
      });
    });

    renderMenu();
    openMenu();

    await waitFor(() => {
      const deleteItem = screen.getByText("Delete");
      const el =
        deleteItem.closest("[data-disabled]") ??
        deleteItem.closest("[aria-disabled='true']");
      expect(el).not.toBeNull();
    });
  });

  it("AC-4: after lock release, Delete item becomes enabled", async () => {
    act(() => {
      useLocksStore.getState().addLock({
        lockId: "upload-1",
        resource: "p1/my-bucket/photos/",
        opName: "upload",
      });
    });

    renderMenu();
    openMenu();

    // Verify it starts disabled.
    await waitFor(() => {
      const deleteItem = screen.getByText("Delete");
      const el =
        deleteItem.closest("[data-disabled]") ??
        deleteItem.closest("[aria-disabled='true']");
      expect(el).not.toBeNull();
    });

    // Release the lock.
    act(() => {
      useLocksStore.getState().removeLock("upload-1");
    });

    // After release, should no longer be disabled.
    await waitFor(() => {
      const deleteItem = screen.getByText("Delete");
      const disabledEl =
        deleteItem.closest("[data-disabled]") ??
        deleteItem.closest("[aria-disabled='true']");
      expect(disabledEl).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Copy Presigned URL action
// ---------------------------------------------------------------------------

describe("FileContextMenu — Copy Presigned URL action", () => {
  it("calls objectPresign and writeText on click", async () => {
    const user = userEvent.setup();
    mockInvoke("object_presign", {
      url: "https://s3.example.com/presigned?X-Amz-Signature=abc",
      expiresAt: Date.now() + 3600_000,
    });

    renderMenu();
    openMenu();

    await waitFor(() => {
      expect(screen.getByText("Copy Presigned URL")).toBeInTheDocument();
    });

    await user.click(screen.getByText("Copy Presigned URL"));

    await waitFor(() => {
      expect(mockWriteText).toHaveBeenCalledWith(
        "https://s3.example.com/presigned?X-Amz-Signature=abc",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Keyboard navigation (smoke)
// ---------------------------------------------------------------------------

describe("FileContextMenu — keyboard navigation", () => {
  it("pressing Escape closes the menu", async () => {
    const user = userEvent.setup();
    renderMenu();
    openMenu();

    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Accessibility
// ---------------------------------------------------------------------------

describe("FileContextMenu — a11y", () => {
  it("opened menu has no axe violations", async () => {
    const { container } = renderMenu();
    openMenu();

    await waitFor(() => {
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
