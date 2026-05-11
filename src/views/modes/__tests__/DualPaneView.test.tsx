/**
 * Tests for <DualPaneView />.
 *
 * Coverage:
 * 1. Renders two independent panes side by side.
 * 2. Clicking in the left pane sets it as active (border highlight).
 * 3. Clicking in the right pane sets it as active.
 * 4. Tab key switches the active pane between left and right.
 * 5. Each pane shows its own location label (independent state).
 * 6. The pane containers have `data-pane-id` attributes for DnD targeting.
 * 7. Axe-core a11y assertion (Decision D5).
 *
 * NOTE: The Zustand panes store is reset between tests by direct setState.
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
import { axe } from "vitest-axe";
import type { ProfileSummary } from "@/api/profiles";
import { usePanesStore } from "@/store/panes";
import type { S3Location } from "@/store/ui";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual (DualPaneView embeds DetailsView)
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

const LEFT_LOCATION: S3Location = {
  profileId: "p1",
  bucket: "left-bucket",
  prefix: "folder-a/",
};

const RIGHT_LOCATION: S3Location = {
  profileId: "p2",
  bucket: "right-bucket",
  prefix: "folder-b/",
};

const VALIDATED_PROFILE_P1: ProfileSummary = {
  id: "p1",
  displayName: "Left Profile",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: Date.now() - 1_000,
};

const VALIDATED_PROFILE_P2: ProfileSummary = {
  id: "p2",
  displayName: "Right Profile",
  source: "manual",
  hasCompatFlags: false,
  validatedAt: Date.now() - 1_000,
};

// ---------------------------------------------------------------------------
// Test wrapper
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

function setupMocks() {
  mockInvoke("profiles_list", [VALIDATED_PROFILE_P1, VALIDATED_PROFILE_P2]);
  mockInvoke("objects_list", {
    entries: [],
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });
}

/**
 * Reset the Zustand store to a clean two-pane state.
 */
function setupTwoPanes() {
  // Reset to a single initial pane with LEFT location.
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: LEFT_LOCATION,
        viewMode: "Details",
        selection: new Set(),
        treeExpanded: new Set(),
        columnPath: [],
        filter: "",
      },
    ],
    activePaneId: "main",
  });
  // Split to create the second pane (inherits LEFT_LOCATION initially).
  usePanesStore.getState().splitPane();
  // Override second pane's location to RIGHT_LOCATION.
  const { panes } = usePanesStore.getState();
  const secondPane = panes[1];
  if (secondPane) {
    usePanesStore.getState().setLocation(secondPane.id, RIGHT_LOCATION);
  }
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderDualPane() {
  setupMocks();
  const { Wrapper } = makeWrapper();
  const { DualPaneView } = await import("../DualPaneView");

  const result = render(
    <Wrapper>
      <div style={{ height: "600px", display: "flex" }}>
        <DualPaneView />
      </div>
    </Wrapper>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("DualPaneView — renders two panes", () => {
  beforeEach(setupTwoPanes);

  it("shows two pane containers", async () => {
    await renderDualPane();

    await waitFor(() => {
      expect(screen.getByTestId("dual-pane-view")).toBeInTheDocument();
    });

    const { panes } = usePanesStore.getState();
    expect(panes.length).toBe(2);

    for (const pane of panes) {
      expect(screen.getByTestId(`dual-pane-${pane.id}`)).toBeInTheDocument();
    }
  });

  it("each pane has data-pane-id attribute for DnD targeting", async () => {
    await renderDualPane();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    const { panes } = usePanesStore.getState();
    for (const pane of panes) {
      const el = screen.getByTestId(`dual-pane-${pane.id}`);
      expect(el.getAttribute("data-pane-id")).toBe(pane.id);
    }
  });
});

describe("DualPaneView — independent pane state", () => {
  beforeEach(setupTwoPanes);

  it("each pane shows its own location label", async () => {
    await renderDualPane();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    const { panes } = usePanesStore.getState();
    expect(panes.length).toBe(2);

    // Each pane toolbar shows the profile of its own location.
    const mainPane = panes.find((p) => p.id === "main");
    const secondPane = panes.find((p) => p.id !== "main");

    expect(mainPane).toBeTruthy();
    expect(secondPane).toBeTruthy();

    // The left pane shows LEFT_LOCATION profile.
    const leftToolbar = screen.getByTestId(`pane-profile-${mainPane?.id}`);
    expect(leftToolbar.textContent).toContain(LEFT_LOCATION.profileId);

    // The right pane shows RIGHT_LOCATION profile.
    const rightToolbar = screen.getByTestId(`pane-profile-${secondPane?.id}`);
    expect(rightToolbar.textContent).toContain(RIGHT_LOCATION.profileId);
  });

  it("clicking in left pane does not affect right pane location", async () => {
    await renderDualPane();
    const user = userEvent.setup();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    const { panes } = usePanesStore.getState();
    const secondPane = panes.find((p) => p.id !== "main");
    expect(secondPane).toBeTruthy();

    // Record the right pane location before clicking left.
    const rightLocationBefore = secondPane?.location;

    // Click the left pane toolbar (avoid clicking inner DetailsView which
    // has its own interaction logic).
    const leftPaneEl = screen.getByTestId(`pane-profile-${panes[0]?.id}`);
    await user.click(leftPaneEl);

    // Right pane location unchanged.
    const { panes: panesAfter } = usePanesStore.getState();
    const rightPaneAfter = panesAfter.find((p) => p.id !== "main");
    expect(rightPaneAfter?.location).toEqual(rightLocationBefore);
  });
});

describe("DualPaneView — active pane switching", () => {
  beforeEach(setupTwoPanes);

  it("clicking a pane sets it as active", async () => {
    await renderDualPane();
    const user = userEvent.setup();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    const { panes } = usePanesStore.getState();
    const secondPane = panes.find((p) => p.id !== "main");
    expect(secondPane).toBeTruthy();

    // Click the second pane's toolbar (focus event sets active).
    const secondPaneEl = screen.getByTestId(`dual-pane-${secondPane?.id}`);
    await user.click(secondPaneEl);

    await waitFor(() => {
      const { activePaneId } = usePanesStore.getState();
      expect(activePaneId).toBe(secondPane?.id);
    });
  });

  it("Tab key switches the active pane", async () => {
    await renderDualPane();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    // Ensure left pane (main) is active initially.
    usePanesStore.getState().setActivePane("main");

    // Fire a keydown Tab event directly on the outer container.
    // userEvent.keyboard("{Tab}" moves browser focus to the next focusable
    // element in JSDOM, so we use fireEvent to exercise the custom handler.
    const viewEl = screen.getByTestId("dual-pane-view");
    fireEvent.keyDown(viewEl, { key: "Tab", code: "Tab" });

    const { activePaneId, panes } = usePanesStore.getState();
    // Should have switched to the second pane.
    const secondPane = panes.find((p) => p.id !== "main");
    expect(activePaneId).toBe(secondPane?.id);
  });
});

describe("DualPaneView — a11y", () => {
  beforeEach(setupTwoPanes);

  it("has no axe accessibility violations", async () => {
    const { container } = await renderDualPane();

    await waitFor(() => screen.getByTestId("dual-pane-view"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
