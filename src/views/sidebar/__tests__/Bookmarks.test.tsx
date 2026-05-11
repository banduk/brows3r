/**
 * Tests for <Bookmarks /> sidebar panel.
 *
 * - Renders bookmark list from mock query.
 * - Clicking a row calls setLocation on the active pane.
 * - Validation gate: rows for unvalidated profiles are disabled.
 * - Axe a11y assertion.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import type { Bookmark } from "@/api/bookmarks";
import type { ProfileSummary } from "@/api/profiles";
import { mockInvoke } from "@/test/mocks/tauri";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock usePanesStore so we can inspect setLocation calls.
const mockSetLocation = vi.fn();
const mockSetSelection = vi.fn();
vi.mock("@/store/panes", () => ({
  usePanesStore: (selector: (s: unknown) => unknown) => {
    const state = {
      activePaneId: "main",
      setLocation: mockSetLocation,
      setSelection: mockSetSelection,
      // Provide enough shape for the active-row highlight selectors that
      // walk panes[].location / panes[].selection. The "active pane" never
      // matches any test bookmark, so isBookmarkActive returns false and
      // the highlight branch stays off.
      panes: [
        {
          id: "main",
          location: null,
          selection: new Set<string>(),
        },
      ],
    };
    return selector(state);
  },
}));

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const MOCK_BOOKMARKS: Bookmark[] = [
  {
    id: "bm-1",
    profileId: "p1",
    bucket: "bucket-a",
    prefix: "folder/",
    label: "My Folder",
    createdAt: 1_700_000_000_000,
  },
  {
    id: "bm-2",
    profileId: "p2-unvalidated",
    bucket: "bucket-b",
    prefix: "",
    label: "Unvalidated Profile Bookmark",
    createdAt: 1_700_000_001_000,
  },
];

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
    displayName: "Dev (unvalidated)",
    source: "manual",
    // no validatedAt
    hasCompatFlags: false,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderBookmarks() {
  const { Bookmarks } = await import("@/views/sidebar/Bookmarks");
  const client = makeClient();
  mockInvoke("bookmarks_list", MOCK_BOOKMARKS);
  mockInvoke("profiles_list", MOCK_PROFILES);

  const result = render(
    <QueryClientProvider client={client}>
      <Bookmarks />
    </QueryClientProvider>,
  );
  return result;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Bookmarks sidebar", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders bookmark list", async () => {
    await renderBookmarks();

    await waitFor(() => {
      expect(screen.getByText("My Folder")).toBeInTheDocument();
    });
    expect(
      screen.getByText("Unvalidated Profile Bookmark"),
    ).toBeInTheDocument();
  });

  it("clicking a validated bookmark calls setLocation", async () => {
    const user = userEvent.setup();
    await renderBookmarks();

    await waitFor(() => screen.getByText("My Folder"));

    // The validated row has a navigate button containing the label text.
    const navigateBtn = screen.getByText("My Folder").closest("button");
    expect(navigateBtn).toBeDefined();
    if (!navigateBtn) return;

    await user.click(navigateBtn);

    expect(mockSetLocation).toHaveBeenCalledWith("main", {
      profileId: "p1",
      bucket: "bucket-a",
      prefix: "folder/",
    });
  });

  it("unvalidated profile rows are disabled", async () => {
    await renderBookmarks();

    await waitFor(() => screen.getByText("Unvalidated Profile Bookmark"));

    // The unvalidated row has aria-disabled="true"
    const unvalidatedItem = screen
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("Unvalidated Profile Bookmark"));

    expect(unvalidatedItem).toBeDefined();
    expect(unvalidatedItem).toHaveAttribute("aria-disabled", "true");
  });

  it("unvalidated rows show 'Validate to use' tooltip text", async () => {
    await renderBookmarks();

    await waitFor(() => screen.getByText("Unvalidated Profile Bookmark"));

    const validateTexts = screen.getAllByText("Validate to use");
    expect(validateTexts.length).toBeGreaterThanOrEqual(1);
  });

  it("has no axe accessibility violations", async () => {
    const { container } = await renderBookmarks();
    await waitFor(() => screen.getByText("My Folder"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
