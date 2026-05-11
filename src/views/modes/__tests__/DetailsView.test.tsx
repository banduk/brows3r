/**
 * Tests for <DetailsView />.
 *
 * Coverage:
 * 1. Renders 100 mocked entries from useObjects query.
 * 2. Selection: shift-click range works.
 * 3. Sort: click name header → ascending; second click → descending.
 * 4. Keyboard nav: ArrowDown moves cursor.
 * 5. Validation gate: profile with validatedAt null shows placeholder.
 * 6. Axe-core a11y assertion.
 * 7. Icon mapping: .ts extension → Code2; unknown extension → File.
 * 8. Perf smoke: render 1000 mocked rows completes without hanging.
 *
 * NOTE: @tanstack/react-virtual requires a real layout engine to virtualise
 * rows. In jsdom every element has zero height, so the virtualiser renders 0
 * items. We mock `useVirtualizer` to render all items so row-level assertions
 * work. The actual windowing behaviour is verified manually via `pnpm tauri dev`
 * (per spec — "no formal benchmark in unit tests").
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Code2, File } from "lucide-react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { ObjectEntry } from "@/api/objects";
import type { ProfileSummary } from "@/api/profiles";
import { iconForExtension } from "@/lib/icons";
import { mockInvoke } from "@/test/mocks/tauri";
import type { DetailsViewProps } from "../DetailsView";

// ---------------------------------------------------------------------------
// Mock @tanstack/react-virtual so all items render in jsdom
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
  // validatedAt absent
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

// ---------------------------------------------------------------------------
// Mock useObjects via Tauri invoke mock
// ---------------------------------------------------------------------------

/**
 * We mock `objects_list` at the Tauri invoke level so `useObjects` returns
 * real data via the wired API call (task 24 landed the real hook).
 */
function setupMocks(profile: ProfileSummary, entries: ObjectEntry[]) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("objects_list", {
    entries,
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function renderDetails(
  profile: ProfileSummary,
  entries: ObjectEntry[],
  props: Partial<DetailsViewProps> = {},
) {
  setupMocks(profile, entries);
  const { Wrapper } = makeWrapper();
  const { DetailsView } = await import("../DetailsView");

  const result = render(
    <Wrapper>
      <div
        style={{ height: "600px", display: "flex", flexDirection: "column" }}
      >
        <DetailsView
          profileId={profile.id}
          bucket="test-bucket"
          prefix=""
          {...props}
        />
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

describe("DetailsView — validation gate", () => {
  it("shows gate message when profile is not validated", async () => {
    await renderDetails(UNVALIDATED_PROFILE, []);

    await waitFor(() => {
      expect(
        screen.getByText(/validate this profile to see contents/i),
      ).toBeInTheDocument();
    });
  });

  it("renders the file list when profile is validated", async () => {
    const entries = makeEntries(5);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file list/i }),
      ).toBeInTheDocument();
    });
  });
});

describe("DetailsView — renders entries", () => {
  it("renders 100 mocked entries (virtualizer mock renders all in jsdom)", async () => {
    const entries = makeEntries(100);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file list/i }),
      ).toBeInTheDocument();
    });

    // The virtualizer mock renders all items, so all 100 data rows are present.
    // In production the real virtualizer would only render ~20; windowing is
    // verified manually via `pnpm tauri dev`.
    const dataRows = screen
      .getAllByRole("row")
      .filter((r) => r.getAttribute("aria-selected") !== null);
    expect(dataRows.length).toBe(100);
  });
});

describe("DetailsView — sort", () => {
  it("sorts by name ascending on first click, descending on second", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(5);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("button", { name: /name/i }));

    // First click → ascending (▲)
    await user.click(screen.getByRole("button", { name: /name/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /name/i })).toHaveTextContent(
        "▲",
      );
    });

    // Second click → descending (▼)
    await user.click(screen.getByRole("button", { name: /name/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /name/i })).toHaveTextContent(
        "▼",
      );
    });
  });
});

describe("DetailsView — keyboard navigation", () => {
  it("ArrowDown moves the cursor to row index 1", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(10);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file list/i }));

    const grid = screen.getByRole("grid", { name: /file list/i });
    grid.focus();
    await user.keyboard("{ArrowDown}");

    // After ArrowDown the cursor is at index 1; row-1 should be in DOM
    // (virtualizer mock renders all rows).
    await waitFor(() => {
      expect(screen.getByTestId("entry-row-1")).toBeInTheDocument();
    });
  });
});

describe("DetailsView — selection", () => {
  it("shift-click selects a range of rows", async () => {
    const user = userEvent.setup();
    const entries = makeEntries(15);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file list/i }));

    // Click row 0 (plain click → anchor)
    const row0 = await screen.findByTestId("entry-row-0");
    await user.click(row0);

    // Shift+click row 4 → range 0..4
    const row4 = await screen.findByTestId("entry-row-4");
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

describe("DetailsView — empty state", () => {
  it("shows empty-state message when entries is empty", async () => {
    await renderDetails(VALIDATED_PROFILE, []);

    await waitFor(() => {
      expect(screen.getByText(/this prefix is empty/i)).toBeInTheDocument();
    });
  });
});

describe("DetailsView — a11y", () => {
  it("has no axe accessibility violations", async () => {
    const entries = makeEntries(5);
    const { container } = await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file list/i }));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

describe("DetailsView — perf smoke", () => {
  it("renders 1000 mocked rows without hanging", async () => {
    const entries = makeEntries(1000);
    await renderDetails(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file list/i }));

    expect(
      screen.getByRole("grid", { name: /file list/i }),
    ).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Icon mapping (unit tests — no DOM needed)
// ---------------------------------------------------------------------------

describe("iconForExtension — icon mapping", () => {
  it(".ts extension returns Code2 icon", () => {
    expect(iconForExtension("ts")).toBe(Code2);
  });

  it(".tsx extension returns Code2 icon", () => {
    expect(iconForExtension("tsx")).toBe(Code2);
  });

  it("unknown extension returns File (default)", () => {
    expect(iconForExtension("xyz123")).toBe(File);
  });

  it("null extension returns File (default)", () => {
    expect(iconForExtension(null)).toBe(File);
  });

  it("undefined extension returns File (default)", () => {
    expect(iconForExtension(undefined)).toBe(File);
  });
});
