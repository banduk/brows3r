/**
 * Tests for <Breadcrumb />.
 *
 * Coverage:
 * 1. Segment click → navigates to that prefix.
 * 2. Long path → ellipsis shown between bucket and last segments.
 * 3. Edit mode → Cmd+L shows input; Enter parses and navigates.
 * 4. Escape exits edit mode without navigating.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render as rtlRender, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePanesStore } from "@/store/panes";
import type { S3Location } from "@/store/ui";
import { Breadcrumb } from "../Breadcrumb";

// Breadcrumb consults useProfilesList (TanStack Query) to resolve the
// profile display name. Wrap every render in a fresh QueryClientProvider.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

// Reset the panes store state before each test.
beforeEach(() => {
  usePanesStore.setState({
    panes: [
      {
        id: "main",
        location: null,
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
// Helpers
// ---------------------------------------------------------------------------

const BASE_LOCATION: S3Location = {
  profileId: "p1",
  bucket: "my-bucket",
  prefix: "folder/subfolder/",
};

function renderBreadcrumb(location: S3Location | null = BASE_LOCATION) {
  return render(
    <Breadcrumb paneId="main" location={location} profileDisplayName="Prod" />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Breadcrumb — segment click", () => {
  it("navigates to the bucket root when bucket segment is clicked", async () => {
    renderBreadcrumb();
    const bucketBtn = screen.getByRole("button", { name: "my-bucket" });
    await userEvent.click(bucketBtn);

    const { panes } = usePanesStore.getState();
    const main = panes.find((p) => p.id === "main");
    expect(main?.location?.bucket).toBe("my-bucket");
    expect(main?.location?.prefix).toBe("");
  });

  it("navigates to the parent prefix when an intermediate segment is clicked", async () => {
    renderBreadcrumb();
    const folderBtn = screen.getByRole("button", { name: "folder" });
    await userEvent.click(folderBtn);

    const { panes } = usePanesStore.getState();
    const main = panes.find((p) => p.id === "main");
    expect(main?.location?.prefix).toBe("folder/");
  });

  it("marks the last segment with aria-current=page", () => {
    renderBreadcrumb();
    const last = screen.getByRole("button", { name: "subfolder" });
    expect(last).toHaveAttribute("aria-current", "page");
  });
});

describe("Breadcrumb — collapsed state", () => {
  it("shows ellipsis for paths longer than 4 segments", () => {
    const longLocation: S3Location = {
      profileId: "p1",
      bucket: "my-bucket",
      prefix: "a/b/c/d/",
    };
    renderBreadcrumb(longLocation);
    expect(screen.getByText("…")).toBeInTheDocument();
  });

  it("does not show ellipsis for short paths", () => {
    renderBreadcrumb(BASE_LOCATION); // 4 segments: Prod > my-bucket > folder > subfolder
    expect(screen.queryByText("…")).not.toBeInTheDocument();
  });
});

describe("Breadcrumb — edit mode", () => {
  it("shows input when Cmd+L is pressed", async () => {
    renderBreadcrumb();
    await userEvent.keyboard("{Meta>}l{/Meta}");
    expect(
      screen.getByRole("textbox", { name: "Navigate to path" }),
    ).toBeInTheDocument();
  });

  it("navigates when Enter is pressed in edit mode", async () => {
    renderBreadcrumb();
    await userEvent.keyboard("{Meta>}l{/Meta}");
    const input = screen.getByRole("textbox", { name: "Navigate to path" });

    await userEvent.clear(input);
    await userEvent.type(input, "other-bucket/new-folder/");
    await userEvent.keyboard("{Enter}");

    const { panes } = usePanesStore.getState();
    const main = panes.find((p) => p.id === "main");
    expect(main?.location?.bucket).toBe("other-bucket");
    expect(main?.location?.prefix).toBe("new-folder/");
  });

  it("exits edit mode without navigating when Escape is pressed", async () => {
    renderBreadcrumb();
    const before = usePanesStore
      .getState()
      .panes.find((p) => p.id === "main")?.location;

    await userEvent.keyboard("{Meta>}l{/Meta}");
    const input = screen.getByRole("textbox", { name: "Navigate to path" });
    await userEvent.clear(input);
    await userEvent.type(input, "different-bucket");
    await userEvent.keyboard("{Escape}");

    // Input should be gone.
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    // Location should be unchanged.
    const after = usePanesStore
      .getState()
      .panes.find((p) => p.id === "main")?.location;
    expect(after).toEqual(before);
  });
});
