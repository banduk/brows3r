/**
 * Tests for <Recents /> sidebar panel and useRecentAutoTrack hook.
 *
 * - Shows 10 items by default; "Show all" reveals more.
 * - Clicking a row calls setLocation on the active pane.
 * - Validation gate: rows for unvalidated profiles are disabled.
 * - Auto-track: location changes trigger recentTrack via useRecentAutoTrack.
 * - Axe a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { RecentLocation } from "@/api/bookmarks";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke, mockInvokeFn } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetLocation = vi.fn();
vi.mock("@/store/panes", () => ({
  usePanesStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activePaneId: "main",
      setLocation: mockSetLocation,
      panes: [
        {
          id: "main",
          location: {
            profileId: "p1",
            bucket: "bucket-a",
            prefix: "folder/",
          },
          viewMode: "Details",
          selection: new Set(),
          treeExpanded: new Set(),
          columnPath: [],
          filter: "",
        },
      ],
    };
    return selector(state);
  },
}));

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeRecents(count: number): RecentLocation[] {
  return Array.from({ length: count }, (_, i) => ({
    profileId: "p1",
    bucket: "bucket-a",
    prefix: `folder-${i}/`,
    visitedAt: Date.now() - i * 1000,
  }));
}

const MOCK_PROFILES: ProfileSummary[] = [
  {
    id: "p1",
    displayName: "Production",
    source: "manual",
    validatedAt: Date.now() - 1_000,
    hasCompatFlags: false,
  },
  {
    id: "p2-unvalidated",
    displayName: "Dev",
    source: "manual",
    hasCompatFlags: false,
  },
];

const MOCK_UNVALIDATED_RECENTS: RecentLocation[] = [
  {
    profileId: "p2-unvalidated",
    bucket: "bucket-b",
    prefix: "x/",
    visitedAt: Date.now(),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderRecents(recents: RecentLocation[]) {
  const { Recents } = await import("@/views/sidebar/Recents");
  const client = makeClient();
  mockInvoke("recents_list", recents);
  mockInvoke("profiles_list", MOCK_PROFILES);

  const result = render(
    <QueryClientProvider client={client}>
      <Recents />
    </QueryClientProvider>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Recents sidebar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows 10 items by default when more exist", async () => {
    await renderRecents(makeRecents(15));

    await waitFor(() => screen.getByText("folder-0/"));

    const items = screen.getAllByRole("listitem");
    // Only 10 rows + no "Show all" yet
    expect(items.length).toBe(10);
    expect(screen.getByText(/Show all \(15\)/)).toBeInTheDocument();
  });

  it("Show all reveals all items", async () => {
    const user = userEvent.setup();
    await renderRecents(makeRecents(15));

    await waitFor(() => screen.getByText("folder-0/"));

    await user.click(screen.getByText(/Show all \(15\)/));

    const items = screen.getAllByRole("listitem");
    expect(items.length).toBe(15);
  });

  it("clicking a validated row calls setLocation", async () => {
    const user = userEvent.setup();
    await renderRecents(makeRecents(3));

    await waitFor(() => screen.getByText("folder-0/"));

    // Validated rows render as <button> elements (via the navigate button).
    // Wait for validation gate to resolve so the button appears.
    await waitFor(() => {
      // The nav button's text contains the label; getAllByRole("button") finds all buttons.
      // We need at least one button that is a nav button (has location text).
      const btns = screen.getAllByRole("button");
      const navBtn = btns.find((b) => b.textContent?.includes("folder-0/"));
      if (!navBtn)
        throw new Error(
          "Nav button not found — profile may not be validated yet",
        );
      return navBtn;
    });

    const navBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent?.includes("folder-0/"));
    expect(navBtn).toBeDefined();
    if (!navBtn) return;
    await user.click(navBtn);

    expect(mockSetLocation).toHaveBeenCalledWith("main", {
      profileId: "p1",
      bucket: "bucket-a",
      prefix: "folder-0/",
    });
  });

  it("unvalidated profile rows are disabled", async () => {
    await renderRecents(MOCK_UNVALIDATED_RECENTS);

    await waitFor(() => screen.getByText("x/"));

    const item = screen.getAllByRole("listitem")[0];
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  it("unvalidated rows show 'Validate to use' tooltip text", async () => {
    await renderRecents(MOCK_UNVALIDATED_RECENTS);

    await waitFor(() => screen.getByText("x/"));

    expect(screen.getByText("Validate to use")).toBeInTheDocument();
  });

  it("does not render Show all when <= 10 items", async () => {
    await renderRecents(makeRecents(5));

    await waitFor(() => screen.getByText("folder-0/"));

    expect(screen.queryByText(/Show all/)).not.toBeInTheDocument();
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderRecents(makeRecents(3));
    await waitFor(() => screen.getByText("folder-0/"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// useRecentAutoTrack
// ---------------------------------------------------------------------------

describe("useRecentAutoTrack auto-tracking", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("calls recent_track when the active pane location changes", async () => {
    const { useRecentAutoTrack } = await import("@/views/sidebar/Recents");
    mockInvoke("recent_track", undefined);
    mockInvoke("recents_list", []);

    const client = makeClient();

    function AutoTrackHarness() {
      useRecentAutoTrack();
      return null;
    }

    render(
      <QueryClientProvider client={client}>
        <AutoTrackHarness />
      </QueryClientProvider>,
    );

    // The hook fires on mount because the pane has a location set in the mock.
    // We verify that recent_track was invoked.
    await waitFor(() => {
      // mockInvokeFn tracks calls; we check it was called with recent_track.
      const calls = mockInvokeFn.mock.calls as [string, unknown][];
      const trackCall = calls.find(([cmd]) => cmd === "recent_track");
      expect(trackCall).toBeDefined();
      expect(trackCall?.[1]).toMatchObject({
        profileId: "p1",
        bucket: "bucket-a",
        prefix: "folder/",
      });
    });
  });
});
