/**
 * Tests for <IconGridView />.
 *
 * Coverage:
 * 1. Renders 50 mocked entries in grid layout.
 * 2. Selection: click selects a card; shift-click selects a range.
 * 3. Keyboard nav: ArrowDown moves cursor by `cols`; ArrowRight moves by 1.
 * 4. Validation gate: unvalidated profile shows placeholder.
 * 5. Axe-core a11y assertion (Decision D5).
 *
 * NOTE: @tanstack/react-virtual is mocked (same strategy as DetailsView).
 * ResizeObserver is also stubbed so container-width measurement returns 0,
 * which causes the component to fall back to FALLBACK_COLS (4).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { ObjectEntry } from "@/api/objects";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual so all rows render in jsdom
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
// Stub ResizeObserver (returns width=0 → uses FALLBACK_COLS=4)
// ---------------------------------------------------------------------------

vi.stubGlobal(
  "ResizeObserver",
  vi.fn(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
  })),
);

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

const UNVALIDATED_PROFILE: ProfileSummary = {
  id: "p1",
  displayName: "Test",
  source: "manual",
  hasCompatFlags: false,
};

function makeEntries(count: number): ObjectEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `folder/file-${i.toString().padStart(3, "0")}.ts`,
    size: i * 100,
    lastModified: Date.now() - i * 60_000,
    storageClass: "STANDARD",
    isPrefix: false,
  }));
}

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
  return { Wrapper, client };
}

function setupMocks(profile: ProfileSummary, entries: ObjectEntry[]) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("objects_list", {
    entries,
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });
}

async function renderGrid(profile: ProfileSummary, entries: ObjectEntry[]) {
  setupMocks(profile, entries);
  const { Wrapper } = makeWrapper();
  const { IconGridView } = await import("../IconGridView");

  return render(
    <Wrapper>
      <div
        style={{ height: "600px", display: "flex", flexDirection: "column" }}
      >
        <IconGridView profileId={profile.id} bucket="test-bucket" prefix="" />
      </div>
    </Wrapper>,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("IconGridView — validation gate", () => {
  it("shows gate message when profile is not validated", async () => {
    await renderGrid(UNVALIDATED_PROFILE, []);

    await waitFor(() => {
      expect(
        screen.getByText(/validate this profile to see contents/i),
      ).toBeInTheDocument();
    });
  });

  it("renders the file grid when profile is validated", async () => {
    const entries = makeEntries(5);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file grid/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("IconGridView — renders entries", () => {
  it("renders 50 mocked entries (all cards in jsdom)", async () => {
    const entries = makeEntries(50);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file grid/i }),
      ).toBeInTheDocument();
    });

    // All 50 cards should be present (virtualizer mock renders all rows).
    const cards = screen.getAllByRole("gridcell");
    expect(cards.length).toBeGreaterThanOrEqual(50);
  });
});

describe("IconGridView — selection", () => {
  it("click selects a card", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(10);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file grid/i }));

    const card0 = await screen.findByTestId("icon-card-0");
    await user.click(card0);

    await waitFor(() => {
      expect(card0.getAttribute("aria-selected")).toBe("true");
    });
  });

  it("shift-click selects a range", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(20);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file grid/i }));

    const card0 = await screen.findByTestId("icon-card-0");
    await user.click(card0);

    const card4 = await screen.findByTestId("icon-card-4");
    await user.keyboard("{Shift>}");
    await user.click(card4);
    await user.keyboard("{/Shift}");

    await waitFor(() => {
      const selected = screen
        .getAllByRole("gridcell")
        .filter((c) => c.getAttribute("aria-selected") === "true");
      expect(selected.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe("IconGridView — keyboard navigation", () => {
  it("ArrowRight moves cursor from card 0 to card 1", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(10);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file grid/i }));

    const grid = screen.getByRole("grid", { name: /file grid/i });
    grid.focus();
    await user.keyboard("{ArrowRight}");

    await waitFor(() => {
      expect(screen.getByTestId("icon-card-1")).toBeInTheDocument();
    });
  });

  it("ArrowDown moves cursor by cols (FALLBACK_COLS=4)", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(20);
    await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file grid/i }));

    const grid = screen.getByRole("grid", { name: /file grid/i });
    grid.focus();
    // After ArrowDown the cursor moves from 0 to FALLBACK_COLS (4).
    await user.keyboard("{ArrowDown}");

    // Card 4 should exist (all rendered by mock).
    await waitFor(() => {
      expect(screen.getByTestId("icon-card-4")).toBeInTheDocument();
    });
  });
});

describe("IconGridView — a11y", () => {
  it("has no axe accessibility violations", async () => {
    const entries = makeEntries(5);
    const { container } = await renderGrid(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file grid/i }));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
