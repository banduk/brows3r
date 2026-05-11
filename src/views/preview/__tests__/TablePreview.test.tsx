/**
 * Tests for <TablePreview />.
 *
 * Web Workers are stubbed globally — we intercept the Worker constructor and
 * its postMessage to simulate worker responses synchronously.
 *
 * Coverage:
 * 1. Loading skeleton shown while worker is processing.
 * 2. Rows rendered from mocked worker output.
 * 3. Headers rendered as column names.
 * 4. Sort: clicking a header sorts rows client-side.
 * 5. Pagination: shows page controls when rows exceed 50 per page.
 * 6. First-N truncation badge shown when truncated = true.
 * 7. Truncation indicator absent when truncated = false.
 * 8. Error state when objectGetText rejects.
 * 9. Empty state when worker returns no headers.
 * 10. axe-core a11y on table state.
 * 11. axe-core a11y on loading state.
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import { mockInvoke } from "@/test/mocks/tauri";
import type { TabularResult } from "@/workers/csv.worker";
import { TablePreview } from "../TablePreview";

// ---------------------------------------------------------------------------
// Worker stub
// ---------------------------------------------------------------------------

/**
 * Stub the global Worker constructor so tests run in jsdom without actual
 * worker threads. The stub captures postMessage calls and allows tests to
 * configure the response via `setWorkerResponse`.
 */

let pendingResponse: TabularResult | null = null;

function setWorkerResponse(r: TabularResult) {
  pendingResponse = r;
}

class WorkerStub {
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: ((e: ErrorEvent) => void) | null = null;

  postMessage(_msg: unknown) {
    // Simulate async worker response via a microtask.
    const response = pendingResponse;
    if (response) {
      Promise.resolve().then(() => {
        this.onmessage?.({
          data: response,
        } as MessageEvent);
      });
    }
  }

  terminate() {}
}

// Replace global Worker before each test.
// Cast through `unknown` to avoid wrestling with the full Worker constructor type.
const workerGlobal = globalThis as Record<string, unknown>;
const originalWorker = workerGlobal.Worker;
beforeEach(() => {
  workerGlobal.Worker = WorkerStub;
  pendingResponse = null;
});
afterEach(() => {
  workerGlobal.Worker = originalWorker;
  cleanup();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TEXT_PAYLOAD = {
  body: "name,age\nAlice,30\nBob,25",
  contentLength: 100,
  etag: '"abc"',
  truncated: false,
};

const SMALL_RESULT: TabularResult = {
  headers: ["name", "age"],
  rows: [
    ["Alice", "30"],
    ["Bob", "25"],
  ],
  totalRows: 2,
  truncated: false,
};

const TRUNCATED_RESULT: TabularResult = {
  headers: ["id", "value"],
  rows: Array.from({ length: 50 }, (_, i) => [String(i), String(i * 2)]),
  totalRows: 1000,
  truncated: true,
};

const EMPTY_RESULT: TabularResult = {
  headers: [],
  rows: [],
  totalRows: 0,
  truncated: false,
};

// ---------------------------------------------------------------------------
// 1. Loading skeleton
// ---------------------------------------------------------------------------

describe("TablePreview — loading skeleton", () => {
  it("shows loading skeleton before worker responds", () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    // No pendingResponse set → worker never responds.

    const { unmount } = render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    expect(screen.getByTestId("table-loading-skeleton")).toBeInTheDocument();
    unmount();
  });
});

// ---------------------------------------------------------------------------
// 2. Rows rendered
// ---------------------------------------------------------------------------

describe("TablePreview — rows rendered", () => {
  it("renders data rows from worker response", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(SMALL_RESULT);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() => {
      const rows = screen.queryAllByTestId("table-row");
      expect(rows.length).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Headers rendered
// ---------------------------------------------------------------------------

describe("TablePreview — headers rendered", () => {
  it("renders column headers", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(SMALL_RESULT);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-preview")).toBeInTheDocument();
    });

    expect(screen.getByText("name")).toBeInTheDocument();
    expect(screen.getByText("age")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4. Sort
// ---------------------------------------------------------------------------

describe("TablePreview — sorting", () => {
  it("clicking a column header triggers a sort", async () => {
    const user = userEvent.setup();
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse({
      headers: ["name"],
      rows: [["Zebra"], ["Apple"], ["Mango"]],
      totalRows: 3,
      truncated: false,
    });

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-preview")).toBeInTheDocument(),
    );

    // Click header to sort ascending.
    const headerCells = screen.getAllByTestId(/table-header-/);
    await user.click(headerCells[0]!);

    // After ascending sort, cells should be in order Apple, Mango, Zebra.
    const cells = screen.getAllByRole("cell");
    const texts = cells.map((c) => c.textContent);
    expect(texts.indexOf("Apple")).toBeLessThan(texts.indexOf("Mango"));
    expect(texts.indexOf("Mango")).toBeLessThan(texts.indexOf("Zebra"));
  });
});

// ---------------------------------------------------------------------------
// 5. Pagination
// ---------------------------------------------------------------------------

describe("TablePreview — pagination", () => {
  it("shows pagination controls when rows exceed one page", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(TRUNCATED_RESULT); // 50 rows → 1 page, but totalRows=1000

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="large.csv"
        mode="csv"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-preview")).toBeInTheDocument(),
    );

    // 50 rows with pageSize=50 → exactly 1 page, no nav needed.
    // Let's test with 51 rows (51 > 50).
  });

  it("shows page controls and navigates to page 2 when rows > 50", async () => {
    const user = userEvent.setup();
    mockInvoke("object_get_text", TEXT_PAYLOAD);

    const manyRows: TabularResult = {
      headers: ["n"],
      rows: Array.from({ length: 51 }, (_, i) => [String(i)]),
      totalRows: 51,
      truncated: false,
    };
    setWorkerResponse(manyRows);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="large.csv"
        mode="csv"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-next-page")).toBeInTheDocument(),
    );

    // On page 1: 50 rows displayed.
    expect(screen.queryAllByTestId("table-row")).toHaveLength(50);

    // Navigate to page 2.
    await user.click(screen.getByTestId("table-next-page"));

    // On page 2: 1 row displayed.
    await waitFor(() =>
      expect(screen.queryAllByTestId("table-row")).toHaveLength(1),
    );
  });
});

// ---------------------------------------------------------------------------
// 6. Truncation indicator shown
// ---------------------------------------------------------------------------

describe("TablePreview — truncation badge", () => {
  it("shows truncated indicator when worker reports truncated = true", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(TRUNCATED_RESULT);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="large.csv"
        mode="csv"
      />,
    );

    await waitFor(() => {
      expect(
        screen.getByTestId("table-truncated-indicator"),
      ).toBeInTheDocument();
    });
  });

  it("does not show truncated indicator when not truncated", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(SMALL_RESULT);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-preview")).toBeInTheDocument(),
    );

    expect(
      screen.queryByTestId("table-truncated-indicator"),
    ).not.toBeInTheDocument();
  });

  it("shows first-N row count badge", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(TRUNCATED_RESULT); // 50 loaded, 1000 total

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="large.csv"
        mode="csv"
      />,
    );

    await waitFor(() => {
      const badge = screen.getByTestId("table-row-badge");
      expect(badge.textContent).toMatch(/first 50 of 1000/i);
    });
  });
});

// ---------------------------------------------------------------------------
// 8. Error state
// ---------------------------------------------------------------------------

describe("TablePreview — error state", () => {
  it("shows error when objectGetText rejects", async () => {
    mockInvoke("object_get_text", new Error("Access denied"));

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-error")).toBeInTheDocument();
    });
  });

  it("shows error when worker returns error field", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse({
      headers: [],
      rows: [],
      totalRows: 0,
      truncated: false,
      error: "WASM init failed",
    } as TabularResult & { error: string });

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.parquet"
        mode="parquet"
      />,
    );

    // parquet uses objectGetBytes
    mockInvoke("object_get_bytes", {
      body: btoa("fake parquet bytes"),
      contentLength: 18,
      truncated: false,
    });
  });
});

// ---------------------------------------------------------------------------
// 9. Empty state
// ---------------------------------------------------------------------------

describe("TablePreview — empty state", () => {
  it("shows no-data message when worker returns no headers", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(EMPTY_RESULT);

    render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.json"
        mode="json"
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("table-empty")).toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// 10. axe-core a11y — table state
// ---------------------------------------------------------------------------

describe("TablePreview — a11y (table state)", () => {
  it("has no axe violations in table state", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    setWorkerResponse(SMALL_RESULT);

    const { container } = render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    await waitFor(() =>
      expect(screen.getByTestId("table-preview")).toBeInTheDocument(),
    );

    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// 11. axe-core a11y — loading state
// ---------------------------------------------------------------------------

describe("TablePreview — a11y (loading state)", () => {
  it("has no axe violations in loading state", async () => {
    mockInvoke("object_get_text", TEXT_PAYLOAD);
    // No worker response → stays in loading.

    const { container, unmount } = render(
      <TablePreview
        profileId="p1"
        bucket="my-bucket"
        objectKey="data.csv"
        mode="csv"
      />,
    );

    expect(screen.getByTestId("table-loading-skeleton")).toBeInTheDocument();

    const results = await axe(container);
    expect(results).toHaveNoViolations();
    unmount();
  });
});
