/**
 * Tests for <ColumnView />.
 *
 * Coverage:
 * 1. Root column renders entries from root prefix.
 * 2. Clicking a folder entry calls onColumnPathChange with the folder appended.
 * 3. Clicking in a parent column truncates deeper columns (resets deeper path).
 * 4. Clicking a file calls onOpen and truncates deeper columns.
 * 5. Validation gate when profile is not validated.
 * 6. Axe-core a11y assertion (Decision D5).
 *
 * Design rule (design.md §View Modes And Selection):
 * - Clicking in a parent column → resets all deeper columns; selection becomes
 *   the clicked entry.
 * - Clicking the same column again → no reset.
 *
 * NOTE: ColumnView does not use Virtualized; each column is a plain scrollable
 * list. @tanstack/react-virtual is NOT mocked here.
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
import type { ColumnViewProps } from "../ColumnView";

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

const ROOT_ENTRIES: ObjectEntry[] = [
  { key: "docs/", size: 0, isPrefix: true },
  { key: "readme.md", size: 1024, isPrefix: false },
  { key: "src/", size: 0, isPrefix: true },
];

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

async function renderColumn(
  profile: ProfileSummary,
  props: Partial<ColumnViewProps> = {},
) {
  mockInvoke("profiles_list", [profile]);
  mockInvoke("objects_list", {
    entries: ROOT_ENTRIES,
    commonPrefixes: [],
    isTruncated: false,
    prefix: "",
  });

  const { Wrapper } = makeWrapper();
  const { ColumnView } = await import("../ColumnView");

  const onColumnPathChange = props.onColumnPathChange ?? vi.fn();
  const onOpen = props.onOpen ?? vi.fn();

  const result = render(
    <Wrapper>
      <div style={{ height: "600px", display: "flex" }}>
        <ColumnView
          profileId={profile.id}
          bucket="test-bucket"
          prefix=""
          columnPath={props.columnPath ?? []}
          onColumnPathChange={onColumnPathChange}
          onOpen={onOpen}
          onValidateProfile={props.onValidateProfile}
        />
      </div>
    </Wrapper>,
  );
  return { ...result, onColumnPathChange, onOpen };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ColumnView — root column", () => {
  it("renders the root column panel (column-panel-0)", async () => {
    await renderColumn(VALIDATED_PROFILE);

    await waitFor(() => {
      expect(screen.getByTestId("column-panel-0")).toBeInTheDocument();
    });
  });

  it("shows folder entries in the root column", async () => {
    await renderColumn(VALIDATED_PROFILE);

    await waitFor(() => {
      expect(
        screen
          .getByTestId("column-panel-0")
          .querySelector('[data-testid="col-entry-docs/"]'),
      ).toBeInTheDocument();
    });
  });
});

describe("ColumnView — clicking a folder appends a column", () => {
  it("clicking a folder in the root column calls onColumnPathChange with folder appended", async () => {
    const user = userEvent.setup();
    const { onColumnPathChange } = await renderColumn(VALIDATED_PROFILE);

    await waitFor(() => screen.getByTestId("column-panel-0"));

    const col0 = screen.getByTestId("column-panel-0");
    const docsEntry = col0.querySelector('[data-testid="col-entry-docs/"]');
    expect(docsEntry).toBeTruthy();

    await user.click(docsEntry!);

    expect(onColumnPathChange).toHaveBeenCalledWith([
      expect.objectContaining({ key: "docs/", isPrefix: true }),
    ]);
  });

  it("clicking a different folder in the root column truncates deeper columns", async () => {
    const user = userEvent.setup();
    const docsFolder: ObjectEntry = { key: "docs/", size: 0, isPrefix: true };
    const docsSubFolder: ObjectEntry = {
      key: "docs/sub/",
      size: 0,
      isPrefix: true,
    };

    // Start with columnPath = [docsFolder, docsSubFolder] → 3 columns.
    const { onColumnPathChange } = await renderColumn(VALIDATED_PROFILE, {
      columnPath: [docsFolder, docsSubFolder],
    });

    await waitFor(() => screen.getByTestId("column-panel-0"));

    // Click "src/" in column 0 — deeper columns should be truncated.
    const col0 = screen.getByTestId("column-panel-0");
    const srcEntry = col0.querySelector('[data-testid="col-entry-src/"]');
    expect(srcEntry).toBeTruthy();

    await user.click(srcEntry!);

    // colIndex = 0 → new path = [...slice(0,0), src/] = [src/]
    expect(onColumnPathChange).toHaveBeenCalledWith([
      expect.objectContaining({ key: "src/", isPrefix: true }),
    ]);
  });
});

describe("ColumnView — clicking a file", () => {
  it("clicking a file in the root column calls onOpen and truncates path", async () => {
    const user = userEvent.setup();
    const docsFolder: ObjectEntry = { key: "docs/", size: 0, isPrefix: true };

    const { onOpen, onColumnPathChange } = await renderColumn(
      VALIDATED_PROFILE,
      {
        columnPath: [docsFolder],
      },
    );

    await waitFor(() => screen.getByTestId("column-panel-0"));

    // Click "readme.md" in column 0.
    const col0 = screen.getByTestId("column-panel-0");
    const fileEntry = col0.querySelector('[data-testid="col-entry-readme.md"]');
    expect(fileEntry).toBeTruthy();

    await user.click(fileEntry!);

    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ key: "readme.md", isPrefix: false }),
    );
    // slice(0, 0) → [] (truncates deeper path)
    expect(onColumnPathChange).toHaveBeenCalledWith([]);
  });
});

describe("ColumnView — deeper column reset", () => {
  it("clicking in a parent column resets all deeper-column entries", async () => {
    const user = userEvent.setup();
    const docsFolder: ObjectEntry = { key: "docs/", size: 0, isPrefix: true };
    const docsSubFolder: ObjectEntry = {
      key: "docs/sub/",
      size: 0,
      isPrefix: true,
    };

    // columnPath = [docsFolder, docsSubFolder] → columns 0, 1, 2.
    const { onColumnPathChange } = await renderColumn(VALIDATED_PROFILE, {
      columnPath: [docsFolder, docsSubFolder],
    });

    await waitFor(() => screen.getByTestId("column-panel-0"));

    // Click "src/" in column 0 — resets path to [src/].
    const col0 = screen.getByTestId("column-panel-0");
    const srcEntry = col0.querySelector('[data-testid="col-entry-src/"]');
    expect(srcEntry).toBeTruthy();

    await user.click(srcEntry!);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const newPath: ObjectEntry[] = (onColumnPathChange as any).mock
      .calls[0][0] as ObjectEntry[];
    // Should be exactly one entry (src/), stripping docs/ and docs/sub/.
    expect(newPath).toHaveLength(1);
    expect(newPath[0]).toMatchObject({ key: "src/" });
  });
});

describe("ColumnView — validation gate", () => {
  it("shows gate message when profile is not validated", async () => {
    await renderColumn(UNVALIDATED_PROFILE);

    await waitFor(() => {
      expect(
        screen.getByText(/validate this profile to see contents/i),
      ).toBeInTheDocument();
    });
  });
});

describe("ColumnView — a11y", () => {
  it("has no axe accessibility violations", async () => {
    const { container } = await renderColumn(VALIDATED_PROFILE);

    await waitFor(() => screen.getByTestId("column-panel-0"));

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
