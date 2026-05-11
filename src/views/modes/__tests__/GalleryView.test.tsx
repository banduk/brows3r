/**
 * Tests for <GalleryView />.
 *
 * Coverage:
 * 1. Image entries get a placeholder element with data-testid="gallery-img-*".
 * 2. Non-image entries get FileIcon (no img element).
 * 3. Selection: click selects a tile.
 * 4. Axe-core a11y assertion (Decision D5).
 *
 * NOTE: @tanstack/react-virtual is mocked (same strategy as DetailsView).
 * ResizeObserver is stubbed returning width=0 → uses FALLBACK_COLS=3.
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
// Mock @tanstack/react-virtual
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

/** Build a mixed list: some image entries, some non-image. */
function makeEntries(): ObjectEntry[] {
  return [
    { key: "photo.png", size: 512_000, isPrefix: false },
    { key: "image.jpg", size: 1_024_000, isPrefix: false },
    { key: "README.md", size: 4_096, isPrefix: false },
    { key: "data.csv", size: 8_192, isPrefix: false },
    { key: "thumbnail.webp", size: 64_000, isPrefix: false },
  ];
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

function setupMocks(profile: ProfileSummary, entries: ObjectEntry[]) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("objects_list", {
    entries,
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });
}

async function renderGallery(profile: ProfileSummary, entries: ObjectEntry[]) {
  setupMocks(profile, entries);
  const { Wrapper } = makeWrapper();
  const { GalleryView } = await import("../GalleryView");

  return render(
    <Wrapper>
      <div
        style={{ height: "600px", display: "flex", flexDirection: "column" }}
      >
        <GalleryView profileId={profile.id} bucket="test-bucket" prefix="" />
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

describe("GalleryView — image entries", () => {
  it("image entries render a placeholder element (gallery-img-*)", async () => {
    const entries = makeEntries();
    await renderGallery(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file gallery/i }),
      ).toBeInTheDocument();
    });

    // Entries at index 0 (photo.png), 1 (image.jpg), 4 (thumbnail.webp) are images.
    await waitFor(() => {
      expect(screen.getByTestId("gallery-img-0")).toBeInTheDocument();
      expect(screen.getByTestId("gallery-img-1")).toBeInTheDocument();
      expect(screen.getByTestId("gallery-img-4")).toBeInTheDocument();
    });
  });

  it("non-image entries do NOT render gallery-img element", async () => {
    const entries = makeEntries();
    await renderGallery(VALIDATED_PROFILE, entries);

    await waitFor(() => {
      expect(
        screen.getByRole("grid", { name: /file gallery/i }),
      ).toBeInTheDocument();
    });

    // Indices 2 (README.md) and 3 (data.csv) are not image entries.
    await waitFor(() => {
      expect(screen.queryByTestId("gallery-img-2")).not.toBeInTheDocument();
      expect(screen.queryByTestId("gallery-img-3")).not.toBeInTheDocument();
    });
  });
});

describe("GalleryView — selection", () => {
  it("click selects a tile", async () => {
    const user = userEvent.setup();
    const entries = makeEntries();
    await renderGallery(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file gallery/i }));

    const tile0 = await screen.findByTestId("gallery-tile-0");
    await user.click(tile0);

    await waitFor(() => {
      expect(tile0.getAttribute("aria-selected")).toBe("true");
    });
  });
});

describe("GalleryView — a11y", () => {
  it("has no axe accessibility violations", async () => {
    const entries = makeEntries();
    const { container } = await renderGallery(VALIDATED_PROFILE, entries);

    await waitFor(() => screen.getByRole("grid", { name: /file gallery/i }));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
