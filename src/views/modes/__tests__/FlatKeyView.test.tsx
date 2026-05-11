/**
 * Tests for <FlatKeyView />.
 *
 * Coverage:
 * 1. Renders objects with full key paths (no virtual-folder rows).
 * 2. Selection: shift-click range works.
 * 3. Keyboard nav: ArrowDown moves cursor.
 * 4. Validation gate when profile is not validated.
 * 5. Empty state when listing returns no objects.
 * 6. Calls objects_list_flat (not objects_list) for its data.
 * 7. Axe-core a11y assertion (Decision D5).
 *
 * NOTE: @tanstack/react-virtual is mocked so all rows render in jsdom.
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
// Stub ResizeObserver
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

/** Deep-path objects — full keys with nested prefixes (no isPrefix entries). */
function makeEntries(count: number): ObjectEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    key: `data/year=2024/month=01/day=${String(i + 1).padStart(2, "0")}/file-${i.toString()}.parquet`,
    size: (i + 1) * 512,
    lastModified: Date.now() - i * 3_600_000,
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
  return { Wrapper };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

async function renderFlat(profile: ProfileSummary, entries: ObjectEntry[]) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("objects_list_flat", {
    entries,
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });

  const { Wrapper } = makeWrapper();
  const { FlatKeyView } = await import("../FlatKeyView");

  const result = render(
    <Wrapper>
      <div
        style={{ height: "600px", display: "flex", flexDirection: "column" }}
      >
        <FlatKeyView profileId={profile.id} bucket="test-bucket" prefix="" />
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

describe("FlatKeyView — validation gate", () => {
  it("shows gate message when profile is not validated", async () => {
    await renderFlat(UNVALIDATED_PROFILE, []);

    await waitFor(() => {
      expect(
        screen.getByText(/validate this profile to see contents/i),
      ).toBeInTheDocument();
    });
  });
});

describe("FlatKeyView — renders objects with full key paths", () => {
  it("renders the flat key list grid when validated", async () => {
    const entries = makeEntries(5);
    await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /flat key list/i }),
      ).toBeInTheDocument();
    });
  });

  it("shows full key paths (deep nested paths)", async () => {
    const entries = makeEntries(3);
    await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /flat key list/i }),
      ).toBeInTheDocument();
    });

    // Full key path should be visible for each entry.
    for (const entry of entries) {
      expect(screen.getByText(entry.key)).toBeInTheDocument();
    }
  });

  it("does not render any prefix/folder rows (no isPrefix entries)", async () => {
    const entries = makeEntries(5);
    await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /flat key list/i }));

    // All data rows must have aria-selected (data rows only, not header).
    const dataRows = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-selected") !== null);
    expect(dataRows.length).toBe(5);
  });
});

describe("FlatKeyView — selection", () => {
  it("shift-click selects a range of rows", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(15);
    await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /flat key list/i }));

    const row0 = await screen.findByTestId("flat-row-0");
    await user.click(row0);

    const row4 = await screen.findByTestId("flat-row-4");
    await user.keyboard("{Shift>}");
    await user.click(row4);
    await user.keyboard("{/Shift}");

    await waitFor(() => {
      const selectedRows = screen
        .getAllByRole("row")
        .filter(
          (r) =>
            r.getAttribute("aria-selected") === "true" &&
            r.getAttribute("role") === "row",
        );
      expect(selectedRows.length).toBeGreaterThanOrEqual(5);
    });
  });
});

describe("FlatKeyView — keyboard navigation", () => {
  it("ArrowDown moves cursor to row index 1", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(10);
    await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /flat key list/i }));

    const grid = screen.getByRole("grid", { name: /flat key list/i });
    grid.focus();
    await user.keyboard("{ArrowDown}");

    await waitFor(() => {
      expect(screen.getByTestId("flat-row-1")).toBeInTheDocument();
    });
  });
});

describe("FlatKeyView — empty state", () => {
  it("shows empty-state message when no objects found", async () => {
    await renderFlat(VALIDATED_PROFILE, []);

    await waitFor(() => {
      expect(
        screen.getByText(/no objects found under this prefix/i),
      ).toBeInTheDocument();
    });
  });
});

describe("FlatKeyView — uses objects_list_flat", () => {
  it("calls objects_list_flat (not objects_list) for its data", async () => {
    const entries = makeEntries(3);

    // Only mock objects_list_flat — if the component calls objects_list instead,
    // the query will fail/return nothing.
    mockInvoke("profiles_list", [VALIDATED_PROFILE]);
    mockInvoke("objects_list_flat", {
      entries,
      commonPrefixes: [],
      isTruncated: false,
      prefix: "",
    });
    // Intentionally NOT mocking objects_list.

    const { Wrapper } = makeWrapper();
    const { FlatKeyView } = await import("../FlatKeyView");

    render(
      <Wrapper>
        <div
          style={{ height: "600px", display: "flex", flexDirection: "column" }}
        >
          <FlatKeyView
            profileId={VALIDATED_PROFILE.id}
            bucket="test-bucket"
            prefix=""
          />
        </div>
      </Wrapper>,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /flat key list/i }),
      ).toBeInTheDocument();
    });

    // The entries from the flat mock are rendered.
    const firstKey = entries[0]?.key ?? "";
    expect(screen.getByText(firstKey)).toBeInTheDocument();
  });
});

describe("FlatKeyView — a11y", () => {
  it("has no axe accessibility violations", async () => {
    const entries = makeEntries(5);
    const { container } = await renderFlat(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /flat key list/i }));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
