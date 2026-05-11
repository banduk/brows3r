/**
 * Tests for the two discoverability paths owned by task 45.
 *
 * Path 1: Selection-details Inspect link in DetailsView opens the inspector.
 * Path 2: Cmd+I shortcut triggers `view.inspect` command which opens the
 *         inspector.
 *
 * (Toolbar + context-menu paths are tested in their respective task files.)
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectEntry } from "@/api/objects";
import type { ProfileSummary } from "@/api/profiles";
import { registry } from "@/commands/registry";
import { useInspectorStore } from "@/store/inspector";
import { usePanesStore } from "@/store/panes";
import { mockInvoke } from "@/test/mocks/tauri";
// Importing Toolbar causes `view.inspect` to be registered as a module side-effect.
import "@/views/browser/Toolbar";
import { useInspectorShortcut } from "@/views/shell/useInspectorShortcut";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual (DetailsView uses it)
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({
    count,
    estimateSize,
  }: {
    count: number;
    estimateSize: () => number;
    getScrollElement: () => Element | null;
    overscan?: number;
  }) => {
    const rowHeight = estimateSize();
    const virtualItems = Array.from({ length: count }, (_, i) => ({
      key: i,
      index: i,
      start: i * rowHeight,
      end: (i + 1) * rowHeight,
      size: rowHeight,
    }));
    return {
      getVirtualItems: () => virtualItems,
      getTotalSize: () => count * rowHeight,
      measureElement: () => undefined,
    };
  },
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: Date.now() - 1_000,
};

function makeEntries(count: number): ObjectEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `file-${i.toString().padStart(3, "0")}.txt`,
    size: i * 100,
    lastModified: Date.now() - i * 60_000,
    storageClass: "STANDARD",
    isPrefix: false,
  }));
}

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
  return { Wrapper };
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

beforeEach(() => {
  useInspectorStore.setState({ open: false, target: null });
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: { profileId: "p1", bucket: "my-bucket", prefix: "" },
        viewMode: "Details",
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Path 1: Selection-details Inspect link
// ---------------------------------------------------------------------------

describe("Discoverability — selection-details Inspect link", () => {
  it("Inspect link is visible when rows are selected", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(5);
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("objects_list", {
      entries,
      commonPrefixes: [],
      isTruncated: false,
      prefix: "",
    });

    const { Wrapper } = makeWrapper();
    const { DetailsView } = await import("@/views/modes/DetailsView");

    render(
      <Wrapper>
        <div
          style={{ height: "600px", display: "flex", flexDirection: "column" }}
        >
          <DetailsView profileId="p1" bucket="my-bucket" prefix="" />
        </div>
      </Wrapper>,
    );

    // Wait for rows to render then click one to select it.
    await waitFor(() => screen.getByTestId("entry-row-0"));
    await user.click(screen.getByTestId("entry-row-0"));

    // The selection summary with the inspect link should appear.
    await waitFor(() => {
      expect(screen.getByTestId("selection-inspect-link")).toBeInTheDocument();
    });
  });

  it("clicking the Inspect link opens the inspector", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(5);
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("objects_list", {
      entries,
      commonPrefixes: [],
      isTruncated: false,
      prefix: "",
    });

    const { Wrapper } = makeWrapper();
    const { DetailsView } = await import("@/views/modes/DetailsView");

    render(
      <Wrapper>
        <div
          style={{ height: "600px", display: "flex", flexDirection: "column" }}
        >
          <DetailsView profileId="p1" bucket="my-bucket" prefix="" />
        </div>
      </Wrapper>,
    );

    await waitFor(() => screen.getByTestId("entry-row-0"));
    await user.click(screen.getByTestId("entry-row-0"));

    await waitFor(() =>
      expect(screen.getByTestId("selection-inspect-link")).toBeInTheDocument(),
    );

    await user.click(screen.getByTestId("selection-inspect-link"));

    await waitFor(() => {
      const { open, target } = useInspectorStore.getState();
      expect(open).toBe(true);
      expect(target?.profileId).toBe("p1");
      expect(target?.bucket).toBe("my-bucket");
    });
  });

  it("Inspect link is hidden when nothing is selected", async () => {
    const entries = makeEntries(5);
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("objects_list", {
      entries,
      commonPrefixes: [],
      isTruncated: false,
      prefix: "",
    });

    const { Wrapper } = makeWrapper();
    const { DetailsView } = await import("@/views/modes/DetailsView");

    render(
      <Wrapper>
        <div
          style={{ height: "600px", display: "flex", flexDirection: "column" }}
        >
          <DetailsView profileId="p1" bucket="my-bucket" prefix="" />
        </div>
      </Wrapper>,
    );

    await waitFor(() => screen.getByRole("grid", { name: /file list/i }));

    expect(
      screen.queryByTestId("selection-inspect-link"),
    ).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Path 2: Cmd+I shortcut
// ---------------------------------------------------------------------------

/**
 * A simple test component that mounts the inspector shortcut hook and renders
 * nothing else, so we can test the keyboard wiring in isolation.
 */
function ShortcutHarness() {
  useInspectorShortcut();
  return null;
}

describe("Discoverability — Cmd+I keyboard shortcut", () => {
  it("Cmd+I (macOS) triggers the view.inspect command and opens inspector", () => {
    // Set a Mac platform so the hook uses metaKey.
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });

    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <ShortcutHarness />
      </Wrapper>,
    );

    // Ensure view.inspect is registered (by Toolbar.tsx module at import time).
    const cmd = registry.lookupById("view.inspect");
    expect(cmd).toBeDefined();

    // Fire metaKey+i on the window.
    fireEvent.keyDown(window, { key: "i", metaKey: true });

    // The command's run opened the inspector for the active pane.
    // (usePanesStore has a bucket in the beforeEach above.)
    expect(useInspectorStore.getState().open).toBe(true);

    // Restore platform.
    Object.defineProperty(navigator, "platform", {
      value: "",
      configurable: true,
    });
  });

  it("Ctrl+I triggers the view.inspect command (non-mac)", () => {
    // Simulate a non-Mac platform (jsdom default is "").
    const { Wrapper } = makeWrapper();
    render(
      <Wrapper>
        <ShortcutHarness />
      </Wrapper>,
    );

    const cmd = registry.lookupById("view.inspect");
    expect(cmd).toBeDefined();

    fireEvent.keyDown(window, { key: "i", ctrlKey: true });
    expect(useInspectorStore.getState().open).toBe(true);
  });
});
